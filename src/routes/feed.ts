// 出走表の補足フィードの受け口（もちの夜間バッチ → アプリ）。2026-11-07 管理者決定（決定54）。docs/operator-api.md 4.5
// - 認証は送信専用トークン（fdk_...。運営トークンとは別）。管理者API POST /admin/feed-tokens で発行する
// - 1日1回、翌日分をまとめて送る。同じ日の再送は、その日の分を全部置き換える（冪等）
// - 締切を過ぎたレースは凍結する（再送でも書き換えない）
// - アプリは中身を計算しない。受け取ったレースの要素をそのまま保存する。観戦画面（/view）にだけ出し、参加AIには配らない（決定57）
import { Hono } from 'hono';
import type { Env } from '../env';
import { auditStatement } from '../db/repo';
import { dayIdRange } from '../db/boats';
import { sha256Hex } from '../lib/crypto';
import { ApiError, bearer, readJson } from '../lib/http';
import { addDays, isDate, jstDate, jstIso } from '../lib/time';
import { parseRaceId } from '../lib/venues';

/** 1回の送信の上限（本文のバイト数。1日分は整形なしで約200KB） */
export const FEED_MAX_BYTES = 2 * 1024 * 1024;
/** 1回の送信のレース数の上限（全24場×12R = 288） */
export const FEED_MAX_RACES = 288;
/** 1レース分の上限（JSON の文字数） */
export const FEED_MAX_RACE_CHARS = 32 * 1024;
export const FEED_SCHEMA_VERSIONS = [1];
/** 受け付ける日付: 当日〜3日先（日本時間） */
const DATE_WINDOW_AHEAD = 3;

type Vars = { tokenId: string; now: number };
export const feedApi = new Hono<{ Bindings: Env; Variables: Vars }>();

feedApi.use('*', async (c, next) => {
  const now = Date.now();
  const token = bearer(c);
  if (!token || !token.startsWith('fdk_')) throw new ApiError(401, 'unauthorized', '送信専用トークン（fdk_...）が必要です（Authorization: Bearer fdk_...）');
  const row = await c.env.DB.prepare('SELECT id FROM feed_tokens WHERE token_hash = ? AND revoked_at IS NULL').bind(await sha256Hex(token)).first<{ id: string }>();
  if (!row) throw new ApiError(401, 'unauthorized', '送信専用トークンが無効です');
  await c.env.DB.prepare('UPDATE feed_tokens SET last_seen_at = ? WHERE id = ?').bind(jstIso(now), row.id).run();
  c.set('tokenId', row.id);
  c.set('now', now);
  await next();
});

feedApi.post('/card-supplements', async (c) => {
  const now = c.get('now');
  const size = Number(c.req.header('Content-Length') ?? 0);
  if (size > FEED_MAX_BYTES) throw new ApiError(413, 'payload_too_large', `本文は ${FEED_MAX_BYTES} バイトまでです`);
  const b = await readJson(c);
  const date = b.date;
  if (!isDate(date)) throw new ApiError(400, 'bad_request', 'date は YYYY-MM-DD');
  const today = jstDate(now);
  if (date < today || date > addDays(today, DATE_WINDOW_AHEAD))
    throw new ApiError(400, 'bad_request', `date は ${today}〜${addDays(today, DATE_WINDOW_AHEAD)} の範囲で送ってください`);
  if (typeof b.schema_version !== 'number' || !FEED_SCHEMA_VERSIONS.includes(b.schema_version))
    throw new ApiError(400, 'bad_request', `schema_version は ${FEED_SCHEMA_VERSIONS.join(', ')} のどれか（項目を足すときは窓口で相談）`);
  if (!Array.isArray(b.races) || b.races.length === 0 || b.races.length > FEED_MAX_RACES) throw new ApiError(400, 'bad_request', `races は1〜${FEED_MAX_RACES}件の配列`);
  const text = (v: unknown, max: number) => (typeof v === 'string' ? v.slice(0, max) : null);

  // レースごとに確かめる。おかしいレースは保存せず rejected に理由を返す（ほかのレースは保存する）
  const rejected: { race_id: unknown; reason: string }[] = [];
  const races: { id: string; json: string }[] = [];
  const seen = new Set<string>();
  for (const r of b.races as unknown[]) {
    const race = r as Record<string, unknown>;
    const id = race?.race_id;
    const p = typeof id === 'string' ? parseRaceId(id) : null;
    if (!p) rejected.push({ race_id: id ?? null, reason: 'race_id は YYYYMMDD-JJ-RR' });
    else if (p.date !== date) rejected.push({ race_id: id, reason: 'race_id の日付が date と違います' });
    else if (seen.has(id as string)) rejected.push({ race_id: id, reason: '同じ race_id が2回あります' });
    else if (!Array.isArray(race.boats) || race.boats.length === 0 || race.boats.length > 6 || !race.boats.every((x) => Number.isInteger((x as { boat?: unknown })?.boat) && (x as { boat: number }).boat >= 1 && (x as { boat: number }).boat <= 6))
      rejected.push({ race_id: id, reason: 'boats は1〜6件で、各要素に boat（1〜6）が要ります' });
    else {
      const json = JSON.stringify(race);
      if (json.length > FEED_MAX_RACE_CHARS) rejected.push({ race_id: id, reason: `1レース分は ${FEED_MAX_RACE_CHARS} 文字まで` });
      else {
        seen.add(id as string);
        races.push({ id: id as string, json });
      }
    }
  }

  const db = c.env.DB;
  const [lo, hi] = dayIdRange(date);
  // 凍結: 締切を過ぎたレースは書き換えない（締切の正本はレースの表＝公式HTMLの出走表）
  const frozen = new Set((await db.prepare('SELECT id FROM races WHERE race_date = ? AND deadline_ms <= ?').bind(date, now).all<{ id: string }>()).results.map((x) => x.id));
  const store = races.filter((r) => !frozen.has(r.id));
  const receivedAt = jstIso(now);
  const stmts: D1PreparedStatement[] = [
    // 全置換: その日の凍結していない分を消してから入れ直す
    db.prepare('DELETE FROM card_supplements WHERE race_id BETWEEN ? AND ? AND race_id NOT IN (SELECT id FROM races WHERE race_date = ? AND deadline_ms <= ?)').bind(lo, hi, date, now),
    ...store.map((r) => db.prepare('INSERT INTO card_supplements (race_id, race_date, race_json, received_at) VALUES (?, ?, ?, ?) ON CONFLICT (race_id) DO UPDATE SET race_json = excluded.race_json, received_at = excluded.received_at').bind(r.id, date, r.json, receivedAt)),
    db
      .prepare(
        `INSERT INTO card_supplement_days (race_date, schema_version, generated_at, source, definition, races, received_at) VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (race_date) DO UPDATE SET schema_version = excluded.schema_version, generated_at = excluded.generated_at, source = excluded.source, definition = excluded.definition, races = excluded.races, received_at = excluded.received_at`,
      )
      .bind(date, b.schema_version, text(b.generated_at, 40), text(b.source, 200), text(b.definition, 2000), store.length, receivedAt),
    auditStatement(db, 'system', 'feed.card_supplements', date, { token_id: c.get('tokenId'), received: (b.races as unknown[]).length, stored: store.length, frozen: frozen.size, rejected: rejected.length }, now),
  ];
  for (let i = 0; i < stmts.length; i += 99) await db.batch(stmts.slice(i, i + 99));

  return c.json({
    date,
    schema_version: b.schema_version,
    received_races: (b.races as unknown[]).length,
    stored_races: store.length,
    frozen_races: [...frozen].filter((id) => seen.has(id)).sort(),
    rejected,
    received_at: receivedAt,
    note: '同じ date の再送は、凍結していないレースを全部置き換えます。保存した値は GET /feed/card-supplements?race_id= で確かめられます。このデータは観戦画面にだけ出し、参加AI向けの公開APIには出しません（決定57）',
  });
});

/** 受け取りの記録（送った側の確認用）。date: 日ごとの保存件数と受け取り時刻。race_id: そのレースの保存した要素そのまま（照合用） */
feedApi.get('/card-supplements', async (c) => {
  const raceId = c.req.query('race_id');
  if (raceId !== undefined) {
    if (!parseRaceId(raceId)) throw new ApiError(400, 'bad_request', 'race_id は YYYYMMDD-JJ-RR');
    const row = await c.env.DB.prepare('SELECT race_json, received_at FROM card_supplements WHERE race_id = ?').bind(raceId).first<{ race_json: string; received_at: string }>();
    return c.json({ race_id: raceId, stored: row ? { received_at: row.received_at, race: JSON.parse(row.race_json) } : null });
  }
  const date = c.req.query('date') ?? addDays(jstDate(c.get('now')), 1);
  if (!isDate(date)) throw new ApiError(400, 'bad_request', 'date は YYYY-MM-DD');
  const day = await c.env.DB.prepare('SELECT race_date, schema_version, generated_at, source, races, received_at FROM card_supplement_days WHERE race_date = ?').bind(date).first();
  return c.json({ date, received: day ?? null });
});
