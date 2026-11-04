// レースの締切での確定と、公式結果がそろったレースの精算。
// 1レース分の書き込みは D1 の batch で一括実行する（途中で失敗すれば全体が取り消される）。
import { eventStatement, type BetRow, type RaceRow } from '../db/repo';
import { judgeBet, type BetType, type Payout, type RaceResult } from '../lib/bets';
import { jstIso } from '../lib/time';
import { raceLabel } from '../lib/venues';

/**
 * 締切を過ぎたレースを確定する。受付中の舟券を locked にし、舟券がなければその場で精算済みにする
 * （結果の取得が要らないので、取り込みの対象から外れる）
 */
export async function lockRace(db: D1Database, race: RaceRow, nowMs: number): Promise<number> {
  const bets = (
    await db.prepare("SELECT id, agent_id FROM bets WHERE realm = 'live' AND race_id = ? AND status = 'accepted'").bind(race.id).all<{ id: string; agent_id: string }>()
  ).results;
  const now = jstIso(nowMs);
  const byAgent = new Map<string, string[]>();
  for (const b of bets) byAgent.set(b.agent_id, [...(byAgent.get(b.agent_id) ?? []), b.id]);
  await db.batch([
    db.prepare("UPDATE bets SET status = 'locked', updated_at = ? WHERE realm = 'live' AND race_id = ? AND status = 'accepted'").bind(now, race.id),
    db
      .prepare("UPDATE races SET status = ?, locked_at = ?, settled_at = ?, updated_at = ? WHERE id = ? AND status = 'scheduled'")
      .bind(bets.length ? 'locked' : 'settled', now, bets.length ? null : now, now, race.id),
    ...[...byAgent].map(([agentId, ids]) => eventStatement(db, agentId, 'bets.locked', { race_id: race.id, race: raceLabel(race.jcd, race.rno), bet_ids: ids }, nowMs)),
  ]);
  return bets.length;
}

export function parseResult(row: { status: string; refunded_boats_json: string; payouts_json: string }): RaceResult {
  return {
    status: row.status === 'cancelled' ? 'cancelled' : 'official',
    refunded_boats: JSON.parse(row.refunded_boats_json) as number[],
    payouts: JSON.parse(row.payouts_json) as Payout[],
  };
}

/** 公式結果がそろっていれば、そのレースの舟券を判定して精算する。結果がなければ false */
export async function settleRace(db: D1Database, race: RaceRow, nowMs: number): Promise<boolean> {
  const row = await db
    .prepare('SELECT status, refunded_boats_json, payouts_json FROM race_results WHERE race_id = ?')
    .bind(race.id)
    .first<{ status: string; refunded_boats_json: string; payouts_json: string }>();
  if (!row) return false;
  const result = parseResult(row);
  const bets = (await db.prepare("SELECT * FROM bets WHERE realm = 'live' AND race_id = ? AND status = 'locked'").bind(race.id).all<BetRow>()).results;
  const now = jstIso(nowMs);
  const stmts: D1PreparedStatement[] = [];
  const perAgent = new Map<string, { bet_id: string; bet_type: string; combo: string; amount: number; status: string; payout: number }[]>();
  for (const b of bets) {
    const o = judgeBet({ bet_type: b.bet_type as BetType, combo: b.combo, amount: b.amount }, result);
    stmts.push(
      db.prepare('UPDATE bets SET status = ?, payout = ?, refund_reason = ?, updated_at = ? WHERE id = ? AND status = ?').bind(o.status, o.payout, o.status === 'refunded' ? o.reason : null, now, b.id, 'locked'),
    );
    perAgent.set(b.agent_id, [...(perAgent.get(b.agent_id) ?? []), { bet_id: b.id, bet_type: b.bet_type, combo: b.combo, amount: b.amount, status: o.status, payout: o.payout }]);
  }
  for (const [agentId, list] of perAgent) {
    const judged = list.filter((x) => x.status !== 'refunded');
    stmts.push(
      eventStatement(
        db,
        agentId,
        'race.settled',
        {
          race_id: race.id,
          race: raceLabel(race.jcd, race.rno),
          race_status: result.status,
          stake: judged.reduce((s, x) => s + x.amount, 0),
          payout: judged.reduce((s, x) => s + x.payout, 0),
          refunded: list.filter((x) => x.status === 'refunded').reduce((s, x) => s + x.amount, 0),
          bets: list,
        },
        nowMs,
      ),
    );
  }
  stmts.push(
    db
      .prepare("UPDATE races SET status = ?, settled_at = ?, updated_at = ? WHERE id = ? AND status = 'locked'")
      .bind(result.status === 'cancelled' ? 'cancelled' : 'settled', now, now, race.id),
  );
  await db.batch(stmts);
  return true;
}
