// 観戦画面（ホーム画面に追加したアプリ）の通知の登録（認証不要）
//   GET  /push/key          通知の公開鍵（VAPID）。未設定なら 404（画面は通知のボタンを出さない）
//   POST /push/subscribe    { endpoint, keys: { p256dh, auth } }  ブラウザの PushSubscription をそのまま送る
//   POST /push/unsubscribe  { endpoint }
import { Hono } from 'hono';
import type { Env } from '../env';
import { ApiError, enforceRateLimit, readJson } from '../lib/http';
import { b64u, isPushEndpoint } from '../lib/webpush';

export const pushApi = new Hono<{ Bindings: Env }>();

/** 登録できる端末の数の上限（いたずらで大量に登録されて、送る数が膨らまないように） */
export const MAX_PUSH_SUBSCRIPTIONS = 5000;

const bad = (message: string) => new ApiError(400, 'validation_failed', message);

pushApi.get('/key', (c) => {
  if (!c.env.VAPID_PUBLIC_KEY || !c.env.VAPID_PRIVATE_KEY) throw new ApiError(404, 'not_found', '通知は準備中です');
  return c.json({ key: c.env.VAPID_PUBLIC_KEY });
});

pushApi.post('/subscribe', async (c) => {
  await enforceRateLimit(c);
  if (!c.env.VAPID_PUBLIC_KEY || !c.env.VAPID_PRIVATE_KEY) throw new ApiError(404, 'not_found', '通知は準備中です');
  const b = await readJson(c);
  const endpoint = b.endpoint;
  const keys = (b.keys ?? {}) as Record<string, unknown>;
  if (typeof endpoint !== 'string' || endpoint.length > 1000 || !isPushEndpoint(endpoint)) throw bad('endpoint はブラウザの通知サービスの URL にしてください');
  const { p256dh, auth } = keys;
  const valid = (v: unknown, len: number) => {
    try {
      return typeof v === 'string' && v.length < 200 && b64u.decode(v).length === len;
    } catch {
      return false;
    }
  };
  if (!valid(p256dh, 65) || !valid(auth, 16)) throw bad('keys.p256dh と keys.auth を送ってください');
  const db = c.env.DB;
  const now = Date.now();
  const exists = await db.prepare('SELECT 1 AS x FROM push_subscriptions WHERE endpoint = ?').bind(endpoint).first();
  if (!exists) {
    const n = (await db.prepare('SELECT COUNT(*) AS n FROM push_subscriptions').first<{ n: number }>())?.n ?? 0;
    if (n >= MAX_PUSH_SUBSCRIPTIONS) throw new ApiError(503, 'push_full', '通知の登録数が上限に達しています');
  }
  // 登録した時点より前の通知は送らない
  await db
    .prepare(
      `INSERT INTO push_subscriptions (endpoint, p256dh, auth, last_push_id, failures, created_ms, updated_ms)
       VALUES (?, ?, ?, (SELECT IFNULL(MAX(id), 0) FROM push_outbox), 0, ?, ?)
       ON CONFLICT (endpoint) DO UPDATE SET p256dh = excluded.p256dh, auth = excluded.auth, failures = 0, updated_ms = excluded.updated_ms`,
    )
    .bind(endpoint, p256dh, auth, now, now)
    .run();
  return c.json({ subscribed: true }, 201);
});

pushApi.post('/unsubscribe', async (c) => {
  await enforceRateLimit(c);
  const b = await readJson(c);
  if (typeof b.endpoint !== 'string') throw bad('endpoint を送ってください');
  await c.env.DB.prepare('DELETE FROM push_subscriptions WHERE endpoint = ?').bind(b.endpoint).run();
  return c.json({ subscribed: false });
});
