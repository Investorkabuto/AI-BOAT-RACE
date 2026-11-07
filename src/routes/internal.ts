// 出走表（締切時刻）と公式結果の取り込み（GitHub Actions から呼ぶ）。INGEST_TOKEN で認証する。
import { Hono } from 'hono';
import type { Env } from '../env';
import { BET_TYPES, normalizeCombo, SPECIAL_COMBO, type BetType, type Payout } from '../lib/bets';
import { ApiError, bearer, readJson, safeEqual } from '../lib/http';
import { sha256Hex } from '../lib/crypto';
import { addDays, isDate, jstDate, jstIso, jstToMs, parseHm } from '../lib/time';
import { isJcd, raceId } from '../lib/venues';
import { normalizeEntrants, normalizeStarts } from '../lib/entrants';
import { normalizeCard, packRacers } from '../lib/cards';
import { normalizeRecord, packPayouts, packRows, packUnsold } from '../lib/records';
import { boatsFromCard, boatsFromRecord, payoutsFromRecord } from '../db/boats';
import { fetchDispatchError, RESULT_WANTED_SQL, resultWantedArgs } from '../jobs/fetch-dispatch';
import { waiveFinesForCancelled } from '../jobs/settlement';
import { markAggDirty } from '../jobs/aggregate';

export const internalApi = new Hono<{ Bindings: Env }>();

internalApi.use('*', async (c, next) => {
  const t = bearer(c);
  if (!c.env.INGEST_TOKEN || !t || !safeEqual(t, c.env.INGEST_TOKEN)) throw new ApiError(401, 'unauthorized', 'invalid ingest token');
  await next();
});

interface RaceIn {
  jcd: string;
  rno: number;
  deadline: string; // 'HH:MM'
  race_name?: string;
}

/**
 * 出走表の取り込み（その日の場・レース・締切予定時刻）。何度送ってもよい。
 * 受付中（scheduled）のレースだけ締切を更新する。締切後のレースは変えない（公平のため）
 */
internalApi.put('/races', async (c) => {
  const b = await readJson(c);
  const date = b.race_date;
  if (!isDate(date)) throw new ApiError(400, 'bad_request', 'race_date must be YYYY-MM-DD');
  if (!Array.isArray(b.races)) throw new ApiError(400, 'bad_request', 'races must be an array');
  const now = Date.now();
  const stmts: D1PreparedStatement[] = [];
  for (const r of b.races as RaceIn[]) {
    const hm = typeof r.deadline === 'string' ? parseHm(r.deadline) : null;
    if (!isJcd(r.jcd) || !Number.isInteger(r.rno) || r.rno < 1 || r.rno > 12 || !hm) throw new ApiError(400, 'bad_request', `invalid race: ${JSON.stringify(r)}`);
    const ms = jstToMs(date, hm.hour, hm.minute);
    stmts.push(
      c.env.DB.prepare(
        `INSERT INTO races (id, race_date, jcd, rno, race_name, deadline_at, deadline_ms, status, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, 'scheduled', ?)
         ON CONFLICT (id) DO UPDATE SET race_name = excluded.race_name, deadline_at = excluded.deadline_at, deadline_ms = excluded.deadline_ms, updated_at = excluded.updated_at
         WHERE races.status = 'scheduled' AND races.deadline_ms > ?`,
      ).bind(raceId(date, r.jcd, r.rno), date, r.jcd, r.rno, typeof r.race_name === 'string' ? r.race_name.slice(0, 80) : null, jstIso(ms), ms, jstIso(now), now),
    );
  }
  if (stmts.length) await c.env.DB.batch(stmts);
  return c.json({ upserted: stmts.length });
});

/**
 * 出走表の選手の基本情報の取り込み（枠番・登録番号・氏名・級別・支部・年齢。要件定義 §6）。何度送ってもよい。
 * body: { race_date, races: [{ jcd, rno, entrants: [...] }] }。先に PUT /races で登録したレースだけ保存する
 */
internalApi.put('/entrants', async (c) => {
  const b = await readJson(c);
  const date = b.race_date;
  if (!isDate(date)) throw new ApiError(400, 'bad_request', 'race_date must be YYYY-MM-DD');
  if (!Array.isArray(b.races)) throw new ApiError(400, 'bad_request', 'races must be an array');
  const now = jstIso(Date.now());
  const stmts: D1PreparedStatement[] = [];
  const skipped: string[] = [];
  for (const r of b.races as { jcd: unknown; rno: unknown; entrants: unknown }[]) {
    if (!isJcd(r.jcd) || typeof r.rno !== 'number' || !Number.isInteger(r.rno) || r.rno < 1 || r.rno > 12) throw new ApiError(400, 'bad_request', `invalid race: ${JSON.stringify({ jcd: r.jcd, rno: r.rno })}`);
    const id = raceId(date, r.jcd, r.rno);
    const n = normalizeEntrants(r.entrants);
    if (!n.ok) {
      skipped.push(`${id}: ${n.reason}`);
      continue;
    }
    stmts.push(
      c.env.DB.prepare(
        `INSERT INTO race_entrants (race_id, entrants_json, updated_at) SELECT id, ?, ? FROM races WHERE id = ?
         ON CONFLICT (race_id) DO UPDATE SET entrants_json = excluded.entrants_json, updated_at = excluded.updated_at`,
      ).bind(JSON.stringify(n.entrants), now, id),
    );
  }
  const saved = stmts.length ? (await c.env.DB.batch(stmts)).reduce((s, r) => s + (r.meta.changes ?? 0), 0) : 0;
  return c.json({ saved, skipped });
});

/**
 * 番組表（Bファイル）の取り込み: 出走表（締切予定時刻つき）と基礎数値（要件定義 v1.0 系統1）。何度送ってもよい。
 * body: { race_date, races: [{ jcd, rno, race_name?, deadline, fixed_course?, distance?, racers: [...] }] }
 *
 * 正本の分担（2026-11-05 管理者決定）:
 *  - レースがまだ無ければ、Bファイルの締切で作る（前日の夕方から出走表を公開するため）。すでにあれば締切は変えない
 *    （当日の締切・欠場・選手交代の正本は公式HTML。PUT /races が上書きする）
 *  - 基礎数値は、受付中（締切前）のレースだけ保存する。版が変わったら旧版を race_card_history に残す（上書きで消さない）
 */
internalApi.put('/cards', async (c) => {
  const b = await readJson(c);
  const date = b.race_date;
  if (!isDate(date)) throw new ApiError(400, 'bad_request', 'race_date must be YYYY-MM-DD');
  if (!Array.isArray(b.races)) throw new ApiError(400, 'bad_request', 'races must be an array');
  const nowMs = Date.now();
  const now = jstIso(nowMs);
  const stmts: D1PreparedStatement[] = [];
  const skipped: string[] = [];
  const db = c.env.DB;
  for (const r of b.races as (RaceIn & { racers?: unknown; fixed_course?: unknown; distance?: unknown; day?: unknown; series_title?: unknown })[]) {
    const hm = typeof r.deadline === 'string' ? parseHm(r.deadline) : null;
    if (!isJcd(r.jcd) || !Number.isInteger(r.rno) || r.rno < 1 || r.rno > 12 || !hm) throw new ApiError(400, 'bad_request', `invalid race: ${JSON.stringify({ jcd: r.jcd, rno: r.rno, deadline: r.deadline })}`);
    const id = raceId(date, r.jcd, r.rno);
    const n = normalizeCard({ racers: r.racers, fixed_course: r.fixed_course, distance: r.distance });
    if (!n.ok) {
      skipped.push(`${id}: ${n.reason}`);
      continue;
    }
    const ms = jstToMs(date, hm.hour, hm.minute);
    const rows = packRacers(n.card.racers);
    const fixed = n.card.fixed_course ? 1 : 0;
    const { day, title } = seriesOf(r);
    stmts.push(
      db.prepare(
        "INSERT INTO races (id, race_date, jcd, rno, race_name, deadline_at, deadline_ms, status, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, 'scheduled', ?) ON CONFLICT (id) DO NOTHING",
      ).bind(id, date, r.jcd, r.rno, typeof r.race_name === 'string' ? r.race_name.slice(0, 80) : null, jstIso(ms), ms, now),
      // 版が変わるなら、今の版を履歴に残す（保存できる条件は下の更新と同じ）
      db.prepare(
        `INSERT OR IGNORE INTO race_card_history (race_id, fetched_at, fixed_course, distance, rows)
         SELECT c.race_id, c.fetched_at, c.fixed_course, c.distance, c.rows FROM race_cards c JOIN races r ON r.id = c.race_id
         WHERE c.race_id = ? AND r.status = 'scheduled' AND r.deadline_ms > ? AND (c.rows != ? OR c.fixed_course != ? OR IFNULL(c.distance, 0) != ?)`,
      ).bind(id, nowMs, rows, fixed, n.card.distance ?? 0),
      db.prepare(
        `INSERT INTO race_cards (race_id, fixed_course, distance, rows, fetched_at, day, series_title)
         SELECT id, ?, ?, ?, ?, ?, ? FROM races WHERE id = ? AND status = 'scheduled' AND deadline_ms > ?
         ON CONFLICT (race_id) DO UPDATE SET fixed_course = excluded.fixed_course, distance = excluded.distance, rows = excluded.rows, fetched_at = excluded.fetched_at,
           day = excluded.day, series_title = excluded.series_title
         WHERE race_cards.rows != excluded.rows OR race_cards.fixed_course != excluded.fixed_course OR IFNULL(race_cards.distance, 0) != IFNULL(excluded.distance, 0)
           OR race_cards.day IS NULL OR race_cards.series_title IS NULL`,
      ).bind(fixed, n.card.distance, rows, now, day, title, id, nowMs),
      // 検索用の表（race_boats）にも同じ値を書く。今回この版を保存したときだけ
      boatsFromCard(db, { id, date, jcd: r.jcd, rno: r.rno }, n.card.racers, { sql: 'EXISTS (SELECT 1 FROM race_cards WHERE race_id = ? AND fetched_at = ?)', args: [id, now] }),
    );
  }
  // D1 の batch は100文までなので、レース4文ずつ（24レース）の区切りで流す
  let created = 0;
  let saved = 0;
  for (let i = 0; i < stmts.length; i += 96) {
    const res = await db.batch(stmts.slice(i, i + 96));
    res.forEach((x, k) => {
      const kind = (i + k) % 4; // 0=レースの作成 1=履歴 2=基礎数値の保存 3=検索用の表
      if (kind === 0) created += x.meta.changes ?? 0;
      if (kind === 2) saved += x.meta.changes ?? 0;
    });
  }
  return c.json({ created_races: created, saved, unchanged_or_closed: stmts.length / 4 - saved, skipped });
});

/** 番組表（B）の場ごとの値（第何日・節の名前）。不正なら null */
function seriesOf(r: { day?: unknown; series_title?: unknown }): { day: number | null; title: string | null } {
  const day = typeof r.day === 'number' && Number.isInteger(r.day) && r.day >= 1 && r.day <= 12 ? r.day : null;
  const title = typeof r.series_title === 'string' && r.series_title.trim() ? r.series_title.normalize('NFKC').trim().slice(0, 80) : null;
  return { day, title };
}

/** 取り込み済みのBファイルのハッシュ（同じなら取り直さない。全レースの送信が済んだ後にだけ記録する） */
internalApi.get('/card-state', async (c) => {
  const date = c.req.query('date');
  if (!isDate(date)) throw new ApiError(400, 'bad_request', 'date must be YYYY-MM-DD');
  const r = await c.env.DB.prepare('SELECT value, updated_at FROM app_state WHERE key = ?').bind(`cards:${date}`).first<{ value: string; updated_at: string }>();
  return c.json({ race_date: date, sha256: r?.value ?? null, updated_at: r?.updated_at ?? null });
});

internalApi.put('/card-state', async (c) => {
  const b = await readJson(c);
  if (!isDate(b.race_date)) throw new ApiError(400, 'bad_request', 'race_date must be YYYY-MM-DD');
  if (typeof b.sha256 !== 'string' || !/^[0-9a-f]{64}$/.test(b.sha256)) throw new ApiError(400, 'bad_request', 'sha256 must be 64 hex chars');
  await c.env.DB.prepare('INSERT INTO app_state (key, value, updated_at) VALUES (?, ?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at')
    .bind(`cards:${b.race_date}`, b.sha256, jstIso(Date.now())).run();
  return c.json({ ok: true });
});

/**
 * 競走成績（Kファイル）の取り込み: 着順・展示タイム・進入コース・スタートタイミング・天候・風・波・決まり手・払戻金（要件定義 v1.0 系統3）。
 * 何度送ってもよい。body: { race_date, races: [{ jcd, rno, weather, wind_dir, wind_m, wave_cm, kimarite, rows, payouts, unsold }] }
 *
 * 保存するのは、すでにあるレースで、締切を過ぎたものだけ（レース前に結果が入らないように）。内容が変わったときだけ更新し、
 * 旧版は race_record_history に残す。ここでは精算に使わない（精算は公式HTMLの結果。照合と暫定精算は別の工程）
 */
internalApi.put('/records', async (c) => {
  const b = await readJson(c);
  const date = b.race_date;
  if (!isDate(date)) throw new ApiError(400, 'bad_request', 'race_date must be YYYY-MM-DD');
  if (!Array.isArray(b.races)) throw new ApiError(400, 'bad_request', 'races must be an array');
  const nowMs = Date.now();
  const now = jstIso(nowMs);
  const db = c.env.DB;
  const stmts: D1PreparedStatement[] = [];
  const skipped: string[] = [];
  for (const r of b.races as Record<string, unknown>[]) {
    if (!isJcd(r.jcd) || typeof r.rno !== 'number' || !Number.isInteger(r.rno) || r.rno < 1 || r.rno > 12) throw new ApiError(400, 'bad_request', `invalid race: ${JSON.stringify({ jcd: r.jcd, rno: r.rno })}`);
    const id = raceId(date, r.jcd, r.rno);
    const n = normalizeRecord(r);
    if (!n.ok) {
      skipped.push(`${id}: ${n.reason}`);
      continue;
    }
    const v = n.record;
    const rows = packRows(v.rows);
    const payouts = packPayouts(v.payouts);
    const unsold = packUnsold(v.unsold);
    const same = `race_records.rows = ? AND race_records.payouts = ? AND race_records.unsold = ? AND IFNULL(race_records.weather, '') = ? AND IFNULL(race_records.wind_dir, '') = ?
      AND IFNULL(race_records.wind_m, -1) = ? AND IFNULL(race_records.wave_cm, -1) = ? AND IFNULL(race_records.kimarite, '') = ?`;
    const sameArgs = [rows, payouts, unsold, v.weather ?? '', v.wind_dir ?? '', v.wind_m ?? -1, v.wave_cm ?? -1, v.kimarite ?? ''];
    stmts.push(
      // 内容が変わるなら、今の版を履歴に残す（保存できる条件は下の更新と同じ）
      db.prepare(
        `INSERT OR IGNORE INTO race_record_history (race_id, fetched_at, weather, wind_dir, wind_m, wave_cm, kimarite, rows, payouts, unsold)
         SELECT race_id, fetched_at, weather, wind_dir, wind_m, wave_cm, kimarite, rows, payouts, unsold FROM race_records
         WHERE race_id = ? AND NOT (${same.replaceAll('race_records.', '')})`,
      ).bind(id, ...sameArgs),
      db.prepare(
        `INSERT INTO race_records (race_id, weather, wind_dir, wind_m, wave_cm, kimarite, rows, payouts, unsold, fetched_at)
         SELECT id, ?, ?, ?, ?, ?, ?, ?, ?, ? FROM races WHERE id = ? AND deadline_ms <= ?
         ON CONFLICT (race_id) DO UPDATE SET weather = excluded.weather, wind_dir = excluded.wind_dir, wind_m = excluded.wind_m, wave_cm = excluded.wave_cm,
           kimarite = excluded.kimarite, rows = excluded.rows, payouts = excluded.payouts, unsold = excluded.unsold, fetched_at = excluded.fetched_at
         WHERE NOT (${same})`,
      ).bind(v.weather, v.wind_dir, v.wind_m, v.wave_cm, v.kimarite, rows, payouts, unsold, now, id, nowMs, ...sameArgs),
    );
    // 検索用の表（race_boats の K の列、race_payouts）にも書く。今回この版を保存したときだけ
    const written = { sql: 'EXISTS (SELECT 1 FROM race_records WHERE race_id = ? AND fetched_at = ?)', args: [id, now] };
    stmts.push(boatsFromRecord(db, { id, date, jcd: r.jcd, rno: r.rno }, v.rows, written), ...payoutsFromRecord(db, { id, date, jcd: r.jcd }, v.payouts, written));
  }
  // D1 の batch は100文までなので、レース5文ずつ（19レース）の区切りで流す
  let saved = 0;
  for (let i = 0; i < stmts.length; i += 95) {
    const res = await db.batch(stmts.slice(i, i + 95));
    res.forEach((x, k) => {
      if ((i + k) % 5 === 1) saved += x.meta.changes ?? 0;
    });
  }
  if (saved) await markAggDirty(db, [date], nowMs); // 事前集計のその月を作り直す（v1.3 決定50）
  return c.json({ saved, unchanged_or_not_ready: stmts.length / 5 - saved, skipped });
});

/** 取り込み済みのKファイルのハッシュ（同じなら取り直さない。全レースの送信が済んだ後にだけ記録する） */
internalApi.get('/record-state', async (c) => {
  const date = c.req.query('date');
  if (!isDate(date)) throw new ApiError(400, 'bad_request', 'date must be YYYY-MM-DD');
  const r = await c.env.DB.prepare('SELECT value, updated_at FROM app_state WHERE key = ?').bind(`records:${date}`).first<{ value: string; updated_at: string }>();
  return c.json({ race_date: date, sha256: r?.value ?? null, updated_at: r?.updated_at ?? null });
});

internalApi.put('/record-state', async (c) => {
  const b = await readJson(c);
  if (!isDate(b.race_date)) throw new ApiError(400, 'bad_request', 'race_date must be YYYY-MM-DD');
  if (typeof b.sha256 !== 'string' || !/^[0-9a-f]{64}$/.test(b.sha256)) throw new ApiError(400, 'bad_request', 'sha256 must be 64 hex chars');
  await c.env.DB.prepare('INSERT INTO app_state (key, value, updated_at) VALUES (?, ?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at')
    .bind(`records:${b.race_date}`, b.sha256, jstIso(Date.now())).run();
  return c.json({ ok: true });
});

/** 過去分の取り込みは、この日数より前の日付だけ（前日分は当日の取得の流れ［HTMLの結果・夜のK］に任せる） */
export const HISTORY_MIN_AGE_DAYS = 2;

/**
 * 過去分の取り込み（要件定義 v1.1・v1.2）: 番組表（B）と競走成績（K）から、過去のレースと、その基礎数値・成績・結果を作る。何度送ってもよい。
 * body: { race_date, races: [{ jcd, rno, race_name?, deadline, card?: {fixed_course, distance, racers}, record?: {...}, result?: {status, finish, refunded_boats, payouts, start} }] }
 *
 * - すでにある行は変えない（どの表も「無ければ作る」だけ）。当日の取得で入った値（公式HTMLの結果など）を優先する
 * - 基礎数値と競走成績は race_boats・race_payouts にだけ書く。race_cards・race_records はレース単位の値だけで、詰めた形（rows・payouts）は空（v1.3 決定51）
 * - 結果とスタート情報は、精算済み（舟券なし）か中止のレースにだけ入れる。精算待ちのレースに K 由来の結果が入って精算が動くことはない
 * - 日付は HISTORY_MIN_AGE_DAYS 日より前だけ受け付ける
 */
internalApi.put('/history', async (c) => {
  const b = await readJson(c);
  const date = b.race_date;
  if (!isDate(date)) throw new ApiError(400, 'bad_request', 'race_date must be YYYY-MM-DD');
  const nowMs = Date.now();
  if (date > addDays(jstDate(nowMs), -HISTORY_MIN_AGE_DAYS)) throw new ApiError(400, 'bad_request', `history accepts dates up to ${HISTORY_MIN_AGE_DAYS} days ago`);
  if (!Array.isArray(b.races)) throw new ApiError(400, 'bad_request', 'races must be an array');
  const now = jstIso(nowMs);
  const db = c.env.DB;
  const stmts: D1PreparedStatement[] = [];
  const kinds: ('race' | 'card' | 'record' | 'result' | 'start' | 'boats' | 'payouts')[] = [];
  const skipped: string[] = [];
  const push = (kind: (typeof kinds)[number], s: D1PreparedStatement) => {
    stmts.push(s);
    kinds.push(kind);
  };
  for (const r of b.races as Record<string, unknown>[]) {
    const hm = typeof r.deadline === 'string' ? parseHm(r.deadline) : null;
    if (!isJcd(r.jcd) || typeof r.rno !== 'number' || !Number.isInteger(r.rno) || r.rno < 1 || r.rno > 12 || !hm) throw new ApiError(400, 'bad_request', `invalid race: ${JSON.stringify({ jcd: r.jcd, rno: r.rno, deadline: r.deadline })}`);
    const id = raceId(date, r.jcd, r.rno);
    const ms = jstToMs(date, hm.hour, hm.minute);
    let result: { status: 'official' | 'cancelled'; v: { finish: number[][]; refunded: number[]; payouts: Payout[]; unsold: BetType[] }; start: unknown } | null = null;
    if (r.result) {
      const v = validateResult({ ...(r.result as ResultIn), race_id: id });
      if (typeof v === 'string') skipped.push(`${id}: result ${v}`);
      else result = { status: (r.result as ResultIn).status, v, start: (r.result as ResultIn).start };
    }
    push(
      'race',
      db.prepare(
        `INSERT INTO races (id, race_date, jcd, rno, race_name, deadline_at, deadline_ms, status, settled_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (id) DO NOTHING`,
      ).bind(id, date, r.jcd, r.rno, typeof r.race_name === 'string' ? r.race_name.slice(0, 80) : null, jstIso(ms), ms, result?.status === 'cancelled' ? 'cancelled' : 'settled', now, now),
    );
    if (r.card) {
      const card = r.card as Record<string, unknown>;
      const n = normalizeCard({ racers: card.racers, fixed_course: card.fixed_course, distance: card.distance });
      if (!n.ok) skipped.push(`${id}: card ${n.reason}`);
      else
        push(
          'card',
          db.prepare(`INSERT INTO race_cards (race_id, fixed_course, distance, rows, fetched_at, day, series_title) SELECT id, ?, ?, ?, ?, ?, ? FROM races WHERE id = ?
             ON CONFLICT (race_id) DO UPDATE SET day = IFNULL(race_cards.day, excluded.day), series_title = IFNULL(race_cards.series_title, excluded.series_title)
             WHERE race_cards.day IS NULL OR race_cards.series_title IS NULL`).bind(
            n.card.fixed_course ? 1 : 0, n.card.distance, '', now, seriesOf(card).day, seriesOf(card).title, id,
          ),
        );
      if (n.ok) push('boats', boatsFromCard(db, { id, date, jcd: r.jcd, rno: r.rno }, n.card.racers, { sql: 'EXISTS (SELECT 1 FROM races WHERE id = ?)', args: [id] }));
    }
    if (r.record) {
      const n = normalizeRecord(r.record as Record<string, unknown>);
      if (!n.ok) skipped.push(`${id}: record ${n.reason}`);
      else {
        const v = n.record;
        push(
          'record',
          db.prepare(
            `INSERT OR IGNORE INTO race_records (race_id, weather, wind_dir, wind_m, wave_cm, kimarite, rows, payouts, unsold, fetched_at)
             SELECT id, ?, ?, ?, ?, ?, ?, ?, ?, ? FROM races WHERE id = ? AND deadline_ms <= ?`,
          ).bind(v.weather, v.wind_dir, v.wind_m, v.wave_cm, v.kimarite, '', '', packUnsold(v.unsold), now, id, nowMs),
        );
        const past = { sql: 'EXISTS (SELECT 1 FROM races WHERE id = ? AND deadline_ms <= ?)', args: [id, nowMs] };
        push('boats', boatsFromRecord(db, { id, date, jcd: r.jcd, rno: r.rno }, v.rows, past));
        for (const s of payoutsFromRecord(db, { id, date, jcd: r.jcd }, v.payouts, past)) push('payouts', s);
      }
    }
    if (result) {
      const done = "SELECT id FROM races WHERE id = ? AND status IN ('settled', 'cancelled')";
      push(
        'result',
        db.prepare(`INSERT OR IGNORE INTO race_results (race_id, status, finish_json, refunded_boats_json, payouts_json, unsold_json, fetched_at) SELECT id, ?, ?, ?, ?, ?, ? FROM (${done})`).bind(
          result.status, JSON.stringify(result.v.finish), JSON.stringify(result.v.refunded), JSON.stringify(result.v.payouts), JSON.stringify(result.v.unsold), now, id,
        ),
      );
      // 中止・不成立のレースは、すでに精算済み（舟券なし）で作られていても中止にする（過去分の取り直しで分かったとき）
      if (result.status === 'cancelled')
        push('race', db.prepare("UPDATE races SET status = 'cancelled', updated_at = ? WHERE id = ? AND status = 'settled' AND NOT EXISTS (SELECT 1 FROM bets WHERE realm IN ('live', 'sandbox') AND race_id = ?)").bind(now, id, id)); // realm を付けて索引（bets_race）で引く
      const starts = result.status === 'official' ? normalizeStarts(result.start) : null;
      if (starts) push('start', db.prepare(`INSERT OR IGNORE INTO race_starts (race_id, starts_json, updated_at) SELECT id, ?, ? FROM (${done})`).bind(JSON.stringify(starts), now, id));
    }
  }
  const count = { race: 0, card: 0, record: 0, result: 0, start: 0, boats: 0, payouts: 0 };
  for (let i = 0; i < stmts.length; i += 99) {
    const res = await db.batch(stmts.slice(i, i + 99));
    res.forEach((x, k) => (count[kinds[i + k]!] += x.meta.changes ?? 0));
  }
  if (count.boats || count.payouts) await markAggDirty(db, [date], nowMs); // 事前集計のその月を作り直す（v1.3 決定50）
  return c.json({ created: { races: count.race, cards: count.card, records: count.record, results: count.result, starts: count.start, boat_rows: count.boats }, skipped });
});

/** 過去分の取り込みの進み具合（取り込み済みの日付）。key = history:{date}、value = 取り込みの要約 */
internalApi.get('/history-done', async (c) => {
  const from = c.req.query('from');
  const to = c.req.query('to');
  if (!isDate(from) || !isDate(to)) throw new ApiError(400, 'bad_request', 'from/to must be YYYY-MM-DD');
  const r = await c.env.DB.prepare("SELECT key, value, updated_at FROM app_state WHERE key >= ? AND key <= ? ORDER BY key DESC").bind(`history:${from}`, `history:${to}`).all<{ key: string; value: string; updated_at: string }>();
  return c.json({ done: r.results.map((x) => ({ date: x.key.slice(8), note: x.value, updated_at: x.updated_at })) });
});

internalApi.put('/history-state', async (c) => {
  const b = await readJson(c);
  if (!isDate(b.race_date)) throw new ApiError(400, 'bad_request', 'race_date must be YYYY-MM-DD');
  const note = typeof b.note === 'string' ? b.note.slice(0, 500) : '';
  await c.env.DB.prepare('INSERT INTO app_state (key, value, updated_at) VALUES (?, ?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at')
    .bind(`history:${b.race_date}`, note, jstIso(Date.now())).run();
  return c.json({ ok: true });
});

/** 選手の基本情報がまだ無い、その日の受付中のレース（朝の2回目の取り込みで、取りこぼしだけを取り直すため） */
internalApi.get('/entrant-requests', async (c) => {
  const date = c.req.query('date');
  if (!isDate(date)) throw new ApiError(400, 'bad_request', 'date must be YYYY-MM-DD');
  const r = await c.env.DB.prepare(
    `SELECT r.id, r.jcd, r.rno FROM races r LEFT JOIN race_entrants e ON e.race_id = r.id
     WHERE r.race_date = ? AND r.status = 'scheduled' AND e.race_id IS NULL ORDER BY r.jcd, r.rno`,
  ).bind(date).all<{ id: string; jcd: string; rno: number }>();
  return c.json({ requests: r.results });
});

/**
 * 秘密情報の設定の確認（値そのものは返さない）。管理者トークンが合わないときの調査用。
 * 返すのは、設定の有無・文字数・前後の空白の有無・SHA-256 の先頭8文字だけ
 */
internalApi.get('/config-check', async (c) => {
  const describe = async (v: string | undefined) =>
    v === undefined
      ? { set: false }
      : { set: true, length: v.length, has_surrounding_whitespace: v !== v.trim(), sha256_prefix: (await sha256Hex(v.trim())).slice(0, 8) };
  const dispatched = (
    await c.env.DB.prepare("SELECT key, updated_at FROM app_state WHERE key >= 'fetch:' AND key < 'fetch;' AND key != 'fetch:dispatch_error' ORDER BY updated_at DESC LIMIT 5").all<{ key: string; updated_at: string }>()
  ).results;
  return c.json({
    ADMIN_TOKEN: await describe(c.env.ADMIN_TOKEN),
    GITHUB_TOKEN: { set: !!c.env.GITHUB_TOKEN },
    GITHUB_REPO: c.env.GITHUB_REPO ?? null,
    fetch_dispatch: { ref: c.env.FETCH_WORKFLOW_REF || 'main', last_error: await fetchDispatchError(c.env.DB), recent: dispatched },
  });
});

/** 公式結果が必要なレース（締切後で結果が未取得。舟券のあるレースと、当日の全レース） */
internalApi.get('/result-requests', async (c) => {
  // ?date=YYYY-MM-DD&all=1: その日の締切を過ぎた全レースのうち、結果が未保存のもの（毎朝の全レースの結果の保存用。要件定義 §6）
  const date = c.req.query('date');
  if (c.req.query('all') === '1') {
    if (!isDate(date)) throw new ApiError(400, 'bad_request', 'date must be YYYY-MM-DD');
    const r = await c.env.DB.prepare(
      'SELECT r.id, r.race_date, r.jcd, r.rno, r.deadline_at FROM races r WHERE r.race_date = ? AND r.deadline_ms <= ? AND NOT EXISTS (SELECT 1 FROM race_results x WHERE x.race_id = r.id) ORDER BY r.deadline_ms',
    ).bind(date, Date.now()).all();
    return c.json({ requests: r.results });
  }
  // 精算待ち（舟券あり）のレースと、当日の締切後のレース（舟券の有無を問わない。観戦画面で当日中に結果を出すため）
  const r = await c.env.DB.prepare(`SELECT id, race_date, jcd, rno, deadline_at FROM races WHERE ${RESULT_WANTED_SQL} ORDER BY deadline_ms`)
    .bind(...resultWantedArgs(Date.now()))
    .all();
  return c.json({ requests: r.results });
});

export interface ResultIn {
  race_id: string;
  status: 'official' | 'cancelled';
  finish?: unknown;
  refunded_boats?: unknown;
  payouts?: { bet_type: string; combo: string; payout: number }[];
  unsold?: unknown; // 不成立の券種（その券種の舟券は全額返還）
  start?: unknown; // スタート情報 [{course, boat, st}]（任意。解析できなければ省く）
}

/** 取り込む結果1件を検証して正規化する。誤りがあれば理由の文字列を返す */
export function validateResult(r: ResultIn): { finish: number[][]; refunded: number[]; payouts: Payout[]; unsold: BetType[] } | string {
  if (!r || typeof r.race_id !== 'string' || (r.status !== 'official' && r.status !== 'cancelled')) return 'race_id/status';
  const finish = (Array.isArray(r.finish) ? r.finish : []).map((x) => (Array.isArray(x) ? x : [x])) as number[][];
  const refunded = (Array.isArray(r.refunded_boats) ? r.refunded_boats : []) as number[];
  if ([...finish.flat(), ...refunded].some((x) => !Number.isInteger(x) || x < 1 || x > 6)) return 'boat number';
  const payouts: Payout[] = [];
  for (const p of r.payouts ?? []) {
    if (!(BET_TYPES as readonly string[]).includes(p.bet_type) || !(typeof p.payout === 'number' && p.payout >= 0)) return 'payout';
    const combo = p.combo === SPECIAL_COMBO ? SPECIAL_COMBO : normalizeCombo(p.bet_type as BetType, p.combo);
    if (!combo) return `combo ${p.combo}`;
    payouts.push({ bet_type: p.bet_type as BetType, combo, payout: p.payout });
  }
  const unsold: BetType[] = [];
  for (const u of Array.isArray(r.unsold) ? r.unsold : []) {
    if (!(BET_TYPES as readonly string[]).includes(u as string)) return `unsold ${JSON.stringify(u)}`;
    if (!unsold.includes(u as BetType)) unsold.push(u as BetType);
  }
  if (unsold.some((u) => payouts.some((p) => p.bet_type === u))) return 'unsold bet type has payouts';
  // 一部の券種が不成立のレースは、完走が少なく着順が2艇そろわないことがある（2026-11-07 戸田7R は単勝だけ成立で着順の表なし）
  if (r.status === 'official' && (payouts.length === 0 || (finish.length < 2 && unsold.length === 0))) return 'official result needs finish and payouts';
  return { finish, refunded, payouts, unsold };
}

/**
 * 公式結果の書き込み。精算待ちのレースは上書きできる。精算済み（舟券がなく締切で精算済みになったレースを含む）は、
 * 結果が未保存のときだけ保存する（毎朝の全レースの結果の保存。精算には使わない）
 */
internalApi.post('/results', async (c) => {
  const b = await readJson(c);
  if (!Array.isArray(b.results)) throw new ApiError(400, 'bad_request', 'results must be an array');
  const now = jstIso(Date.now());
  const stmts: D1PreparedStatement[] = [];
  // 1レースの不正な結果（レース直後で着順が未掲載など）で全体を拒否しない。そのレースだけ保存せず rejected で返し、次の取得で取り直す
  const rejected: { race_id: unknown; reason: string }[] = [];
  const accepted: ResultIn[] = [];
  let startsCount = 0;
  for (const r of b.results as ResultIn[]) {
    const v = validateResult(r);
    if (typeof v === 'string') {
      rejected.push({ race_id: r?.race_id, reason: v });
      continue;
    }
    accepted.push(r);
    stmts.push(
      c.env.DB.prepare(
        `INSERT INTO race_results (race_id, status, finish_json, refunded_boats_json, payouts_json, unsold_json, fetched_at)
         SELECT ?, ?, ?, ?, ?, ?, ? WHERE EXISTS (SELECT 1 FROM races WHERE id = ?)
         ON CONFLICT (race_id) DO UPDATE SET status = excluded.status, finish_json = excluded.finish_json, refunded_boats_json = excluded.refunded_boats_json,
           payouts_json = excluded.payouts_json, unsold_json = excluded.unsold_json, fetched_at = excluded.fetched_at
         WHERE EXISTS (SELECT 1 FROM races WHERE id = excluded.race_id AND status IN ('scheduled', 'locked'))`,
      ).bind(r.race_id, r.status, JSON.stringify(v.finish), JSON.stringify(v.refunded), JSON.stringify(v.payouts), JSON.stringify(v.unsold), now, r.race_id),
    );
    const starts = r.status === 'official' ? normalizeStarts(r.start) : null;
    if (starts) {
      stmts.push(
        c.env.DB.prepare(
          `INSERT INTO race_starts (race_id, starts_json, updated_at) SELECT id, ?, ? FROM races WHERE id = ?
           ON CONFLICT (race_id) DO UPDATE SET starts_json = excluded.starts_json, updated_at = excluded.updated_at`,
        ).bind(JSON.stringify(starts), now, r.race_id),
      );
      startsCount++;
    }
  }
  if (stmts.length) await c.env.DB.batch(stmts);
  const cancelled = accepted.filter((r) => r.status === 'cancelled').map((r) => r.race_id);
  const waived = cancelled.length ? await waiveFinesForCancelled(c.env.DB, cancelled, Date.now()) : 0;
  if (rejected.length) console.log(`results rejected: ${JSON.stringify(rejected).slice(0, 1000)}`);
  return c.json({ upserted: accepted.length, starts: startsCount, fines_waived: waived, rejected });
});
