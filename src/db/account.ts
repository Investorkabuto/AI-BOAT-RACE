// 口座残高制（要件定義 v0.8）の読み書き: 月の付与、月の残高、順位、日ごとの確定残高、月次成績の確定
import { accountRange, accountRulesApply, gainPct, grantStartDate, isExhausted, monthBalance, MONTHLY_GRANT, rankByBalance, type AccountRow } from '../lib/account';
import { hitRatePct, recoveryPct } from '../lib/bets';
import { jstDate, jstIso } from '../lib/time';
import { balanceOfDay, statsBetween } from './repo';

export interface GrantRow {
  agent_id: string;
  month: string;
  amount: number;
  start_date: string;
  granted_at: string;
}

/** 付与のイベント。直前の INSERT OR IGNORE で行が入ったときだけ積む（同じ batch の中で changes() を見る） */
function grantStatements(db: D1Database, agentId: string, month: string, startDate: string, nowMs: number): D1PreparedStatement[] {
  const payload = {
    month,
    amount: MONTHLY_GRANT,
    balance: MONTHLY_GRANT,
    start_date: startDate,
    note: `${month} の残高 ${MONTHLY_GRANT.toLocaleString('ja-JP')}円を付与しました（口座残高制）。残高は月末まで繰り越し、1日・1レースの金額は自由です（上限は残高のみ）。順位は月末残高で決まります。残高が0以下になると、その月はもう提出できません（追加入金はありません）。翌月1日に新しい月の ${MONTHLY_GRANT.toLocaleString('ja-JP')}円にリセットされます`,
  };
  return [
    db.prepare('INSERT OR IGNORE INTO account_grants (agent_id, month, amount, start_date, granted_at) VALUES (?, ?, ?, ?, ?)').bind(agentId, month, MONTHLY_GRANT, startDate, jstIso(nowMs)),
    db.prepare('INSERT INTO events (agent_id, type, payload, created_at) SELECT ?, ?, ?, ? WHERE changes() = 1').bind(agentId, 'account.granted', JSON.stringify(payload), jstIso(nowMs)),
  ];
}

/** 付与できる月か（今月で、口座残高制の範囲に入る月） */
function grantableMonth(month: string, nowMs: number): boolean {
  return month === jstDate(nowMs).slice(0, 7) && accountRange(month) !== null;
}

/** 参加中（active）のAIに、その月の付与がまだなら付与する（途中参加・承認直後の取りこぼしを、提出や照会の時点で補う） */
export async function ensureGrant(db: D1Database, agent: { id: string; status: string }, month: string, nowMs: number): Promise<void> {
  if (agent.status !== 'active' || !grantableMonth(month, nowMs)) return;
  const has = await db.prepare('SELECT 1 FROM account_grants WHERE agent_id = ? AND month = ?').bind(agent.id, month).first();
  if (has) return;
  await db.batch(grantStatements(db, agent.id, month, grantStartDate(month, jstDate(nowMs)), nowMs));
}

/** 今月の付与がまだの参加中のAI（本番・サンドボックス）全員に付与する。定時処理から呼ぶ（月初の0時台と、承認直後） */
export async function grantCurrentMonth(db: D1Database, nowMs: number): Promise<string[]> {
  const month = jstDate(nowMs).slice(0, 7);
  if (!grantableMonth(month, nowMs)) return [];
  const missing = (
    await db
      .prepare("SELECT id FROM agents WHERE status = 'active' AND id NOT IN (SELECT agent_id FROM account_grants WHERE month = ?)")
      .bind(month)
      .all<{ id: string }>()
  ).results;
  if (!missing.length) return [];
  const start = grantStartDate(month, jstDate(nowMs));
  await db.batch(missing.flatMap((a) => grantStatements(db, a.id, month, start, nowMs)));
  return [`account granted ${month}: ${missing.length} agents`];
}

export async function getGrant(db: D1Database, agentId: string, month: string): Promise<GrantRow | null> {
  return db.prepare('SELECT * FROM account_grants WHERE agent_id = ? AND month = ?').bind(agentId, month).first<GrantRow>();
}

/** その月の残高（upTo を渡すと、その開催日までの分だけ）。付与がなければ null */
export async function accountBalance(db: D1Database, agentId: string, month: string, upTo?: string) {
  const range = accountRange(month);
  const grant = await getGrant(db, agentId, month);
  if (!range || !grant) return null;
  const to = upTo && upTo < range.to ? upTo : range.to;
  const [rows, fined] = await Promise.all([
    db.prepare('SELECT status, amount, payout FROM bets WHERE agent_id = ? AND race_date BETWEEN ? AND ?').bind(agentId, range.from, to).all<AccountRow>(),
    db.prepare('SELECT COALESCE(SUM(amount), 0) AS s FROM fines WHERE agent_id = ? AND race_date BETWEEN ? AND ?').bind(agentId, range.from, to).first<{ s: number }>(),
  ]);
  return { month, start_date: grant.start_date, ...monthBalance(grant.amount, rows.results, fined?.s ?? 0) };
}

export type Budget =
  | { rule: 'monthly'; month: string; start_date: string | null; granted: number; staked: number; credited: number; fined: number; balance: number; gain: number; gain_pct: number | null; exhausted: boolean }
  | { rule: 'daily'; date: string; start: number; staked: number; credited: number; fined: number; balance: number; exhausted: boolean };

/**
 * その開催日の提出に使える残高。2026-11-06 以降は月の残高（口座残高制）、それより前は旧ルールの日次残高。
 * 口座残高制で付与がまだなら、参加中のAIにはここで付与する
 */
export async function budgetFor(db: D1Database, agent: { id: string; status: string }, raceDate: string, nowMs: number): Promise<Budget> {
  if (!accountRulesApply(raceDate)) {
    const d = await balanceOfDay(db, agent.id, raceDate);
    return { rule: 'daily', date: raceDate, ...d, exhausted: isExhausted(d.balance) };
  }
  const month = raceDate.slice(0, 7);
  await ensureGrant(db, agent, month, nowMs);
  const a = await accountBalance(db, agent.id, month);
  if (!a) return { rule: 'monthly', month, start_date: null, granted: 0, staked: 0, credited: 0, fined: 0, balance: 0, gain: 0, gain_pct: null, exhausted: true };
  return { rule: 'monthly', ...a, gain_pct: gainPct(a.gain, a.granted) };
}

/** その月に、成績から外すAI（その月の失格、または以後の参加禁止） */
async function excludedAgents(db: D1Database, month: string): Promise<Set<string>> {
  const r = await db
    .prepare("SELECT DISTINCT agent_id FROM adjudications WHERE status = 'enforced' AND level = 'disqualification' AND (season_id = ? OR ban_future_seasons = 1)")
    .bind(month)
    .all<{ agent_id: string }>();
  return new Set(r.results.map((x) => x.agent_id));
}

export interface AccountStanding {
  rank: number;
  agent_id: string;
  start_date: string;
  granted: number;
  balance: number;
  gain: number;
  gain_pct: number | null;
  exhausted: boolean;
  active: boolean;
  /** 補助指標（判定済みの舟券と罰金。返還は除外） */
  stake: number;
  payout: number;
  recovery_pct: number | null;
  hit_rate_pct: number | null;
  bets: number;
  hits: number;
  races: number;
  no_shows: number;
  fined: number;
}

/**
 * 月の順位（本番）。主指標はその時点の残高（月末は月末残高）。付与のあったAIを全員並べ、
 * その月に提出も罰金もないAIは順位なし（rank 0）。その月に失格したAIは除く。upTo を渡すとその開催日までで計算する
 */
export async function accountStandings(db: D1Database, month: string, upTo?: string): Promise<AccountStanding[]> {
  const range = accountRange(month);
  if (!range) return [];
  const to = upTo && upTo < range.to ? upTo : range.to;
  const [grants, money, fines, stats, excluded] = await Promise.all([
    db.prepare("SELECT g.agent_id, g.amount, g.start_date FROM account_grants g JOIN agents a ON a.id = g.agent_id WHERE g.month = ? AND a.realm = 'live'").bind(month).all<{ agent_id: string; amount: number; start_date: string }>(),
    db
      .prepare(
        `SELECT agent_id, SUM(amount) AS staked, SUM(CASE status WHEN 'refunded' THEN amount WHEN 'hit' THEN payout ELSE 0 END) AS credited, COUNT(*) AS n
         FROM bets WHERE realm = 'live' AND status != 'cancelled' AND race_date BETWEEN ? AND ? GROUP BY agent_id`,
      )
      .bind(range.from, to)
      .all<{ agent_id: string; staked: number; credited: number; n: number }>(),
    db.prepare('SELECT agent_id, COUNT(*) AS n, SUM(amount) AS s FROM fines WHERE race_date BETWEEN ? AND ? GROUP BY agent_id').bind(range.from, to).all<{ agent_id: string; n: number; s: number }>(),
    statsBetween(db, range.from, to),
    excludedAgents(db, month),
  ]);
  const m = new Map(money.results.map((x) => [x.agent_id, x]));
  const f = new Map(fines.results.map((x) => [x.agent_id, x]));
  const s = new Map(stats.map((x) => [x.agent_id, x]));
  const rows = grants.results
    .filter((g) => !excluded.has(g.agent_id))
    .map((g) => {
      const mm = m.get(g.agent_id);
      const ff = f.get(g.agent_id);
      const ss = s.get(g.agent_id);
      const balance = g.amount - (mm?.staked ?? 0) + (mm?.credited ?? 0) - (ff?.s ?? 0);
      return {
        agent_id: g.agent_id, start_date: g.start_date, granted: g.amount, balance, gain: balance - g.amount, gain_pct: gainPct(balance - g.amount, g.amount),
        exhausted: isExhausted(balance), active: (mm?.n ?? 0) > 0 || (ff?.n ?? 0) > 0,
        stake: ss?.stake ?? 0, payout: ss?.payout ?? 0, recovery_pct: recoveryPct(ss?.payout ?? 0, ss?.stake ?? 0), hit_rate_pct: hitRatePct(ss?.hits ?? 0, ss?.bets ?? 0),
        bets: ss?.bets ?? 0, hits: ss?.hits ?? 0, races: ss?.races ?? 0, no_shows: ff?.n ?? 0, fined: ff?.s ?? 0,
      };
    });
  return rankByBalance(rows);
}

/** 開催日を締めたときの確定残高を記録する（本番。その月の付与があり、参加開始日を過ぎたAI） */
export function recordBalanceDays(db: D1Database, date: string, standings: readonly AccountStanding[], nowMs: number): D1PreparedStatement[] {
  return standings
    .filter((s) => s.start_date <= date)
    .map((s) =>
      db
        .prepare('INSERT INTO balance_days (agent_id, race_date, month, balance, recorded_at) VALUES (?, ?, ?, ?, ?) ON CONFLICT (agent_id, race_date) DO UPDATE SET balance = excluded.balance, recorded_at = excluded.recorded_at')
        .bind(s.agent_id, date, date.slice(0, 7), s.balance, jstIso(nowMs)),
    );
}

/** 月が確定済みか */
export async function monthClosed(db: D1Database, month: string): Promise<boolean> {
  return !!(await db.prepare('SELECT 1 FROM month_closings WHERE month = ?').bind(month).first());
}

/**
 * 過ぎた月のうち、開催日のレースがすべて精算・中止になり、すべての開催日を締めた月の成績を確定する。
 * 月次成績表（month_results）に残し、参加AIへイベント month.finalized を送る
 */
export async function finalizeMonths(db: D1Database, nowMs: number): Promise<string[]> {
  const current = jstDate(nowMs).slice(0, 7);
  const months = (
    await db
      .prepare('SELECT DISTINCT month FROM account_grants WHERE month < ? AND month NOT IN (SELECT month FROM month_closings) ORDER BY month')
      .bind(current)
      .all<{ month: string }>()
  ).results.map((r) => r.month);
  const log: string[] = [];
  for (const month of months) {
    const range = accountRange(month);
    if (!range) continue;
    const open = await db
      .prepare(
        `SELECT COUNT(*) AS n FROM races WHERE race_date BETWEEN ? AND ?
           AND (status NOT IN ('settled', 'cancelled') OR race_date NOT IN (SELECT race_date FROM day_closings))`,
      )
      .bind(range.from, range.to)
      .first<{ n: number }>();
    if ((open?.n ?? 0) > 0) continue;
    const standings = await accountStandings(db, month);
    const ranked = standings.filter((s) => s.rank > 0).length;
    const now = jstIso(nowMs);
    await db.batch([
      db.prepare('INSERT OR IGNORE INTO month_closings (month, closed_at) VALUES (?, ?)').bind(month, now),
      ...standings.map((s) =>
        db
          .prepare('INSERT OR REPLACE INTO month_results (month, agent_id, start_date, final_balance, gain, rank, stake, payout, fined, races) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
          .bind(month, s.agent_id, s.start_date, s.balance, s.gain, s.rank || null, s.stake, s.payout, s.fined, s.races),
      ),
      ...standings.map((s) =>
        db.prepare('INSERT INTO events (agent_id, type, payload, created_at) VALUES (?, ?, ?, ?)').bind(
          s.agent_id,
          'month.finalized',
          JSON.stringify({
            month, start_date: s.start_date, final_balance: s.balance, gain: s.gain, gain_pct: s.gain_pct, rank: s.rank || null, ranked_agents: ranked,
            stake: s.stake, payout: s.payout, recovery_pct: s.recovery_pct, hit_rate_pct: s.hit_rate_pct, races: s.races, no_shows: s.no_shows, fined: s.fined,
            note: `${month} の月次成績が確定しました（その月の開催日のレースがすべて精算されました）。月を振り返り、来月の配分と予想の仕方を見直してください`,
          }),
          now,
        ),
      ),
    ]);
    log.push(`month finalized: ${month} (${standings.length} agents)`);
  }
  return log;
}

/** 月次成績表（確定した月）。通算（増加額の合計・月間1位の回数）の計算にも使う */
export async function monthResults(db: D1Database, agentId?: string) {
  const r = await db
    .prepare(`SELECT * FROM month_results${agentId ? ' WHERE agent_id = ?' : ''} ORDER BY month DESC, rank IS NULL, rank`)
    .bind(...(agentId ? [agentId] : []))
    .all<{ month: string; agent_id: string; start_date: string; final_balance: number; gain: number; rank: number | null; stake: number; payout: number; fined: number; races: number }>();
  return r.results;
}

/** 通算: 確定した月の増加額の合計と、月間1位の回数 */
export function careerTotals(rows: readonly { agent_id: string; gain: number; rank: number | null }[]): Map<string, { months: number; total_gain: number; month_wins: number }> {
  const out = new Map<string, { months: number; total_gain: number; month_wins: number }>();
  for (const r of rows) {
    const t = out.get(r.agent_id) ?? { months: 0, total_gain: 0, month_wins: 0 };
    t.months++;
    t.total_gain += r.gain;
    if (r.rank === 1) t.month_wins++;
    out.set(r.agent_id, t);
  }
  return out;
}
