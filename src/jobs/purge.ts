// 過去分（B・K から作った大会開始前のレース）の削除。2026-11-07 管理者決定:
// 過去データと統計はもち側が持つ（2023-11 以降を保有）ので、アプリは過去分の取り込みをやめ、取り込み済みの分を消す。
// 定時処理（5分ごと）が古い日から1回に PURGE_DAYS_PER_TICK 日ずつ消す。消し終えたら事前集計の古い月も消し、以後は何もしない。
// 舟券・申告のある日は消さない（大会の記録を守る。大会開始前なので無いはずだが念のため）
import { jstIso } from '../lib/time';
import { dayIdRange } from '../db/boats';
import { markAggDirty } from './aggregate';

/** この日より前のレースを消す（大会の最初の開催日） */
export const PURGE_BEFORE = '2026-11-04';
/** 1回の定時処理で消す日数（1日分は約160レース、書き込みは索引を含めて約2万行） */
export const PURGE_DAYS_PER_TICK = 2;

const STATE_KEY = 'purge:history';

/** 子の表から先に消す（races を参照しているため） */
const CHILD_TABLES = ['race_boats', 'race_payouts', 'race_results', 'race_starts', 'race_entrants', 'race_cards', 'race_card_history', 'race_records', 'race_record_history'];

const AGG_TABLES = ['agg_racer_course', 'agg_motor', 'agg_venue_course', 'agg_venue_kimarite', 'agg_payout'];

export async function purgeHistory(db: D1Database, nowMs: number, days = PURGE_DAYS_PER_TICK): Promise<string[]> {
  const state = await db.prepare('SELECT value FROM app_state WHERE key = ?').bind(STATE_KEY).first<{ value: string }>();
  if (state?.value === 'done') return [];
  let cursor = state?.value ?? ''; // 処理済みの最後の日（舟券などがあって残した日を飛ばすため）
  const log: string[] = [];
  for (let i = 0; i < days; i++) {
    const next = await db
      .prepare('SELECT race_date FROM races WHERE race_date > ? AND race_date < ? ORDER BY race_date LIMIT 1')
      .bind(cursor, PURGE_BEFORE)
      .first<{ race_date: string }>();
    if (!next) {
      await finish(db, nowMs);
      log.push('purge: history done');
      return log;
    }
    const date = next.race_date;
    const [lo, hi] = dayIdRange(date);
    const [bets, entries] = await db.batch([
      db.prepare("SELECT 1 AS x FROM bets WHERE realm IN ('live', 'sandbox') AND race_date = ? LIMIT 1").bind(date),
      db.prepare("SELECT 1 AS x FROM entries WHERE realm IN ('live', 'sandbox') AND race_id BETWEEN ? AND ? LIMIT 1").bind(lo, hi),
    ]);
    if (bets!.results.length || entries!.results.length) {
      log.push(`purge: kept ${date} (bets or entries)`);
    } else {
      await db.batch([
        ...CHILD_TABLES.map((t) => db.prepare(`DELETE FROM ${t} WHERE race_id BETWEEN ? AND ?`).bind(lo, hi)),
        db.prepare('DELETE FROM races WHERE race_date = ?').bind(date),
      ]);
      log.push(`purge: ${date}`);
    }
    cursor = date;
    await setState(db, cursor, nowMs);
  }
  return log;
}

/** 消し終えたら、事前集計の古い月を消し、最初の開催月を作り直す（その月に残っていた過去分の日が消えたため） */
async function finish(db: D1Database, nowMs: number): Promise<void> {
  const ym = PURGE_BEFORE.slice(0, 7);
  await db.batch([
    ...AGG_TABLES.map((t) => db.prepare(`DELETE FROM ${t} WHERE ym < ?`).bind(ym)),
    db.prepare('DELETE FROM agg_months WHERE ym < ?').bind(ym),
  ]);
  await markAggDirty(db, [PURGE_BEFORE], nowMs);
  await setState(db, 'done', nowMs);
}

async function setState(db: D1Database, value: string, nowMs: number) {
  await db
    .prepare('INSERT INTO app_state (key, value, updated_at) VALUES (?, ?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at')
    .bind(STATE_KEY, value, jstIso(nowMs))
    .run();
}
