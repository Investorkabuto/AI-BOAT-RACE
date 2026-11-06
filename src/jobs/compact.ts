// 詰めた形の片付け（要件定義 v1.3 §9.3、決定51）。race_cards.rows・race_records.rows・payouts を、
// race_boats・race_payouts に全て入っていることを確かめてから空（''）にする。
// - 番組表: 前日までのレース（締切前は版の比較と race_card_history のために詰めた形を持つ）
// - 競走成績: RECORD_KEEP_DAYS 日より前のレース（直近は公式の訂正との比較と race_record_history のために持つ）
// - 確かめ方: race_boats・race_payouts から参加APIと同じ作り方で組み立て、詰めた形と同じになるか（艇・払戻金の並びは問わない）
// - 競走成績のモーター・ボート番号が番組表と違う艇は、ここで race_boats.k_motor_no・k_boat_no に入れる（0012 より前に取り込んだ分）
// - 合わないレースは空にせず残す（ログに件数を出す）。race_id の順に進め、進んだところを app_state の compact:{cards|records} に記録する
import { addDays, jstDate } from '../lib/time';
import { packRacers } from '../lib/cards';
import { BET_TYPES } from '../lib/bets';
import { packPayouts, packRows, unpackPayouts, unpackRows, type RecordPayout, type RecordRow } from '../lib/records';
import { BOAT_COLS, dayIdRange, racersFromBoats, recordRowsFromBoats, type BoatRow } from '../db/boats';
import { addMeta, hasRoom, loadUsage, saveUsage, type Usage } from './budget';

export const RECORD_KEEP_DAYS = 7;
/** 1回の定時処理で片付けるレース数（番組表・競走成績それぞれ） */
const BATCH = 50;

const byBoat = <T extends { boat: number }>(a: readonly T[]) => [...a].sort((x, y) => x.boat - y.boat);
const payoutKey = (p: RecordPayout) => `${BET_TYPES.indexOf(p.bet_type)}:${p.combo}`;
const byPayout = (a: readonly RecordPayout[]) => [...a].sort((x, y) => (payoutKey(x) < payoutKey(y) ? -1 : payoutKey(x) > payoutKey(y) ? 1 : 0));
/** 艇・払戻金の並びを問わずに比べる */
export const sameRows = (a: readonly RecordRow[], b: readonly RecordRow[]) => packRows(byBoat(a)) === packRows(byBoat(b));
export const samePayouts = (a: readonly RecordPayout[], b: readonly RecordPayout[]) => packPayouts(byPayout(a)) === packPayouts(byPayout(b));

async function cursor(db: D1Database, kind: string): Promise<string> {
  return (await db.prepare('SELECT value FROM app_state WHERE key = ?').bind(`compact:${kind}`).first<{ value: string }>())?.value ?? '';
}
const setCursor = (db: D1Database, kind: string, v: string, now: string) =>
  db.prepare('INSERT INTO app_state (key, value, updated_at) VALUES (?, ?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at').bind(`compact:${kind}`, v, now);

async function boatsOf(db: D1Database, ids: readonly string[]): Promise<Map<string, BoatRow[]>> {
  const rows = (await db.prepare(`SELECT race_id, ${BOAT_COLS} FROM race_boats WHERE race_id IN (SELECT value FROM json_each(?))`).bind(JSON.stringify(ids)).all<BoatRow & { race_id: string }>()).results;
  const m = new Map<string, BoatRow[]>();
  for (const r of rows) m.set(r.race_id, [...(m.get(r.race_id) ?? []), r]);
  return m;
}

/** 番組表の詰めた形を片付ける */
async function compactCards(db: D1Database, nowMs: number, now: string, u: Usage): Promise<string[]> {
  const from = await cursor(db, 'cards');
  const until = dayIdRange(jstDate(nowMs))[0]; // 前日まで
  const q = await db.prepare("SELECT race_id, rows FROM race_cards WHERE race_id > ? AND race_id < ? AND rows != '' ORDER BY race_id LIMIT ?").bind(from, until, BATCH).all<{ race_id: string; rows: string }>();
  addMeta(u, [q]);
  if (!q.results.length) return [];
  const boats = await boatsOf(db, q.results.map((r) => r.race_id));
  const stmts: D1PreparedStatement[] = [];
  let bad = 0;
  for (const c of q.results) {
    if (packRacers(racersFromBoats(boats.get(c.race_id) ?? [])) === c.rows) stmts.push(db.prepare("UPDATE race_cards SET rows = '' WHERE race_id = ? AND rows = ?").bind(c.race_id, c.rows));
    else bad++;
  }
  stmts.push(setCursor(db, 'cards', q.results.at(-1)!.race_id, now));
  addMeta(u, await db.batch(stmts));
  return [`compact cards: ${stmts.length - 1} races${bad ? `, ${bad} not matching race_boats (kept)` : ''}`];
}

/** 競走成績の詰めた形を片付ける（K の番号が B と違う艇は k_motor_no・k_boat_no に入れてから） */
async function compactRecords(db: D1Database, nowMs: number, now: string, u: Usage): Promise<string[]> {
  const from = await cursor(db, 'records');
  const until = dayIdRange(addDays(jstDate(nowMs), -RECORD_KEEP_DAYS))[0];
  const q = await db
    .prepare("SELECT race_id, rows, payouts FROM race_records WHERE race_id > ? AND race_id < ? AND rows != '' ORDER BY race_id LIMIT ?")
    .bind(from, until, BATCH)
    .all<{ race_id: string; rows: string; payouts: string }>();
  addMeta(u, [q]);
  if (!q.results.length) return [];
  const ids = q.results.map((r) => r.race_id);
  const boats = await boatsOf(db, ids);
  const pays = (await db.prepare('SELECT race_id, bet_type, combo, payout, pop FROM race_payouts WHERE race_id IN (SELECT value FROM json_each(?))').bind(JSON.stringify(ids)).all<RecordPayout & { race_id: string }>()).results;
  const stmts: D1PreparedStatement[] = [];
  let done = 0;
  let bad = 0;
  for (const k of q.results) {
    const rows = unpackRows(k.rows);
    const patched: BoatRow[] = [];
    const fixes: D1PreparedStatement[] = [];
    for (const b of boats.get(k.race_id) ?? []) {
      const kr = rows.find((r) => r.boat === b.boat);
      const km = kr && kr.motor_no !== null && kr.motor_no !== b.motor_no ? kr.motor_no : null;
      const kb = kr && kr.boat_no !== null && kr.boat_no !== b.boat_no ? kr.boat_no : null;
      if (kr && (km !== b.k_motor_no || kb !== b.k_boat_no))
        fixes.push(db.prepare('UPDATE race_boats SET k_motor_no = ?, k_boat_no = ? WHERE race_id = ? AND boat = ?').bind(km, kb, k.race_id, b.boat));
      patched.push(kr ? { ...b, k_motor_no: km, k_boat_no: kb } : b);
    }
    const p = pays.filter((x) => x.race_id === k.race_id).map(({ bet_type, combo, payout, pop }) => ({ bet_type, combo, payout, pop }));
    if (sameRows(recordRowsFromBoats(patched), rows) && samePayouts(p, unpackPayouts(k.payouts))) {
      stmts.push(...fixes, db.prepare("UPDATE race_records SET rows = '', payouts = '' WHERE race_id = ? AND rows = ? AND payouts = ?").bind(k.race_id, k.rows, k.payouts));
      done++;
    } else bad++;
  }
  stmts.push(setCursor(db, 'records', ids.at(-1)!, now));
  addMeta(u, await db.batch(stmts));
  return [`compact records: ${done} races${bad ? `, ${bad} not matching race_boats/race_payouts (kept)` : ''}`];
}

/** 番組表と競走成績の詰めた形を、1回の定時処理で最大 BATCH 件ずつ片付ける */
export async function compactPacked(db: D1Database, nowMs: number, now: string, usage?: Usage): Promise<string[]> {
  const u = usage ?? (await loadUsage(db, nowMs));
  const log: string[] = [];
  // 1レースあたり、読み出しは艇・払戻金の数十行、書き込みは数行
  if (hasRoom(u, BATCH * 40, BATCH * 4)) log.push(...(await compactCards(db, nowMs, now, u)));
  if (hasRoom(u, BATCH * 40, BATCH * 10)) log.push(...(await compactRecords(db, nowMs, now, u)));
  if (!usage) await saveUsage(db, u, nowMs);
  return log;
}
