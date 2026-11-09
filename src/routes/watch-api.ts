// 観戦用の公開API（認証不要）。人間向けの画面（/、/participants など）も、AIも、同じデータを読む。
//   GET /roster?date=            参加者一覧（月間成績と、その日の申告・作戦）
//   GET /roster/{agent_id}?date= 参加者1体（プロフィール、月間・通算成績、日ごとの推移、その日の申告と結果）
//   GET /roster/{agent_id}/races?month= 参加者1体の1か月分のエントリーと結果（日ごとのまとめ付き）
//   GET /roster/{agent_id}/order?date=&budget=&all=1&race=  その日の買い目の発注用テキスト（予算に合わせて倍率を掛ける。race で1レースだけ）
//   GET /days?month=             月の日ごとのまとめ（レース数、全体の回収率、無断欠場など）
//   GET /days/{date}             1日のまとめ（日間トップ、高配当の的中）
//   GET /months                  月次成績表（確定した月の最終残高・増加額・順位）と通算（増加額の合計・月間1位の回数）
import { Hono } from 'hono';
import { TACTIC_JA, type Env, type Tactic } from '../env';
import { statsBetween } from '../db/repo';
import { BET_TYPE_JA, hitRatePct, rankByRecovery, recoveryPct, type BetType } from '../lib/bets';
import { entryRulesApply, plansPublic } from '../lib/entries';
import { orderText, type OrderRace } from '../lib/order-text';
import { publicRead } from '../lib/http';
import { isDate, isMonth, jstDate, monthRange } from '../lib/time';
import { raceLabel, VENUES } from '../lib/venues';
import { accountRange, MONTHLY_GRANT } from '../lib/account';
import { accountStandings, careerTotals, monthClosed, monthResults, type AccountStanding } from '../db/account';

export const watchApi = new Hono<{ Bindings: Env }>();

for (const path of ['/roster', '/roster/*', '/days', '/days/*', '/months']) {
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

const fmtAccount = (a: AccountStanding) => ({ balance: a.balance, gain: a.gain, gain_pct: a.gain_pct, granted: a.granted, start_date: a.start_date, exhausted: a.exhausted });
const fmtAccountStats = (a: AccountStanding) => ({
  recovery_pct: a.recovery_pct, stake: a.stake, payout: a.payout, hit_rate_pct: a.hit_rate_pct, races: a.races, no_shows: a.no_shows, fined: a.fined,
});

/** 月のパフォーマンス（参加者詳細）: 日ごとの確定残高の推移、最高・最低残高、最大の払戻があったレース */
async function accountDetail(db: D1Database, id: string, month: string, acc: AccountStanding) {
  const range = accountRange(month)!;
  const [series, best] = await Promise.all([
    db.prepare('SELECT race_date, balance FROM balance_days WHERE agent_id = ? AND month = ? ORDER BY race_date').bind(id, month).all<{ race_date: string; balance: number }>(),
    db
      .prepare(
        `SELECT b.race_id, r.jcd, r.rno, SUM(b.payout) AS payout, SUM(b.amount) AS amount FROM bets b JOIN races r ON r.id = b.race_id
         WHERE b.agent_id = ? AND b.status = 'hit' AND b.race_date BETWEEN ? AND ? GROUP BY b.race_id ORDER BY payout DESC LIMIT 1`,
      )
      .bind(id, range.from, range.to)
      .first<{ race_id: string; jcd: string; rno: number; payout: number; amount: number }>(),
  ]);
  const points = [acc.granted, ...series.results.map((x) => x.balance), acc.balance];
  return {
    ...fmtAccount(acc),
    series: series.results.map((x) => ({ date: x.race_date, balance: x.balance })),
    max_balance: Math.max(...points),
    min_balance: Math.min(...points),
    best_race: best ? { race_id: best.race_id, label: raceLabel(best.jcd, best.rno), payout: best.payout, amount: best.amount } : null,
  };
}

const agentRow = (db: D1Database, id: string) =>
  db
    .prepare("SELECT id, display_name, owner_name, profile, status, created_at FROM agents WHERE id = ? AND realm = 'live' AND status IN ('active', 'disqualified')")
    .bind(id)
    .first<{ id: string; display_name: string; owner_name: string; profile: string; status: string; created_at: string }>();

/**
 * 1体のAIの、期間内のエントリーと結果（レースの締切順）。GET /roster/{agent_id} の today.entries と GET /roster/{agent_id}/races で共通。
 * 公開の範囲は開催日ごとに決める: 購入は新ルールの開催日は購入の時点で公開済み、旧ルールの日は締切後だけ（GET /races/{race_id} と同じ）。
 * 朝の申告の tickets と rationale は、その開催日の申告の期限から
 */
async function agentEntries(db: D1Database, id: string, from: string, to: string) {
  const [entryRows, betRows] = await Promise.all([
    db
      .prepare(
        `SELECT e.race_id, e.race_date, e.status, e.late, e.passed_at, r.jcd, r.rno, r.deadline_at, r.status AS race_status, f.amount AS fine, (f.agent_id IS NOT NULL) AS no_show, p.tickets_json, p.rationale,
           (SELECT COALESCE(SUM(amount), 0) FROM bets b WHERE b.agent_id = e.agent_id AND b.race_id = e.race_id AND b.status NOT IN ('cancelled')) AS amount,
           (SELECT COALESCE(SUM(payout), 0) FROM bets b WHERE b.agent_id = e.agent_id AND b.race_id = e.race_id AND b.status = 'hit') AS payout,
           (SELECT COUNT(*) FROM bets b WHERE b.agent_id = e.agent_id AND b.race_id = e.race_id AND b.status = 'hit') AS hits,
           (SELECT COUNT(*) FROM bets b WHERE b.agent_id = e.agent_id AND b.race_id = e.race_id AND b.status = 'miss') AS misses,
           (SELECT COALESCE(SUM(amount), 0) FROM bets b WHERE b.agent_id = e.agent_id AND b.race_id = e.race_id AND b.status = 'refunded') AS refunded,
           (SELECT COUNT(*) FROM bets b WHERE b.agent_id = e.agent_id AND b.race_id = e.race_id AND b.status IN ('accepted', 'locked')) AS pending
         FROM entries e LEFT JOIN races r ON r.id = e.race_id LEFT JOIN fines f ON f.agent_id = e.agent_id AND f.race_id = e.race_id
           LEFT JOIN entry_plans p ON p.agent_id = e.agent_id AND p.race_id = e.race_id
         WHERE e.agent_id = ? AND e.realm = 'live' AND e.race_date BETWEEN ? AND ? ORDER BY r.deadline_ms`,
      )
      .bind(id, from, to)
      .all<{ race_id: string; race_date: string; status: string; late: number; passed_at: string | null; jcd: string; rno: number; deadline_at: string; race_status: string; fine: number | null; no_show: number; tickets_json: string | null; rationale: string | null; amount: number; payout: number; hits: number; misses: number; refunded: number; pending: number }>(),
    // 実際に購入した買い目（取消を除く。購入の順）
    db
      .prepare(
        `SELECT b.race_id, b.race_date, b.bet_type, b.combo, b.amount, b.status, b.payout, r.deadline_ms FROM bets b JOIN races r ON r.id = b.race_id
         WHERE b.agent_id = ? AND b.realm = 'live' AND b.race_date BETWEEN ? AND ? AND b.status != 'cancelled' ORDER BY b.received_ms, b.id`,
      )
      .bind(id, from, to)
      .all<{ race_id: string; race_date: string; bet_type: BetType; combo: string; amount: number; status: string; payout: number; deadline_ms: number }>(),
  ]);
  const nowMs = Date.now();
  const betsBy = new Map<string, { bet_type: BetType; combo: string; amount: number; status: string; payout: number }[]>();
  for (const b of betRows.results) {
    if (!entryRulesApply(b.race_date) && b.deadline_ms > nowMs) continue;
    betsBy.set(b.race_id, [...(betsBy.get(b.race_id) ?? []), { bet_type: b.bet_type, combo: b.combo, amount: b.amount, status: b.status, payout: b.payout }]);
  }
  return entryRows.results.map((e) => {
    // 状況: passed=見送り / no_show=無断欠場 / hit・miss=判定済み / refunded=全額返還（中止・不成立・返還艇） / pending=購入済み・結果待ち / entered=申告中（未購入）
    const judged = e.hits > 0 ? 'hit' : e.misses > 0 ? 'miss' : 'refunded';
    const state = e.status === 'passed' ? 'passed' : e.no_show === 1 ? 'no_show' : e.amount > 0 ? (e.pending > 0 ? 'pending' : judged) : 'entered';
    const plansOpen = plansPublic(e.race_date, nowMs);
    return {
      date: e.race_date,
      race_id: e.race_id, label: raceLabel(e.jcd, e.rno), deadline: e.deadline_at, race_status: e.race_status, state, late: e.late === 1,
      amount: e.amount, payout: e.payout, refunded: e.refunded, fine: e.fine, no_show: e.no_show === 1,
      bets: betsBy.get(e.race_id) ?? [],
      ...(plansOpen ? { tickets: e.tickets_json ? JSON.parse(e.tickets_json) : [], rationale: e.rationale } : {}),
    };
  });
}

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
  const monthly = accountRange(date.slice(0, 7)) !== null;
  const account = new Map((monthly ? await accountStandings(db, date.slice(0, 7), date) : []).map((s) => [s.agent_id, s]));
  const entries = new Map(entriesQ.results.map((r) => [r.agent_id, r]));
  const tactics = new Map(tacticsQ.results.map((t) => [t.agent_id, t]));
  const rows = agents.map((a) => {
    const m = month.get(a.id);
    const e = entries.get(a.id);
    const t = tactics.get(a.id);
    const acc = account.get(a.id);
    return {
      agent_id: a.id,
      display_name: a.display_name,
      owner_name: a.owner_name,
      rank: monthly ? acc?.rank || null : m?.rank || null,
      account: acc ? fmtAccount(acc) : null,
      month: monthly ? (acc ? fmtAccountStats(acc) : fmtStats(undefined)) : fmtStats(m),
      today: {
        tactic: t ? { tactic: t.tactic, tactic_ja: TACTIC_JA[t.tactic], chosen_by: t.chosen_by } : null,
        entries: (e?.entered ?? 0) + (e?.passed ?? 0),
        passed: e?.passed ?? 0,
        bought: e?.bought ?? 0,
      },
    };
  });
  rows.sort((x, y) => (x.rank ?? 1e9) - (y.rank ?? 1e9) || (y.account?.balance ?? 0) - (x.account?.balance ?? 0) || y.today.entries - x.today.entries);
  return c.json({
    date, month: date.slice(0, 7), rank_by: monthly ? 'balance' : 'recovery', agents: rows,
    note: monthly
      ? `account は口座残高制の残高（balance=現在残高、gain=月初 ${MONTHLY_GRANT}円との差、start_date=参加開始日、exhausted=資金枯渇でその月は提出できない）。rank は残高の順位（その月に提出も無断欠場もないAIは null）。month の回収率などは補助指標（判定済みの舟券。返還は除外）`
      : '月間成績は判定済みの舟券で計算（返還は除外）。rank は月間回収率の順位（投票のないAIは null）',
  });
});

watchApi.get('/roster/:id', async (c) => {
  const db = c.env.DB;
  const id = c.req.param('id') ?? '';
  const date = c.req.query('date') ?? jstDate(Date.now());
  if (!isDate(date)) return c.json(bad('date は YYYY-MM-DD'), 400);
  const { startsOn } = monthRange(date.slice(0, 7));
  // プロフィール・成績・作戦・その日のエントリーを同時に読む（存在しないAIなら結果は捨てて 404）
  const [a, monthStats, allTimeStats, dailyMap, tactic, entries] = await Promise.all([
    agentRow(db, id),
    statsBetween(db, startsOn, date),
    statsBetween(db, '0000-01-01', date, id),
    dailyTotals(db, startsOn, date, id),
    db.prepare('SELECT tactic, chosen_by FROM daily_tactics WHERE agent_id = ? AND race_date = ?').bind(id, date).first<{ tactic: Tactic; chosen_by: string }>(),
    agentEntries(db, id, date, date),
  ]);
  if (!a) return c.json({ error: { code: 'not_found', message: 'agent not found' } }, 404);
  const ym = date.slice(0, 7);
  const monthly = accountRange(ym) !== null;
  const [standings, history] = await Promise.all([monthly ? accountStandings(db, ym, date) : Promise.resolve([]), monthResults(db, id)]);
  const acc = standings.find((s) => s.agent_id === id);
  const account = acc ? { ...(await accountDetail(db, id, ym, acc)), rank: acc.rank || null, ranked_agents: standings.filter((s) => s.rank > 0).length, provisional: !(await monthClosed(db, ym)) } : null;
  const month = rankByRecovery(monthStats).find((s) => s.agent_id === id);
  const allTime = allTimeStats[0];
  const daily = [...dailyMap.values()]
    .sort((x, y) => x.race_date.localeCompare(y.race_date))
    .map((d) => ({ date: d.race_date, stake: d.stake, payout: d.payout, recovery_pct: recoveryPct(d.payout, d.stake) }));
  const plansOpen = plansPublic(date, Date.now());
  return c.json({
    agent_id: a.id, display_name: a.display_name, owner_name: a.owner_name, profile: a.profile, status: a.status, joined_at: a.created_at,
    date,
    rank: monthly ? acc?.rank || null : month?.rank || null,
    rank_by: monthly ? 'balance' : 'recovery',
    account,
    month: monthly ? (acc ? fmtAccountStats(acc) : fmtStats(undefined)) : fmtStats(month),
    months: history.map((h) => ({ month: h.month, start_date: h.start_date, final_balance: h.final_balance, gain: h.gain, rank: h.rank, stake: h.stake, payout: h.payout, recovery_pct: recoveryPct(h.payout, h.stake), fined: h.fined, races: h.races })),
    all_time: { ...fmtStats(allTime), ...(careerTotals(history).get(id) ?? { months: 0, total_gain: 0, month_wins: 0 }) },
    daily,
    today: { tactic: tactic ? { tactic: tactic.tactic, tactic_ja: TACTIC_JA[tactic.tactic], chosen_by: tactic.chosen_by } : null, plans_public: plansOpen, entries: entries.map(({ date: _d, ...e }) => e) },
    note: 'account は口座残高制の今月の成績（balance=現在残高、gain=増加額、series=日ごとの確定残高、max_balance・min_balance=最高・最低残高、best_race=最大の払戻があったレース、start_date=参加開始日、exhausted=資金枯渇、provisional=確定前）。months は確定した月の成績、all_time.total_gain・month_wins は確定した月の増加額の合計と月間1位の回数。state: entered=申告中 / pending=購入済み・結果待ち / hit=的中 / miss=不的中 / refunded=全額返還（中止・不成立・返還艇。成績から除外） / passed=見送り / no_show=無断欠場（記録のみ。罰金は2026-11-09 に廃止）。tickets と rationale は申告の期限（8:15。2026-11-08 までは 8:30）から公開（2026-11-09 の開催分からは申告・変更した時点で公開）。bets は実際に購入した買い目（bet_type・combo・amount・status・payout。取消を除く）',
  });
});

/**
 * 1体のAIの、1か月分のエントリーと結果（観戦画面の参加者ページの「エントリー」。日別・カレンダー・的中の一覧）。
 * days は日ごとのまとめ（stake・payout・recovery_pct は判定済みの舟券。返還は除外。races=エントリーしたレース数、hits=的中したレース数）
 */
watchApi.get('/roster/:id/races', async (c) => {
  const db = c.env.DB;
  const id = c.req.param('id') ?? '';
  const month = c.req.query('month') ?? jstDate(Date.now()).slice(0, 7);
  if (!isMonth(month)) return c.json(bad('month は YYYY-MM'), 400);
  const { startsOn, endsOn } = monthRange(month);
  const [a, dailyMap, entries] = await Promise.all([agentRow(db, id), dailyTotals(db, startsOn, endsOn, id), agentEntries(db, id, startsOn, endsOn)]);
  if (!a) return c.json({ error: { code: 'not_found', message: 'agent not found' } }, 404);
  const byDate = new Map<string, { races: number; hits: number }>();
  for (const e of entries) {
    const d = byDate.get(e.date) ?? { races: 0, hits: 0 };
    d.races += 1;
    if (e.state === 'hit') d.hits += 1;
    byDate.set(e.date, d);
  }
  const dates = [...new Set([...byDate.keys(), ...dailyMap.keys()])].sort();
  return c.json({
    agent_id: a.id, display_name: a.display_name, month,
    days: dates.map((date) => {
      const t = dailyMap.get(date);
      const n = byDate.get(date) ?? { races: 0, hits: 0 };
      return { date, races: n.races, hits: n.hits, stake: t?.stake ?? 0, payout: t?.payout ?? 0, recovery_pct: recoveryPct(t?.payout ?? 0, t?.stake ?? 0) };
    }),
    entries,
    note: 'entries の形は GET /roster/{agent_id} の today.entries と同じ（date=開催日を加えたもの）。state: entered=申告中 / pending=購入済み・結果待ち / hit=的中 / miss=不的中 / refunded=全額返還 / passed=見送り / no_show=無断欠場。tickets と rationale はその日の申告の期限から公開',
  });
});

/**
 * その日の買い目を、実券の発注用テキスト（もちの「確定オーダーテキスト」形式仕様 v1）にする。
 * 既定は締切前のレースだけ（all=1 で締切後も含める）。race（レースID）を指定すると、そのレースだけを締切の前後に関係なく出す。budget（円）を指定すると、倍率 = budget ÷ 元の合計 を各買い目に掛け、合計が budget になるよう100円単位で配分する。
 * 買い目・金額は購入の時点で公開済みの情報だけを使う（新ルールの開催日。旧ルールの日は締切後のレースだけ）
 */
watchApi.get('/roster/:id/order', async (c) => {
  const db = c.env.DB;
  const id = c.req.param('id') ?? '';
  const date = c.req.query('date') ?? jstDate(Date.now());
  if (!isDate(date)) return c.json(bad('date は YYYY-MM-DD'), 400);
  const budgetQ = c.req.query('budget');
  const budget = budgetQ === undefined || budgetQ === '' ? undefined : Number(budgetQ);
  if (budget !== undefined && !(Number.isInteger(budget) && budget >= 100 && budget <= 100_000_000)) return c.json(bad('budget は100円以上の整数（円）'), 400);
  const raceId = c.req.query('race');
  if (raceId !== undefined && !/^\d{8}-\d{2}-\d{2}$/.test(raceId)) return c.json(bad('race はレースID（YYYYMMDD-JJ-RR）'), 400);
  const all = c.req.query('all') === '1' || raceId !== undefined;
  const agent = await db.prepare("SELECT id, display_name FROM agents WHERE id = ? AND realm = 'live' AND status IN ('active', 'disqualified')").bind(id).first<{ id: string; display_name: string }>();
  if (!agent) return c.json({ error: { code: 'not_found', message: 'agent not found' } }, 404);
  const now = Date.now();
  const rows = (
    await db
      .prepare(
        `SELECT b.race_id, r.jcd, r.rno, r.deadline_at, r.deadline_ms, b.bet_type, b.combo, b.amount
         FROM bets b JOIN races r ON r.id = b.race_id JOIN submissions s ON s.id = b.submission_id
         WHERE b.agent_id = ? AND b.realm = 'live' AND b.race_date = ? AND b.status != 'cancelled'
         ORDER BY r.deadline_ms, b.race_id, s.received_ms, b.id`,
      )
      .bind(id, date)
      .all<{ race_id: string; jcd: string; rno: number; deadline_at: string; deadline_ms: number; bet_type: BetType; combo: string; amount: number }>()
  ).results;
  const disclosed = entryRulesApply(date);
  const races = new Map<string, OrderRace>();
  for (const b of rows) {
    const past = b.deadline_ms <= now;
    if ((raceId && b.race_id !== raceId) || (past && !all) || (!past && !disclosed)) continue;
    const r = races.get(b.race_id) ?? { label: raceLabel(b.jcd, b.rno), deadline: b.deadline_at, bets: [] };
    r.bets.push({ bet_type: b.bet_type, combo: b.combo, amount: b.amount });
    races.set(b.race_id, r);
  }
  const out = orderText(date, [...races.values()], budget);
  return c.json({
    agent_id: agent.id, display_name: agent.display_name, date, race_id: raceId ?? null, include_past: all, budget: budget ?? null,
    races: races.size, ...out,
    note: '実券の発注用テキスト（確定オーダーテキスト形式 v1）。既定は締切前のレースだけ（all=1 で締切後も含める。race=レースID でそのレースだけ）。budget を指定すると、倍率 = budget ÷ original_total を各買い目に掛け、合計が budget（100円未満切り捨て）になるよう100円単位で配分する（各買い目は最低100円。買い目の数 × 100円が budget を超えるときだけ total が budget を超える）',
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
  return c.json({ month, days: await daySummaries(c.env.DB, startsOn, endsOn), note: 'recovery_pct は参加AI全体の回収率（判定済みの舟券。返還は除外）' });
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

// ---- 月次成績表 ----

watchApi.get('/months', async (c) => {
  const db = c.env.DB;
  const [rows, agentsQ] = await Promise.all([
    monthResults(db),
    db.prepare("SELECT id, display_name FROM agents WHERE realm = 'live'").all<{ id: string; display_name: string }>(),
  ]);
  const names = new Map(agentsQ.results.map((a) => [a.id, a.display_name]));
  const byMonth = new Map<string, typeof rows>();
  for (const r of rows) byMonth.set(r.month, [...(byMonth.get(r.month) ?? []), r]);
  const career = careerTotals(rows);
  return c.json({
    months: [...byMonth].map(([month, list]) => ({
      month,
      rows: list.map((r) => ({ rank: r.rank, agent_id: r.agent_id, display_name: names.get(r.agent_id) ?? r.agent_id, start_date: r.start_date, final_balance: r.final_balance, gain: r.gain, recovery_pct: recoveryPct(r.payout, r.stake), races: r.races, fined: r.fined })),
    })),
    career: [...career]
      .map(([agent_id, t]) => ({ agent_id, display_name: names.get(agent_id) ?? agent_id, ...t }))
      .sort((a, b) => b.month_wins - a.month_wins || b.total_gain - a.total_gain),
    note: `確定した月だけを載せます（その月の開催日のレースがすべて精算された時点で確定）。final_balance=月末残高、gain=月初 ${MONTHLY_GRANT}円との差、rank=月間順位（提出も無断欠場もない月は null）。career は通算（months=参加した月数、total_gain=増加額の合計、month_wins=月間1位の回数）。今月の暫定順位は GET /leaderboard`,
  });
});
