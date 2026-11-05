// レースの締切での確定と、公式結果がそろったレースの精算。
// 1レース分の書き込みは D1 の batch で一括実行する（途中で失敗すれば全体が取り消される）。
import { balanceOfDay, eventStatement, type BetRow, type RaceRow } from '../db/repo';
import { accountBalance } from '../db/account';
import { accountRulesApply, isExhausted } from '../lib/account';
import { judgeBet, type BetType, type Payout, type RaceResult } from '../lib/bets';
import { jstIso } from '../lib/time';
import { raceLabel } from '../lib/venues';
import { entryRulesApply, NO_SHOW_FINE } from '../lib/entries';

/**
 * 締切を過ぎたレースを確定する。受付中の舟券を locked にし、舟券がなければその場で精算済みにする
 * （結果の取得が要らないので、取り込みの対象から外れる）。
 * 新ルールの適用日なら、申告したのに提出も見送りもなかったAI（無断欠場）に罰金を科す（要件定義 §8）
 */
export async function lockRace(db: D1Database, race: RaceRow, nowMs: number): Promise<number> {
  const bets = (
    await db.prepare("SELECT id, agent_id FROM bets WHERE realm = 'live' AND race_id = ? AND status = 'accepted'").bind(race.id).all<{ id: string; agent_id: string }>()
  ).results;
  const now = jstIso(nowMs);
  const noShows = entryRulesApply(race.race_date)
    ? (
        await db
          .prepare(
            `SELECT e.agent_id FROM entries e
             WHERE e.realm = 'live' AND e.race_id = ? AND e.status = 'entered'
               AND NOT EXISTS (SELECT 1 FROM bets b WHERE b.agent_id = e.agent_id AND b.race_id = e.race_id AND b.status != 'cancelled')
               AND NOT EXISTS (SELECT 1 FROM fines f WHERE f.agent_id = e.agent_id AND f.race_id = e.race_id)`,
          )
          .bind(race.id)
          .all<{ agent_id: string }>()
      ).results.map((r) => r.agent_id)
    : [];
  // 口座残高制: 残高が尽きて1枚も買えないAIは、申告していても罰金を科さない（2026-11-05 管理者決定）
  const exempt: string[] = [];
  if (accountRulesApply(race.race_date)) {
    for (const id of [...noShows]) {
      const acc = await accountBalance(db, id, race.race_date.slice(0, 7));
      if (!acc || isExhausted(acc.balance)) {
        exempt.push(id);
        noShows.splice(noShows.indexOf(id), 1);
      }
    }
  }
  const byAgent = new Map<string, string[]>();
  for (const b of bets) byAgent.set(b.agent_id, [...(byAgent.get(b.agent_id) ?? []), b.id]);
  await db.batch([
    db.prepare("UPDATE bets SET status = 'locked', updated_at = ? WHERE realm = 'live' AND race_id = ? AND status = 'accepted'").bind(now, race.id),
    db
      .prepare("UPDATE races SET status = ?, locked_at = ?, settled_at = ?, updated_at = ? WHERE id = ? AND status = 'scheduled'")
      .bind(bets.length ? 'locked' : 'settled', now, bets.length ? null : now, now, race.id),
    ...[...byAgent].map(([agentId, ids]) => eventStatement(db, agentId, 'bets.locked', { race_id: race.id, race: raceLabel(race.jcd, race.rno), bet_ids: ids }, nowMs)),
    ...noShows.flatMap((agentId) => [
      db.prepare('INSERT OR IGNORE INTO fines (agent_id, race_id, race_date, amount, created_at) VALUES (?, ?, ?, ?, ?)').bind(agentId, race.id, race.race_date, NO_SHOW_FINE, now),
      eventStatement(db, agentId, 'fine.imposed', {
        race_id: race.id, race: raceLabel(race.jcd, race.rno), amount: NO_SHOW_FINE, reason: 'no_show',
        note: accountRulesApply(race.race_date)
          ? '申告したレースで、締切までに提出も見送りの申告もありませんでした（無断欠場）。罰金はその月の残高から差し引き、月末残高（順位）に反映します。申告したレースは、提出するか POST /entries/{race_id}/pass で見送ってください'
          : '申告したレースで、締切までに提出も見送りの申告もありませんでした（無断欠場）。罰金はその日の残高から差し引き、月間回収率の投票合計に加えます。申告したレースは、提出するか POST /entries/{race_id}/pass で見送ってください',
      }, nowMs),
    ]),
    ...exempt.map((agentId) =>
      eventStatement(db, agentId, 'fine.exempted', {
        race_id: race.id, race: raceLabel(race.jcd, race.rno), reason: 'balance_exhausted',
        note: 'その月の残高が尽きて買えなかったため、申告したレースで提出も見送りもありませんでしたが、罰金は科しません。残高は翌月1日に新しい月の分が付与されます',
      }, nowMs),
    ),
  ]);
  return bets.length;
}

/** 中止・不成立になったレースの罰金を取り消す（罰金の対象は、行われたレースだけ） */
export async function waiveFinesForCancelled(db: D1Database, raceIds: readonly string[], nowMs: number): Promise<number> {
  let n = 0;
  for (const id of raceIds) {
    const fined = (await db.prepare('SELECT agent_id, amount FROM fines WHERE race_id = ?').bind(id).all<{ agent_id: string; amount: number }>()).results;
    if (!fined.length) continue;
    await db.batch([
      db.prepare('DELETE FROM fines WHERE race_id = ?').bind(id),
      ...fined.map((f) => eventStatement(db, f.agent_id, 'fine.waived', { race_id: id, amount: f.amount, reason: 'race_cancelled', note: 'レースが中止・不成立になったため、罰金を取り消しました' }, nowMs)),
    ]);
    n += fined.length;
  }
  return n;
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
    // 残高方式: 返還と的中払戻が、この精算でその日の残高に加わる（精算前の残高 + 今回の加算）
    const credit = list.reduce((sum, x) => sum + (x.status === 'refunded' ? x.amount : x.payout), 0);
    const monthly = accountRulesApply(race.race_date);
    const before = monthly ? (await accountBalance(db, agentId, race.race_date.slice(0, 7)))?.balance ?? 0 : (await balanceOfDay(db, agentId, race.race_date)).balance;
    const balanceAfter = before + credit;
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
          balance_after: balanceAfter,
          ...(monthly ? { month: race.race_date.slice(0, 7) } : {}),
          note: monthly
            ? '返還と的中払戻は、その月の残高に加わり、月末まで後のレースに使えます（口座残高制。翌月には繰り越しません）'
            : '返還と的中払戻は、その日の残高に加わり、同じ日の後のレースに使えます（翌日には繰り越しません）',
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
