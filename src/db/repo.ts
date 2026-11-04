// D1 への読み書きの共通処理
import type { Realm } from '../env';
import { jstIso } from '../lib/time';
import { dailyBudget } from '../lib/entries';
import { dayBalance, type BalanceRow } from '../lib/bets';

export interface AgentRow {
  id: string;
  realm: Realm;
  display_name: string;
  owner_name: string;
  profile: string;
  status: 'pending' | 'active' | 'rejected' | 'disqualified';
  review_reason: string | null;
  created_at: string;
  reviewed_at: string | null;
}

export interface RaceRow {
  id: string;
  race_date: string;
  jcd: string;
  rno: number;
  race_name: string | null;
  deadline_at: string;
  deadline_ms: number;
  status: 'scheduled' | 'locked' | 'settled' | 'cancelled';
  locked_at: string | null;
  settled_at: string | null;
}

export interface BetRow {
  id: string;
  submission_id: string;
  agent_id: string;
  realm: Realm;
  race_id: string;
  race_date: string;
  bet_type: string;
  combo: string;
  amount: number;
  status: 'accepted' | 'locked' | 'hit' | 'miss' | 'refunded' | 'cancelled';
  payout: number;
  refund_reason: string | null;
  received_ms: number;
  updated_at: string;
}

export function eventStatement(db: D1Database, agentId: string, type: string, payload: unknown, nowMs: number): D1PreparedStatement {
  return db.prepare('INSERT INTO events (agent_id, type, payload, created_at) VALUES (?, ?, ?, ?)').bind(agentId, type, JSON.stringify(payload), jstIso(nowMs));
}

export type Actor = 'operator' | 'admin' | 'system';

export function auditStatement(db: D1Database, actor: Actor, action: string, target: string | null, detail: unknown, nowMs: number): D1PreparedStatement {
  return db
    .prepare('INSERT INTO audit_log (actor, action, target, detail_json, created_at, created_ms) VALUES (?, ?, ?, ?, ?, ?)')
    .bind(actor, action, target, detail === undefined ? null : JSON.stringify(detail), jstIso(nowMs), nowMs);
}

export function formatBet(b: BetRow) {
  return {
    id: b.id,
    submission_id: b.submission_id,
    race_id: b.race_id,
    race_date: b.race_date,
    bet_type: b.bet_type,
    combo: b.combo,
    amount: b.amount,
    status: b.status,
    payout: b.payout,
    ...(b.refund_reason ? { refund_reason: b.refund_reason } : {}),
  };
}

/** その日の残高（残高方式）。提出できるのは balance の範囲内。罰金（無断欠場）は差し引く */
export async function balanceOfDay(db: D1Database, agentId: string, raceDate: string) {
  const rows = (await db.prepare('SELECT status, amount, payout FROM bets WHERE agent_id = ? AND race_date = ?').bind(agentId, raceDate).all<BalanceRow>()).results;
  const fined = await db.prepare('SELECT COALESCE(SUM(amount), 0) AS s FROM fines WHERE agent_id = ? AND race_date = ?').bind(agentId, raceDate).first<{ s: number }>();
  return dayBalance(dailyBudget(raceDate), rows, fined?.s ?? 0);
}

/** その日の最初の締切（作戦の宣言の締切）。出走表が未取得なら null */
export async function firstDeadlineMs(db: D1Database, raceDate: string): Promise<number | null> {
  const r = await db.prepare('SELECT MIN(deadline_ms) AS m FROM races WHERE race_date = ?').bind(raceDate).first<{ m: number | null }>();
  return r?.m ?? null;
}

export interface AgentStats {
  agent_id: string;
  /** 投票額（返還・取消を除く、判定済みの舟券）。罰金（無断欠場）も含む */
  stake: number;
  /** 罰金の回数と合計（stake に含まれる） */
  fines: number;
  fined: number;
  payout: number;
  bets: number;
  hits: number;
  races: number;
}

/** 期間内の判定済み（的中・不的中）の舟券と罰金から、AIごとの成績を集計する。返還は成績計算から除外。罰金は投票合計に加える（払戻0の舟券と同じ扱い） */
export async function statsBetween(db: D1Database, from: string, to: string, agentId?: string): Promise<AgentStats[]> {
  const extra = agentId ? ' AND agent_id = ?' : '';
  const args = [from, to, ...(agentId ? [agentId] : [])];
  const [bets, fines] = await Promise.all([
    db
      .prepare(
        `SELECT agent_id, SUM(amount) AS stake, SUM(payout) AS payout, COUNT(*) AS bets,
           SUM(CASE WHEN status = 'hit' THEN 1 ELSE 0 END) AS hits, COUNT(DISTINCT race_id) AS races
         FROM bets WHERE realm = 'live' AND status IN ('hit', 'miss') AND race_date BETWEEN ? AND ?${extra}
         GROUP BY agent_id`,
      )
      .bind(...args)
      .all<Omit<AgentStats, 'fines' | 'fined'>>()
      .then((r) => r.results),
    db.prepare(`SELECT agent_id, COUNT(*) AS n, SUM(amount) AS s FROM fines WHERE race_date BETWEEN ? AND ?${extra} GROUP BY agent_id`).bind(...args).all<{ agent_id: string; n: number; s: number }>().then((r) => r.results),
  ]);
  return mergeFines(bets, fines);
}

/** 舟券の集計に罰金を足し込む（罰金だけのAIも1行になる） */
export function mergeFines(bets: readonly Omit<AgentStats, 'fines' | 'fined'>[], fines: readonly { agent_id: string; n: number; s: number }[]): AgentStats[] {
  const out = new Map<string, AgentStats>(bets.map((b) => [b.agent_id, { ...b, fines: 0, fined: 0 }]));
  for (const f of fines) {
    const row = out.get(f.agent_id) ?? { agent_id: f.agent_id, stake: 0, payout: 0, bets: 0, hits: 0, races: 0, fines: 0, fined: 0 };
    row.fines = f.n;
    row.fined = f.s;
    row.stake += f.s;
    out.set(f.agent_id, row);
  }
  return [...out.values()];
}
