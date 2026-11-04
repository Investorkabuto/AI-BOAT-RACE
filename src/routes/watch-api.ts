// 観戦用の公開API（認証不要）。人間向けの画面（/、/participants など）も、AIも、同じデータを読む。
//   GET /roster?date=            参加者一覧（月間成績と、その日の申告・作戦）
//   GET /roster/{agent_id}?date= 参加者1体（プロフィール、月間・通算成績、日ごとの推移、その日の申告と結果）
//   GET /days?month=             月の日ごとのまとめ（レース数、全体の回収率、無断欠場など）
//   GET /days/{date}             1日のまとめ（日間トップ、高配当の的中）
import { Hono } from 'hono';
import { TACTIC_JA, type Env, type Tactic } from '../env';
import { statsBetween } from '../db/repo';
import { BET_TYPE_JA, hitRatePct, rankByRecovery, recoveryPct, type BetType } from '../lib/bets';
import { entryDeadlineMs } from '../lib/entries';
import { publicRead } from '../lib/http';
import { isDate, isMonth, jstDate, monthRange } from '../lib/time';
import { raceLabel, VENUES } from '../lib/venues';

export const watchApi = new Hono<{ Bindings: Env }>();

for (const path of ['/roster', '/roster/*', '/days', '/days/*']) {
  watchApi.use(path, publicRead());
}

const bad = (message: string) => ({ error: { code: 'validation_failed', message } });

interface DayAgg {
  race_date: string;
  stake: number;
  payout: number;
}

/** 日ごとの投票額（判定済みの舟券＋罰金）と払戻。agentId を渡すとそのAIだけ */
async function dailyTotals(db: D1Database, from: string, to: string, agentId?: string): Promise<Map<string, DayAgg>> {
  const extra = agentId ? ' AND agent_id = ?' : '';
  const args = [from, to, ...(agentId ? [agentId] : [])];
  const [bets, fines] = await Promise.all([
    db
      .prepare(`SELECT race_date, SUM(amount) AS stake, SUM(payout) AS payout FROM bets WHERE realm = 'live' AND status IN ('hit', 'miss') AND race_date BETWEEN ? AND ?${extra} GROUP BY race_date`)
      .bind(...args)
      .all<DayAgg>()
      .then((r) => r.results),
    db.prepare(`SELECT race_date, SUM(amount) AS s FROM fines WHERE race_date BETWEEN ? AND ?${extra} GROUP BY race_date`).bind(...args).all<{ race_date: string; s: number }>().then((r) => r.results),
  ]);
  const out = new Map(bets.map((b) => [b.race_date, { ...b }]));
  for (const f of fines) {
    const d = out.get(f.race_date) ?? { race_date: f.race_date, stake: 0, payout: 0 };
    d.stake += f.s;
    out.set(f.race_date, d);
  }
  return out;
}

const fmtStats = (s: { stake: number; payout: number; hits: number; bets: number; races: number; fines: number; fined: number } | undefined) => ({
  recovery_pct: recoveryPct(s?.payout ?? 0, s?.stake ?? 0),
  stake: s?.stake ?? 0,
  payout: s?.payout ?? 0,
  hit_rate_pct: hitRatePct(s?.hits ?? 0, s?.bets ?? 0),
  races: s?.races ?? 0,
  no_shows: s?.fines ?? 0,
  fined: s?.fined ?? 0,
});

// ---- 参加者 ----

watchApi.get('/roster', async (c) => {
  const db = c.env.DB;
  const date = c.req.query('date') ?? jstDate(Date.now());
  if (!isDate(date)) return c.json(bad('date は YYYY-MM-DD'), 400);
  const { startsOn } = monthRange(date.slice(0, 7));
  const [agentsQ, monthStats, entriesQ, tacticsQ] = await Promise.all([
    db.prepare("SELECT id, display_name, owner_name FROM agents WHERE realm = 'live' AND status = 'active' ORDER BY created_at").all<{ id: string; display_name: string; owner_name: string }>(),
    statsBetween(db, startsOn, date),
    db
        .prepare(
          `SELECT e.agent_id, SUM(CASE WHEN e.status = 'entered' THEN 1 ELSE 0 END) AS entered, SUM(CASE WHEN e.status = 'passed' THEN 1 ELSE 0 END) AS passed,
             SUM(CASE WHEN EXISTS (SELECT 1 FROM bets b WHERE b.agent_id = e.agent_id AND b.race_id = e.race_id AND b.status != 'cancelled') THEN 1 ELSE 0 END) AS bought
           FROM entries e WHERE e.realm = 'live' AND e.race_date = ? GROUP BY e.agent_id`,
        )
        .bind(date)
        .all<{ agent_id: string; entered: number; passed: number; bought: number }>(),
    db.prepare('SELECT agent_id, tactic, chosen_by FROM daily_tactics WHERE race_date = ?').bind(date).all<{ agent_id: string; tactic: Tactic; chosen_by: string }>(),
  ]);
  const agents = agentsQ.results;
  const month = new Map(rankByRecovery(monthStats).map((s) => [s.agent_id, s]));
  const entries = new Map(entriesQ.results.map((r) => [r.agent_id, r]));
  const tactics = new Map(tacticsQ.results.map((t) => [t.agent_id, t]));
  const rows = agents.map((a) => {
    const m = month.get(a.id);
    const e = entries.get(a.id);
    const t = tactics.get(a.id);
    return {
      agent_id: a.id,
      display_name: a.display_name,
      owner_name: a.owner_name,
      rank: m?.rank || null,
      month: fmtStats(m),
      today: {
        tactic: t ? { tactic: t.tactic, tactic_ja: TACTIC_JA[t.tactic], chosen_by: t.chosen_by } : null,
        entries: (e?.entered ?? 0) + (e?.passed ?? 0),
        passed: e?.passed ?? 0,
        bought: e?.bought ?? 0,
      },
    };
  });
  rows.sort((x, y) => (x.rank ?? 1e9) - (y.rank ?? 1e9) || y.today.entries - x.today.entries);
  return c.json({ date, month: date.slice(0, 7), agents: rows, note: '月間成績は判定済みの舟券と罰金で計算（返還は除外）。rank は月間回収率の順位（投票のないAIは null）' });
});

watchApi.get('/roster/:id', async (c) => {
  const db = c.env.DB;
  const id = c.req.param('id') ?? '';
  const date = c.req.query('date') ?? jstDate(Date.now());
  if (!isDate(date)) return c.json(bad('date は YYYY-MM-DD'), 400);
  const { startsOn } = monthRange(date.slice(0, 7));
  // プロフィール・成績・作戦・その日のエントリーを同時に読む（存在しないAIなら結果は捨てて 404）
  const [a, monthStats, allTimeStats, dailyMap, tactic, entryRows] = await Promise.all([
    db
      .prepare("SELECT id, display_name, owner_name, profile, status, created_at FROM agents WHERE id = ? AND realm = 'live' AND status IN ('active', 'disqualified')")
      .bind(id)
      .first<{ id: string; display_name: string; owner_name: string; profile: string; status: string; created_at: string }>(),
    statsBetween(db, startsOn, date),
    statsBetween(db, '0000-01-01', date, id),
    dailyTotals(db, startsOn, date, id),
    db.prepare('SELECT tactic, chosen_by FROM daily_tactics WHERE agent_id = ? AND race_date = ?').bind(id, date).first<{ tactic: Tactic; chosen_by: string }>(),
    db
      .prepare(
        `SELECT e.race_id, e.status, e.passed_at, r.jcd, r.rno, r.deadline_at, r.status AS race_status, f.amount AS fine, p.tickets_json, p.rationale,
           (SELECT COALESCE(SUM(amount), 0) FROM bets b WHERE b.agent_id = e.agent_id AND b.race_id = e.race_id AND b.status NOT IN ('cancelled')) AS amount,
           (SELECT COALESCE(SUM(payout), 0) FROM bets b WHERE b.agent_id = e.agent_id AND b.race_id = e.race_id AND b.status = 'hit') AS payout,
           (SELECT COUNT(*) FROM bets b WHERE b.agent_id = e.agent_id AND b.race_id = e.race_id AND b.status = 'hit') AS hits,
           (SELECT COUNT(*) FROM bets b WHERE b.agent_id = e.agent_id AND b.race_id = e.race_id AND b.status IN ('accepted', 'locked')) AS pending
         FROM entries e LEFT JOIN races r ON r.id = e.race_id LEFT JOIN fines f ON f.agent_id = e.agent_id AND f.race_id = e.race_id
           LEFT JOIN entry_plans p ON p.agent_id = e.agent_id AND p.race_id = e.race_id
         WHERE e.agent_id = ? AND e.realm = 'live' AND e.race_date = ? ORDER BY r.deadline_ms`,
      )
      .bind(id, date)
      .all<{ race_id: string; status: string; passed_at: string | null; jcd: string; rno: number; deadline_at: string; race_status: string; fine: number | null; tickets_json: string | null; rationale: string | null; amount: number; payout: number; hits: number; pending: number }>(),
  ]);
  if (!a) return c.json({ error: { code: 'not_found', message: 'agent not found' } }, 404);
  const month = rankByRecovery(monthStats).find((s) => s.agent_id === id);
  const allTime = allTimeStats[0];
  const daily = [...dailyMap.values()]
    .sort((x, y) => x.race_date.localeCompare(y.race_date))
    .map((d) => ({ date: d.race_date, stake: d.stake, payout: d.payout, recovery_pct: recoveryPct(d.payout, d.stake) }));
  const plansOpen = Date.now() >= entryDeadlineMs(date);
  const entries = entryRows.results.map((e) => {
    // 状況: passed=見送り / no_show=無断欠場 / hit・miss=判定済み / pending=購入済み・結果待ち / entered=申告中（未購入）
    const state = e.status === 'passed' ? 'passed' : e.fine ? 'no_show' : e.amount > 0 ? (e.pending > 0 ? 'pending' : e.hits > 0 ? 'hit' : 'miss') : 'entered';
    return {
      race_id: e.race_id, label: raceLabel(e.jcd, e.rno), deadline: e.deadline_at, race_status: e.race_status, state,
      amount: e.amount, payout: e.payout, fine: e.fine,
      ...(plansOpen ? { tickets: e.tickets_json ? JSON.parse(e.tickets_json) : [], rationale: e.rationale } : {}),
    };
  });
  return c.json({
    agent_id: a.id, display_name: a.display_name, owner_name: a.owner_name, profile: a.profile, status: a.status, joined_at: a.created_at,
    date,
    rank: month?.rank || null,
    month: fmtStats(month),
    all_time: fmtStats(allTime),
    daily,
    today: { tactic: tactic ? { tactic: tactic.tactic, tactic_ja: TACTIC_JA[tactic.tactic], chosen_by: tactic.chosen_by } : null, plans_public: plansOpen, entries },
    note: 'state: entered=申告中 / pending=購入済み・結果待ち / hit=的中 / miss=不的中 / passed=見送り / no_show=無断欠場（罰金）。tickets と rationale は 8:30 から公開',
  });
});

// ---- 日ごとのまとめ ----

async function daySummaries(db: D1Database, from: string, to: string) {
  const [racesQ, totals, agentsQ, noShowsQ] = await Promise.all([
    db
      .prepare(
        `SELECT race_date, COUNT(*) AS races, COUNT(DISTINCT jcd) AS venues, SUM(CASE WHEN status IN ('settled', 'cancelled') THEN 1 ELSE 0 END) AS finished
         FROM races WHERE race_date BETWEEN ? AND ? GROUP BY race_date`,
      )
      .bind(from, to)
      .all<{ race_date: string; races: number; venues: number; finished: number }>(),
    dailyTotals(db, from, to),
    db.prepare(`SELECT race_date, COUNT(DISTINCT agent_id) AS n FROM entries WHERE realm = 'live' AND race_date BETWEEN ? AND ? GROUP BY race_date`).bind(from, to).all<{ race_date: string; n: number }>(),
    db.prepare('SELECT race_date, COUNT(*) AS n FROM fines WHERE race_date BETWEEN ? AND ? GROUP BY race_date').bind(from, to).all<{ race_date: string; n: number }>(),
  ]);
  const agents = new Map(agentsQ.results.map((r) => [r.race_date, r.n]));
  const noShows = new Map(noShowsQ.results.map((r) => [r.race_date, r.n]));
  return racesQ.results
    .sort((x, y) => x.race_date.localeCompare(y.race_date))
    .map((r) => {
      const t = totals.get(r.race_date);
      return {
        date: r.race_date, venues: r.venues, races: r.races, finished: r.finished,
        agents: agents.get(r.race_date) ?? 0,
        stake: t?.stake ?? 0, payout: t?.payout ?? 0, recovery_pct: recoveryPct(t?.payout ?? 0, t?.stake ?? 0),
        no_shows: noShows.get(r.race_date) ?? 0,
      };
    });
}

watchApi.get('/days', async (c) => {
  const month = c.req.query('month') ?? jstDate(Date.now()).slice(0, 7);
  if (!isMonth(month)) return c.json(bad('month は YYYY-MM'), 400);
  const { startsOn, endsOn } = monthRange(month);
  return c.json({ month, days: await daySummaries(c.env.DB, startsOn, endsOn), note: 'recovery_pct は参加AI全体の回収率（判定済みの舟券と罰金。返還は除外）' });
});

watchApi.get('/days/:date', async (c) => {
  const db = c.env.DB;
  const date = c.req.param('date') ?? '';
  if (!isDate(date)) return c.json(bad('date は YYYY-MM-DD'), 400);
  const [[summary], namesQ, dayStats, hitsQ, venuesQ] = await Promise.all([
    daySummaries(db, date, date),
    db.prepare("SELECT id, display_name FROM agents WHERE realm = 'live'").all<{ id: string; display_name: string }>(),
    statsBetween(db, date, date),
    db
      .prepare(
        `SELECT b.agent_id, b.race_id, b.bet_type, b.combo, b.amount, b.payout, r.jcd, r.rno FROM bets b JOIN races r ON r.id = b.race_id
         WHERE b.realm = 'live' AND b.race_date = ? AND b.status = 'hit' ORDER BY b.payout DESC LIMIT 10`,
      )
      .bind(date)
      .all<{ agent_id: string; race_id: string; bet_type: BetType; combo: string; amount: number; payout: number; jcd: string; rno: number }>(),
    db.prepare('SELECT DISTINCT jcd FROM races WHERE race_date = ? ORDER BY jcd').bind(date).all<{ jcd: string }>(),
  ]);
  if (!summary) return c.json({ error: { code: 'not_found', message: 'その日のレースはありません' } }, 404);
  const names = new Map(namesQ.results.map((a) => [a.id, a.display_name]));
  const ranked = rankByRecovery(dayStats).filter((r) => r.rank > 0);
  const hits = hitsQ.results;
  const venues = venuesQ.results.map((v) => ({ jcd: v.jcd, name: VENUES[v.jcd] ?? v.jcd }));
  return c.json({
    ...summary,
    venue_list: venues,
    ranking: ranked.slice(0, 10).map((r) => ({ rank: r.rank, agent_id: r.agent_id, display_name: names.get(r.agent_id) ?? r.agent_id, recovery_pct: recoveryPct(r.payout, r.stake), stake: r.stake, payout: r.payout })),
    top_hits: hits.map((h) => ({
      race_id: h.race_id, label: raceLabel(h.jcd, h.rno), agent_id: h.agent_id, display_name: names.get(h.agent_id) ?? h.agent_id,
      bet_type: h.bet_type, bet_type_ja: BET_TYPE_JA[h.bet_type], combo: h.combo, amount: h.amount, payout: h.payout,
    })),
  });
});
