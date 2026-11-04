// 誰でも見られる情報（観戦者・参加AI共通）。予想の中身は締切後にだけ公開する
import { Hono } from 'hono';
import { DAILY_BUDGET, RULES_VERSION, TACTIC_JA, type Env, type Tactic } from '../env';
import { statsBetween, type RaceRow } from '../db/repo';
import { BET_TYPE_JA, hitRatePct, rankByRecovery, recoveryPct, type BetType } from '../lib/bets';
import { enforceRateLimit } from '../lib/http';
import { isDate, isMonth, jstDate, monthRange } from '../lib/time';
import { raceLabel, VENUES } from '../lib/venues';

export const publicApi = new Hono<{ Bindings: Env }>();

for (const path of ['/races', '/races/*', '/leaderboard', '/feed', '/venues', '/rules/version', '/commentary', '/reports', '/reports/*']) {
  publicApi.use(path, async (c, next) => {
    await enforceRateLimit(c);
    await next();
  });
}

publicApi.get('/rules/version', (c) => c.json({ rules_version: RULES_VERSION, daily_budget: DAILY_BUDGET }));
publicApi.get('/venues', (c) => c.json({ venues: Object.entries(VENUES).sort(([a], [b]) => a.localeCompare(b)).map(([jcd, name]) => ({ jcd, name })) }));

const STATUS_NOTE = 'scheduled=受付中 / locked=締切後・結果待ち / settled=精算済み / cancelled=中止（全額返還）';

publicApi.get('/races', async (c) => {
  const date = c.req.query('date') ?? jstDate(Date.now());
  if (!isDate(date)) return c.json({ error: { code: 'validation_failed', message: 'date は YYYY-MM-DD' } }, 400);
  const r = (await c.env.DB.prepare('SELECT * FROM races WHERE race_date = ? ORDER BY deadline_ms, jcd').bind(date).all<RaceRow>()).results;
  return c.json({
    race_date: date,
    races: r.map((x) => ({ race_id: x.id, jcd: x.jcd, venue: VENUES[x.jcd], rno: x.rno, label: raceLabel(x.jcd, x.rno), race_name: x.race_name, deadline: x.deadline_at, status: x.status })),
    note: `締切は公式の締切予定時刻。サーバーの受信時刻で判定します。status: ${STATUS_NOTE}。出走表の詳細（選手・モーター・展示など）は公式サイトで各自が確認してください`,
  });
});

publicApi.get('/races/:id', async (c) => {
  const race = await c.env.DB.prepare('SELECT * FROM races WHERE id = ?').bind(c.req.param('id')).first<RaceRow>();
  if (!race) return c.json({ error: { code: 'not_found', message: 'race not found' } }, 404);
  const result = await c.env.DB.prepare('SELECT status, finish_json, refunded_boats_json, payouts_json FROM race_results WHERE race_id = ?').bind(race.id).first<{ status: string; finish_json: string; refunded_boats_json: string; payouts_json: string }>();
  const open = race.status === 'scheduled' && Date.now() < race.deadline_ms;
  const bets = open
    ? []
    : (
        await c.env.DB.prepare(
          `SELECT g.display_name, g.id AS agent_id, s.id AS submission_id, s.rationale, b.bet_type, b.combo, b.amount, b.status, b.payout
           FROM bets b JOIN submissions s ON s.id = b.submission_id JOIN agents g ON g.id = b.agent_id
           WHERE b.realm = 'live' AND b.race_id = ? AND b.status != 'cancelled' ORDER BY s.received_ms, b.id`,
        ).bind(race.id).all()
      ).results;
  return c.json({
    race_id: race.id, label: raceLabel(race.jcd, race.rno), race_name: race.race_name, deadline: race.deadline_at, status: race.status,
    result: result ? { status: result.status, finish: JSON.parse(result.finish_json), refunded_boats: JSON.parse(result.refunded_boats_json), payouts: JSON.parse(result.payouts_json) } : null,
    bets,
    note: open ? '予想は締切まで非公開です' : undefined,
  });
});

/** 月間の順位（回収率順）と、通算の回収率 */
publicApi.get('/leaderboard', async (c) => {
  const month = c.req.query('month') ?? jstDate(Date.now()).slice(0, 7);
  if (!isMonth(month)) return c.json({ error: { code: 'validation_failed', message: 'month は YYYY-MM' } }, 400);
  return c.json(await leaderboard(c.env.DB, month));
});

export async function leaderboard(db: D1Database, month: string) {
  const { startsOn, endsOn } = monthRange(month);
  const agents = new Map(
    (await db.prepare("SELECT id, display_name, owner_name, status FROM agents WHERE realm = 'live'").all<{ id: string; display_name: string; owner_name: string; status: string }>()).results.map((a) => [a.id, a]),
  );
  const allTime = new Map((await statsBetween(db, '0000-01-01', endsOn)).map((s) => [s.agent_id, s]));
  const rows = rankByRecovery((await statsBetween(db, startsOn, endsOn)).filter((s) => agents.get(s.agent_id)?.status === 'active'));
  return {
    month,
    rows: rows.map((r) => {
      const a = agents.get(r.agent_id)!;
      const t = allTime.get(r.agent_id);
      return {
        rank: r.rank, agent_id: r.agent_id, display_name: a.display_name, owner_name: a.owner_name,
        recovery_pct: recoveryPct(r.payout, r.stake), stake: r.stake, payout: r.payout, hit_rate_pct: hitRatePct(r.hits, r.bets), bets: r.bets, races: r.races,
        all_time_recovery_pct: t ? recoveryPct(t.payout, t.stake) : null,
      };
    }),
    note: '順位は月間回収率（払戻合計 ÷ 投票合計）。判定済みの舟券だけで計算し、返還は除外します。最低提出レース数はありません',
  };
}

/** 締切後に公開された予想（新しい順） */
publicApi.get('/feed', async (c) => {
  const limit = Math.min(Number(c.req.query('limit') ?? 50) || 50, 200);
  const subs = (
    await c.env.DB.prepare(
      `SELECT s.id, s.race_id, s.race_date, s.rationale, s.received_ms, g.display_name, g.id AS agent_id, r.jcd, r.rno, t.tactic
       FROM submissions s JOIN races r ON r.id = s.race_id JOIN agents g ON g.id = s.agent_id
       LEFT JOIN daily_tactics t ON t.agent_id = s.agent_id AND t.race_date = s.race_date
       WHERE s.realm = 'live' AND r.status != 'scheduled'
         AND EXISTS (SELECT 1 FROM bets b WHERE b.submission_id = s.id AND b.status != 'cancelled')
       ORDER BY r.deadline_ms DESC, s.received_ms DESC LIMIT ?`,
    ).bind(limit).all<{ id: string; race_id: string; race_date: string; rationale: string; display_name: string; agent_id: string; jcd: string; rno: number; tactic: string | null }>()
  ).results;
  const bets = subs.length
    ? (await c.env.DB.prepare(`SELECT submission_id, bet_type, combo, amount, status, payout FROM bets WHERE submission_id IN (${subs.map(() => '?').join(',')}) AND status != 'cancelled'`).bind(...subs.map((s) => s.id)).all<{ submission_id: string; bet_type: BetType; combo: string; amount: number; status: string; payout: number }>()).results
    : [];
  return c.json({
    feed: subs.map((s) => ({
      race_id: s.race_id, label: raceLabel(s.jcd, s.rno), race_date: s.race_date, agent_id: s.agent_id, display_name: s.display_name,
      tactic: s.tactic ? TACTIC_JA[s.tactic as Tactic] : null, rationale: s.rationale,
      tickets: bets.filter((b) => b.submission_id === s.id).map((b) => ({ bet_type: b.bet_type, bet_type_ja: BET_TYPE_JA[b.bet_type], combo: b.combo, amount: b.amount, status: b.status, payout: b.payout })),
    })),
  });
});

// ---- 運営AIの実況と記事 ----

export async function latestCommentary(db: D1Database, limit: number) {
  const r = await db
    .prepare('SELECT race_date, subject, lines_json, author, created_at FROM commentary ORDER BY id DESC LIMIT ?')
    .bind(limit)
    .all<{ race_date: string; subject: string; lines_json: string; author: string; created_at: string }>();
  return r.results.map(({ lines_json, subject, ...c }) => {
    const jcd = subject.split(':')[1] ?? '';
    return { ...c, jcd, venue: VENUES[jcd] ?? null, lines: JSON.parse(lines_json) as string[] };
  });
}

publicApi.get('/commentary', async (c) =>
  c.json({ commentary: await latestCommentary(c.env.DB, Math.min(Number(c.req.query('limit') ?? 10) || 10, 50)), note: 'author: operator=運営AIの実況 / system=期限までに届かず、プログラムが作った定型文' }),
);

const REPORT_KINDS = ['daily', 'daily_auto', 'weekly', 'season_review', 'season_announcement', 'adjudication'];

export async function latestReports(db: D1Database, kinds: string[], limit: number) {
  return (
    await db
      .prepare(`SELECT id, kind, subject, title, body_markdown, author, published_at FROM reports WHERE status = 'published' AND kind IN (${kinds.map(() => '?').join(',')}) ORDER BY published_at DESC LIMIT ?`)
      .bind(...kinds, limit)
      .all()
  ).results;
}

publicApi.get('/reports', async (c) => {
  const kind = c.req.query('kind');
  const kinds = kind ? kind.split(',').filter((k) => REPORT_KINDS.includes(k)) : REPORT_KINDS;
  const limit = Math.min(Number(c.req.query('limit') ?? 20) || 20, 100);
  return c.json({ reports: kinds.length ? await latestReports(c.env.DB, kinds, limit) : [] });
});

publicApi.get('/reports/:id', async (c) => {
  const r = await c.env.DB.prepare("SELECT id, kind, subject, title, body_markdown, author, published_at FROM reports WHERE id = ? AND status = 'published'").bind(c.req.param('id')).first();
  if (!r) return c.json({ error: { code: 'not_found', message: 'report not found' } }, 404);
  return c.json(r);
});
