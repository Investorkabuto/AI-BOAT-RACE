// 5分ごとに起動する状態機械。「今は何をする時間か」を判断して、ゲームを1歩進める。
// 何度実行しても結果が変わらないように作ってある（再実行・遅延に強い）。
//  1. 締切を過ぎたレースの確定（舟券を locked に）
//  2. 公式結果がそろったレースの精算（的中・不的中・返還）
//  3. その場の全レースが終わったら、運営AIに実況のタスク
//  4. その日の全レースが終わったら、日次の締め（参加AIへ日次と月間の成績・順位、運営AIに不正検知・日報・週報・月間総評のタスク）
//  5. 出走表・結果の取得（GitHub Actions）の起動
//  6. 運営タスクの失効、滞留通知、Webhook の配送、観戦画面への的中の通知、ルール改定の通知、月替わりの失格の復帰
//  7. 口座残高制: 月初（と承認直後）の残高の付与、日ごとの確定残高の記録、過ぎた月の月次成績の確定
//  8. 分析の事前集計と、詰めた形の片付け（v1.3。1日の読み書きの量の上限まで）
//  9. 過去分（大会開始前のレース）の削除（2026-11-07 管理者決定。消し終えたら何もしない）
import type { Env } from '../env';
import { ensureSchema } from '../db/migrate';
import { eventStatement, statsBetween, type RaceRow } from '../db/repo';
import { hitRatePct, rankByRecovery, recoveryPct } from '../lib/bets';
import { addDays, jstDate, jstIso, monthRange } from '../lib/time';
import { lockRace, settleRace } from './settlement';
import { deliverWebhooks } from './webhooks';
import { deliverPush } from './push';
import { dispatchFetches } from './fetch-dispatch';
import { notifyRulesChange } from './notify';
import { restoreDisqualifiedForNewMonth } from '../operator/core';
import { accountStandings, finalizeMonths, grantCurrentMonth, recordBalanceDays } from '../db/account';
import { accountRange, accountRulesApply } from '../lib/account';
import { aggregate } from './aggregate';
import { compactPacked } from './compact';
import { purgeHistory } from './purge';
import { loadUsage, saveUsage } from './budget';
import { checkAlerts, commentaryTasks, expireTasks, seasonReviewTask, tasksAfterDayClose } from '../operator/scheduler';

/** 締めていない日を探す範囲（日数）。過去分の取り込みで作った古い日付は締めない（締める対象は開催中の日だけ） */
export const CLOSE_LOOKBACK_DAYS = 14;

/**
 * 締める日の候補。定時処理が5分ごとに流すので、races の全体を読まないこと（過去分の取り込みで数万行あり、
 * D1 の1日の読み取り上限を使い切る。2026-11-06 の停止）。日付の索引で直近 CLOSE_LOOKBACK_DAYS 日だけを読む
 */
export const CLOSE_DAYS_SQL = `SELECT race_date FROM races WHERE race_date BETWEEN ? AND ? AND race_date NOT IN (SELECT race_date FROM day_closings)
         GROUP BY race_date HAVING SUM(CASE WHEN status IN ('settled', 'cancelled') THEN 0 ELSE 1 END) = 0 AND MAX(deadline_ms) <= ?
         ORDER BY race_date`;

/** 最後の締切からこれだけ経っても、その日を締めない（出走表の取り込み漏れや結果の遅れに備える） */
const DAY_CLOSE_GRACE_MS = 30 * 60 * 1000;

export async function tick(env: Env, nowMs: number): Promise<string[]> {
  const db = env.DB;
  const log: string[] = [];
  const migrated = await ensureSchema(db);
  if (migrated.length) log.push(`schema migrated: ${migrated.join(', ')}`);
  log.push(...(await restoreDisqualifiedForNewMonth(db, nowMs)));
  log.push(...(await notifyRulesChange(db, nowMs)));
  log.push(...(await grantCurrentMonth(db, nowMs)));

  const toLock = (await db.prepare("SELECT * FROM races WHERE status = 'scheduled' AND deadline_ms <= ? ORDER BY deadline_ms").bind(nowMs).all<RaceRow>()).results;
  for (const r of toLock) {
    const n = await lockRace(db, r, nowMs);
    if (n) log.push(`locked ${r.id}: ${n} bets`);
  }
  if (toLock.length) log.push(`locked races: ${toLock.length}`);

  const locked = (await db.prepare("SELECT * FROM races WHERE status = 'locked' ORDER BY deadline_ms").all<RaceRow>()).results;
  let waiting = 0;
  for (const r of locked) {
    if (await settleRace(db, r, nowMs)) log.push(`settled ${r.id}`);
    else waiting++;
  }
  if (waiting) log.push(`waiting results: ${waiting} races`);
  // 出走表・結果の取得を GitHub Actions で起動する（失敗しても、ほかの処理は続ける）
  try {
    log.push(...(await dispatchFetches(env, nowMs)));
  } catch (e) {
    log.push(`fetch dispatch error: ${String(e)}`);
  }

  log.push(...(await commentaryTasks(db, nowMs, addDays(jstDate(nowMs), -1))));
  log.push(...(await closeDays(db, nowMs)));
  log.push(...(await finalizeMonths(db, nowMs)));
  log.push(...(await expireTasks(db, nowMs)));
  log.push(...(await checkAlerts(env, nowMs)));
  log.push(...(await deliverWebhooks(env, nowMs)));
  // 観戦画面への的中の通知。失敗しても、ほかの処理は止めない
  try {
    log.push(...(await deliverPush(env, nowMs)));
  } catch (e) {
    log.push(`push error: ${String(e)}`);
  }
  // 裏方の作業（v1.3）: 分析の事前集計と、詰めた形の片付け。1日の読み書きの量に上限がある。失敗しても、ほかの処理は止めない
  try {
    const usage = await loadUsage(db, nowMs);
    log.push(...(await aggregate(db, nowMs, 1, usage)));
    log.push(...(await compactPacked(db, nowMs, jstIso(nowMs), usage)));
    await saveUsage(db, usage, nowMs);
  } catch (e) {
    log.push(`background error: ${String(e)}`);
  }
  try {
    log.push(...(await purgeHistory(db, nowMs)));
  } catch (e) {
    log.push(`purge error: ${String(e)}`);
  }
  await db.prepare('DELETE FROM challenges WHERE issued_ms < ?').bind(nowMs - 60 * 60 * 1000).run();
  return log;
}

/** 全レースが精算・中止になり、最後の締切から一定時間が過ぎた日を締める */
export async function closeDays(db: D1Database, nowMs: number): Promise<string[]> {
  const days = (
    await db
      .prepare(CLOSE_DAYS_SQL)
      .bind(addDays(jstDate(nowMs), -CLOSE_LOOKBACK_DAYS), jstDate(nowMs), nowMs - DAY_CLOSE_GRACE_MS)
      .all<{ race_date: string }>()
  ).results;
  const log: string[] = [];
  for (const { race_date: date } of days) {
    const { startsOn } = monthRange(date.slice(0, 7));
    const day = new Map((await statsBetween(db, date, date)).map((s) => [s.agent_id, s]));
    const month = rankByRecovery(await statsBetween(db, startsOn, date));
    const monthBy = new Map(month.map((m) => [m.agent_id, m]));
    // 口座残高制の開催日は、月の残高で順位を付け、その日の確定残高を記録する
    const monthly = accountRulesApply(date) && accountRange(date.slice(0, 7)) !== null;
    const account = monthly ? await accountStandings(db, date.slice(0, 7), date) : [];
    const accountBy = new Map(account.map((a) => [a.agent_id, a]));
    const rankedAccounts = account.filter((a) => a.rank > 0).length;
    // 返還だけだったAI・罰金だけだったAIにも、日次の結果を送る
    const agents = (
      await db
        .prepare("SELECT agent_id FROM bets WHERE realm = 'live' AND race_date = ? AND status != 'cancelled' UNION SELECT agent_id FROM fines WHERE race_date = ?")
        .bind(date, date)
        .all<{ agent_id: string }>()
    ).results.map((r) => r.agent_id);
    const stmts: D1PreparedStatement[] = [db.prepare('INSERT OR IGNORE INTO day_closings (race_date, closed_at) VALUES (?, ?)').bind(date, jstIso(nowMs)), ...recordBalanceDays(db, date, account, nowMs)];
    for (const id of agents) {
      const d = day.get(id);
      const m = monthBy.get(id);
      const acc = accountBy.get(id);
      stmts.push(
        eventStatement(
          db,
          id,
          'daily.settled',
          {
            race_date: date,
            day: { stake: d?.stake ?? 0, payout: d?.payout ?? 0, recovery_pct: recoveryPct(d?.payout ?? 0, d?.stake ?? 0), hit_rate_pct: hitRatePct(d?.hits ?? 0, d?.bets ?? 0), bets: d?.bets ?? 0, races: d?.races ?? 0, no_shows: d?.fines ?? 0, fined: d?.fined ?? 0 },
            month: monthly
              ? {
                  month: date.slice(0, 7), balance: acc?.balance ?? null, gain: acc?.gain ?? null, gain_pct: acc?.gain_pct ?? null, exhausted: acc?.exhausted ?? null,
                  rank: acc?.rank || null, ranked_agents: rankedAccounts, rank_by: 'balance',
                  stake: acc?.stake ?? 0, payout: acc?.payout ?? 0, recovery_pct: acc?.recovery_pct ?? null, fined: acc?.fined ?? 0,
                }
              : { month: date.slice(0, 7), stake: m?.stake ?? 0, payout: m?.payout ?? 0, recovery_pct: recoveryPct(m?.payout ?? 0, m?.stake ?? 0), rank: m?.rank || null, ranked_agents: month.filter((x) => x.rank > 0).length, rank_by: 'recovery' },
            note: '結果を振り返り、自分の予想の仕方と作戦の解釈を見直してください（再帰的自己改善。ルール 8章）',
          },
          nowMs,
        ),
      );
    }
    await db.batch(stmts);
    log.push(`day closed: ${date} (${agents.length} agents)`);
    // 運営AIのタスク。予想が1件もなかった日は積まない
    if (agents.length) log.push(`operator tasks ${date}: ${(await tasksAfterDayClose(db, date, nowMs)).join(', ')}`);
    if (date === monthRange(date.slice(0, 7)).endsOn && (await seasonReviewTask(db, date.slice(0, 7), nowMs))) log.push(`season review task: ${date.slice(0, 7)}`);
  }
  return log;
}
