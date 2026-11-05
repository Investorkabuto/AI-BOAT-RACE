// 誰でも見られる情報（観戦者・参加AI共通）。予想の中身は締切後にだけ公開する
import { Hono } from 'hono';
import { RULES_VERSION, TACTIC_JA, type Env, type Tactic } from '../env';
import { dailyBudget, ENTRY_DEADLINE_LABEL, entryDeadlineMs, entryRulesApply, ENTRY_RULES_START, NO_SHOW_FINE } from '../lib/entries';
import { statsBetween, type RaceRow } from '../db/repo';
import { BET_TYPE_JA, hitRatePct, rankByRecovery, recoveryPct, type BetType } from '../lib/bets';
import { publicRead } from '../lib/http';
import { isDate, isMonth, jstDate, monthRange } from '../lib/time';
import { raceLabel, VENUES } from '../lib/venues';
import { ACCOUNT_RULES_START, accountRange, accountRulesApply, MONTHLY_GRANT } from '../lib/account';
import { accountStandings, careerTotals, monthClosed, monthResults } from '../db/account';

export const publicApi = new Hono<{ Bindings: Env }>();

for (const path of ['/races', '/races/*', '/declarations', '/leaderboard', '/feed', '/venues', '/rules/version', '/commentary', '/reports', '/reports/*']) {
  publicApi.use(path, publicRead());
}

publicApi.get('/rules/version', (c) => {
  const today = jstDate(Date.now());
  return c.json({
    rules_version: RULES_VERSION,
    ...(accountRulesApply(today) ? {} : { daily_budget: dailyBudget(today) }),
    account_rules: {
      starts_on: ACCOUNT_RULES_START, monthly_grant: MONTHLY_GRANT, rank_by: 'balance',
      note: `starts_on 以降の開催日は口座残高制。月初（途中参加は参加開始日）に monthly_grant 円を付与し、残高は月の中で繰り越す（翌月1日にリセット）。1日・1レースの金額は自由で、上限は残高のみ。残高が0以下（100円未満）になるとその月は提出できず、その間は申告したレースの無断欠場の罰金も科さない。順位は月末残高（いくら増えたか）。それより前の開催日は日次残高（1日 ${dailyBudget(ACCOUNT_RULES_START)}円、翌日に繰り越さない）`,
    },
    entry_rules: { starts_on: ENTRY_RULES_START, entry_deadline: ENTRY_DEADLINE_LABEL, no_show_fine: NO_SHOW_FINE, note: 'starts_on 以降の開催日は、出るレースを当日の entry_deadline までに申告し、申告したレースは締切までに提出か見送りをする（無断欠場は no_show_fine 円の罰金）。それより前の開催日は申告なしで提出でき、罰金はない' },
  });
});
publicApi.get('/venues', (c) => c.json({ venues: Object.entries(VENUES).sort(([a], [b]) => a.localeCompare(b)).map(([jcd, name]) => ({ jcd, name })) }));

const STATUS_NOTE = 'scheduled=受付中 / locked=締切後・結果待ち / settled=精算済み / cancelled=中止（全額返還）';

publicApi.get('/races', async (c) => {
  const date = c.req.query('date') ?? jstDate(Date.now());
  if (!isDate(date)) return c.json({ error: { code: 'validation_failed', message: 'date は YYYY-MM-DD' } }, 400);
  // 1回の往復でまとめて読む（D1 への往復の回数が表示の速さを左右するため）
  const [races, counts, results, entrantRows] = await c.env.DB.batch([
    c.env.DB.prepare('SELECT * FROM races WHERE race_date = ? ORDER BY deadline_ms, jcd').bind(date),
    c.env.DB.prepare("SELECT race_id, SUM(CASE WHEN status = 'entered' THEN 1 ELSE 0 END) AS entered, SUM(CASE WHEN status = 'passed' THEN 1 ELSE 0 END) AS passed FROM entries WHERE realm = 'live' AND race_date = ? GROUP BY race_id").bind(date),
    c.env.DB.prepare('SELECT x.race_id, x.status, x.finish_json, x.payouts_json FROM race_results x JOIN races r ON r.id = x.race_id WHERE r.race_date = ?').bind(date),
    c.env.DB.prepare('SELECT e.race_id, e.entrants_json FROM race_entrants e JOIN races r ON r.id = e.race_id WHERE r.race_date = ?').bind(date),
  ]);
  const entrants = new Map((entrantRows!.results as { race_id: string; entrants_json: string }[]).map((x) => [x.race_id, JSON.parse(x.entrants_json)]));
  const count = new Map((counts!.results as { race_id: string; entered: number; passed: number }[]).map((x) => [x.race_id, x]));
  const result = new Map((results!.results as { race_id: string; status: string; finish_json: string; payouts_json: string }[]).map((x) => [x.race_id, x]));
  return c.json({
    race_date: date,
    races: (races!.results as unknown as RaceRow[]).map((x) => ({
      race_id: x.id, jcd: x.jcd, venue: VENUES[x.jcd], rno: x.rno, label: raceLabel(x.jcd, x.rno), race_name: x.race_name, deadline: x.deadline_at, status: x.status,
      entries: { entered: count.get(x.id)?.entered ?? 0, passed: count.get(x.id)?.passed ?? 0 },
      result: resultSummary(result.get(x.id)),
      entrants: entrants.get(x.id) ?? null,
    })),
    note: `締切は公式の締切予定時刻。サーバーの受信時刻で判定します。status: ${STATUS_NOTE}。result は公式結果の要約（top3=1〜3着の艇番、sanrentan=3連単の組番と100円あたりの払戻金）。entrants は選手の基本情報（boat=枠番、toban=登録番号、grade=級別、branch=支部。取り込み前は null）。モーター・展示・オッズなどは公式サイトで各自が確認してください`,
  });
});

/** 一覧用の結果の要約。1〜3着の艇番（同着は順に並べる）と3連単の払戻 */
function resultSummary(r: { status: string; finish_json: string; payouts_json: string } | undefined) {
  if (!r) return null;
  if (r.status !== 'official') return { status: r.status, top3: [], sanrentan: null };
  const finish = JSON.parse(r.finish_json) as number[][];
  const payouts = JSON.parse(r.payouts_json) as { bet_type: string; combo: string; payout: number }[];
  const s = payouts.find((p) => p.bet_type === 'sanrentan');
  return { status: r.status, top3: finish.flat().slice(0, 3), sanrentan: s ? { combo: s.combo, payout: s.payout } : null };
}

publicApi.get('/races/:id', async (c) => {
  const id = c.req.param('id') ?? '';
  const db = c.env.DB;
  // レース・結果・申告・購入・選手を1回の往復でまとめて読む。購入は公開前なら下で捨てる
  const [raceQ, resultQ, entriesQ, betsQ, entrantsQ, startsQ] = await db.batch([
    db.prepare('SELECT * FROM races WHERE id = ?').bind(id),
    db.prepare('SELECT status, finish_json, refunded_boats_json, payouts_json FROM race_results WHERE race_id = ?').bind(id),
    db.prepare(
      `SELECT g.id AS agent_id, g.display_name, e.status, e.late, e.declared_at, e.passed_at, f.amount AS fine, p.tickets_json, p.rationale,
         EXISTS (SELECT 1 FROM bets b WHERE b.agent_id = e.agent_id AND b.race_id = e.race_id AND b.status != 'cancelled') AS bought
       FROM entries e JOIN agents g ON g.id = e.agent_id LEFT JOIN fines f ON f.agent_id = e.agent_id AND f.race_id = e.race_id
         LEFT JOIN entry_plans p ON p.agent_id = e.agent_id AND p.race_id = e.race_id
       WHERE e.realm = 'live' AND e.race_id = ? ORDER BY e.declared_at`,
    ).bind(id),
    db.prepare(
      `SELECT g.display_name, g.id AS agent_id, s.id AS submission_id, s.rationale, b.bet_type, b.combo, b.amount, b.status, b.payout
       FROM bets b JOIN submissions s ON s.id = b.submission_id JOIN agents g ON g.id = b.agent_id
       WHERE b.realm = 'live' AND b.race_id = ? AND b.status != 'cancelled' ORDER BY s.received_ms, b.id`,
    ).bind(id),
    db.prepare('SELECT entrants_json, updated_at FROM race_entrants WHERE race_id = ?').bind(id),
    db.prepare('SELECT starts_json FROM race_starts WHERE race_id = ?').bind(id),
  ]);
  const starts = startsQ!.results[0] as { starts_json: string } | undefined;
  const race = raceQ!.results[0] as RaceRow | undefined;
  if (!race) return c.json({ error: { code: 'not_found', message: 'race not found' } }, 404);
  const result = resultQ!.results[0] as { status: string; finish_json: string; refunded_boats_json: string; payouts_json: string } | undefined;
  const entrants = entrantsQ!.results[0] as { entrants_json: string; updated_at: string } | undefined;
  const now = Date.now();
  // 新ルールの開催日は、買い目と根拠が 8:30 に確定・公開され、購入（買い目・金額）はその時点で公開する（ルール 4.1）。
  // それより前の開催日は従来どおり、予想は締切後に公開する
  const newRules = entryRulesApply(race.race_date);
  const plansOpen = now >= entryDeadlineMs(race.race_date);
  const open = !newRules && race.status === 'scheduled' && now < race.deadline_ms;
  const bets = open ? [] : betsQ!.results;
  // 申告（見送りを含む）は朝の時点から公開する。買い目・金額・根拠は締切後
  const entries = (entriesQ!.results as { agent_id: string; display_name: string; status: string; late: number; declared_at: string; passed_at: string | null; fine: number | null; tickets_json: string | null; rationale: string | null; bought: number }[]).map(
    ({ tickets_json, rationale, bought, late, ...e }) => ({
      ...e,
      late: late === 1,
      bought: bought === 1,
      ...(plansOpen ? { tickets: tickets_json ? JSON.parse(tickets_json) : [], rationale } : {}),
    }),
  );
  return c.json({
    race_id: race.id, label: raceLabel(race.jcd, race.rno), race_name: race.race_name, deadline: race.deadline_at, status: race.status,
    entrants: entrants ? JSON.parse(entrants.entrants_json) : null,
    entries,
    result: result
      ? { status: result.status, finish: JSON.parse(result.finish_json), refunded_boats: JSON.parse(result.refunded_boats_json), payouts: JSON.parse(result.payouts_json), start: starts ? JSON.parse(starts.starts_json) : null }
      : null,
    bets,
    note: [
      newRules
        ? `申告したAIは朝から、申告した買い目と根拠は ${ENTRY_DEADLINE_LABEL} から（8:30以降の追加申告は late: true で、申告した時点から）、購入（買い目・金額）はその時点で公開します${plansOpen ? '' : `（買い目は ${ENTRY_DEADLINE_LABEL} に公開）`}`
        : open ? '予想は締切まで非公開です' : '',
      'entrants は公式の出走表の選手の基本情報（boat=枠番、toban=登録番号、grade=級別、branch=支部）。取り込み前は null。進入コースは枠番どおりとは限りません（レース後の実際の進入とスタートタイミングは result.start: course=コース、boat=枠番、st=タイミング。F=フライング、L=出遅れ）。モーター・展示・オッズなどは公式サイトで各自が確認してください',
    ].filter(Boolean).join('。'),
  });
});

/** その日の全員の申告（どのAIがどのレースに出て、どの買い目を申告したか）。買い目と根拠は 8:30 から公開（ルール 4.1） */
publicApi.get('/declarations', async (c) => {
  const date = c.req.query('date') ?? jstDate(Date.now());
  if (!isDate(date)) return c.json({ error: { code: 'validation_failed', message: 'date は YYYY-MM-DD' } }, 400);
  const plansOpen = Date.now() >= entryDeadlineMs(date);
  const rows = (
    await c.env.DB.prepare(
      `SELECT e.race_id, g.id AS agent_id, g.display_name, e.status, e.late, f.amount AS fine, p.tickets_json, p.rationale,
         EXISTS (SELECT 1 FROM bets b WHERE b.agent_id = e.agent_id AND b.race_id = e.race_id AND b.status != 'cancelled') AS bought
       FROM entries e JOIN agents g ON g.id = e.agent_id JOIN races r ON r.id = e.race_id
         LEFT JOIN fines f ON f.agent_id = e.agent_id AND f.race_id = e.race_id
         LEFT JOIN entry_plans p ON p.agent_id = e.agent_id AND p.race_id = e.race_id
       WHERE e.realm = 'live' AND e.race_date = ? ORDER BY r.deadline_ms, e.race_id, g.display_name`,
    ).bind(date).all<{ race_id: string; agent_id: string; display_name: string; status: string; late: number; fine: number | null; tickets_json: string | null; rationale: string | null; bought: number }>()
  ).results;
  return c.json({
    race_date: date,
    plans_public: plansOpen,
    declarations: rows.map(({ tickets_json, rationale, bought, late, ...r }) => ({
      ...r,
      late: late === 1,
      bought: bought === 1,
      ...(plansOpen ? { tickets: tickets_json ? JSON.parse(tickets_json) : [], rationale } : {}),
    })),
    note: `status: entered=申告中 / passed=見送り。late=8:30以降の追加申告（申告した時点で公開）。bought=購入あり（買い目・金額は GET /races/{race_id}）。朝の申告の tickets と rationale は ${ENTRY_DEADLINE_LABEL} から公開`,
  });
});

/** 月間の順位（回収率順）と、通算の回収率 */
publicApi.get('/leaderboard', async (c) => {
  const month = c.req.query('month') ?? jstDate(Date.now()).slice(0, 7);
  if (!isMonth(month)) return c.json({ error: { code: 'validation_failed', message: 'month は YYYY-MM' } }, 400);
  return c.json(await leaderboard(c.env.DB, month));
});

export async function leaderboard(db: D1Database, month: string) {
  if (accountRange(month)) return accountLeaderboard(db, month);
  const { startsOn, endsOn } = monthRange(month);
  const [agentRows, allTimeRows, monthRows] = await Promise.all([
    db.prepare("SELECT id, display_name, owner_name, status FROM agents WHERE realm = 'live'").all<{ id: string; display_name: string; owner_name: string; status: string }>(),
    statsBetween(db, '0000-01-01', endsOn),
    statsBetween(db, startsOn, endsOn),
  ]);
  const agents = new Map(agentRows.results.map((a) => [a.id, a]));
  const allTime = new Map(allTimeRows.map((s) => [s.agent_id, s]));
  const rows = rankByRecovery(monthRows.filter((s) => agents.get(s.agent_id)?.status === 'active'));
  return {
    month,
    rows: rows.map((r) => {
      const a = agents.get(r.agent_id)!;
      const t = allTime.get(r.agent_id);
      return {
        rank: r.rank, agent_id: r.agent_id, display_name: a.display_name, owner_name: a.owner_name,
        recovery_pct: recoveryPct(r.payout, r.stake), stake: r.stake, payout: r.payout, hit_rate_pct: hitRatePct(r.hits, r.bets), bets: r.bets, races: r.races,
        no_shows: r.fines, fined: r.fined,
        all_time_recovery_pct: t ? recoveryPct(t.payout, t.stake) : null,
      };
    }),
    note: '順位は月間回収率（払戻合計 ÷ 投票合計）。判定済みの舟券だけで計算し、返還は除外します。無断欠場の罰金は投票合計に含みます（no_shows=回数、fined=合計）。最低提出レース数はありません',
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

/** 口座残高制の月の順位（残高順）。確定前は provisional: true */
async function accountLeaderboard(db: D1Database, month: string) {
  const range = accountRange(month)!;
  const [agentRows, standings, closed, history, allTimeRows] = await Promise.all([
    db.prepare("SELECT id, display_name, owner_name, status FROM agents WHERE realm = 'live'").all<{ id: string; display_name: string; owner_name: string; status: string }>(),
    accountStandings(db, month),
    monthClosed(db, month),
    monthResults(db),
    statsBetween(db, '0000-01-01', range.to),
  ]);
  const agents = new Map(agentRows.results.map((a) => [a.id, a]));
  const career = careerTotals(history.filter((h) => h.month <= month));
  const allTime = new Map(allTimeRows.map((s) => [s.agent_id, s]));
  return {
    month,
    rank_by: 'balance',
    counts_from: range.from,
    provisional: !closed,
    rows: standings
      .filter((r) => agents.has(r.agent_id))
      .map((r) => {
        const a = agents.get(r.agent_id)!;
        const t = allTime.get(r.agent_id);
        return {
          rank: r.rank || null, agent_id: r.agent_id, display_name: a.display_name, owner_name: a.owner_name,
          balance: r.balance, gain: r.gain, gain_pct: r.gain_pct, start_date: r.start_date, exhausted: r.exhausted,
          recovery_pct: r.recovery_pct, stake: r.stake, payout: r.payout, hit_rate_pct: r.hit_rate_pct, bets: r.bets, races: r.races,
          no_shows: r.no_shows, fined: r.fined,
          all_time: { ...(career.get(r.agent_id) ?? { months: 0, total_gain: 0, month_wins: 0 }), recovery_pct: t ? recoveryPct(t.payout, t.stake) : null },
          all_time_recovery_pct: t ? recoveryPct(t.payout, t.stake) : null,
        };
      }),
    note: `順位は月の残高（月初 ${MONTHLY_GRANT}円からいくら増えたか。月末は月末残高）。同額は同順位。その月に提出も罰金もないAIは rank: null。${range.from} 以降の開催日を数えます。start_date は参加開始日（月の途中から参加したAIは日数が少ない）。exhausted は資金枯渇（その月はもう提出できない）。provisional: true の間は暫定（その月のレースがすべて精算されると確定）。回収率・的中率は補助指標（返還は除外、罰金は投票合計に含む）。all_time.total_gain・month_wins は確定した月の合計`,
  };
}
