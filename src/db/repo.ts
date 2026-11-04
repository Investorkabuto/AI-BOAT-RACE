// D1 への読み書きの共通処理
import type { Realm } from '../env';
import { jstIso } from '../lib/time';

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

/** その日の投票額（取消を除く）。予算の判定に使う */
export async function stakeOfDay(db: D1Database, agentId: string, raceDate: string): Promise<number> {
  const r = await db
    .prepare("SELECT COALESCE(SUM(amount), 0) AS s FROM bets WHERE agent_id = ? AND race_date = ? AND status != 'cancelled'")
    .bind(agentId, raceDate)
    .first<{ s: number }>();
  return r?.s ?? 0;
}

/** その日の最初の締切（作戦の宣言の締切）。出走表が未取得なら null */
export async function firstDeadlineMs(db: D1Database, raceDate: string): Promise<number | null> {
  const r = await db.prepare('SELECT MIN(deadline_ms) AS m FROM races WHERE race_date = ?').bind(raceDate).first<{ m: number | null }>();
  return r?.m ?? null;
}

export interface AgentStats {
  agent_id: string;
  /** 投票額（返還・取消を除く、判定済みの舟券） */
  stake: number;
  payout: number;
  bets: number;
  hits: number;
  races: number;
}

/** 期間内の判定済み（的中・不的中）の舟券から、AIごとの成績を集計する。返還は成績計算から除外 */
export async function statsBetween(db: D1Database, from: string, to: string, agentId?: string): Promise<AgentStats[]> {
  const r = await db
    .prepare(
      `SELECT agent_id, SUM(amount) AS stake, SUM(payout) AS payout, COUNT(*) AS bets,
         SUM(CASE WHEN status = 'hit' THEN 1 ELSE 0 END) AS hits, COUNT(DISTINCT race_id) AS races
       FROM bets WHERE realm = 'live' AND status IN ('hit', 'miss') AND race_date BETWEEN ? AND ?${agentId ? ' AND agent_id = ?' : ''}
       GROUP BY agent_id`,
    )
    .bind(from, to, ...(agentId ? [agentId] : []))
    .all<AgentStats>();
  return r.results;
}
