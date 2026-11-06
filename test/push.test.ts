// 観戦画面への的中の通知（Web Push）: 暗号化・VAPID の署名、登録API、精算での積み込み、定時処理での送信
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { memoryD1 } from './helpers/d1';
import { ensureSchema } from '../src/db/migrate';
import { sha256Hex } from '../src/lib/crypto';
import { settleRace } from '../src/jobs/settlement';
import { combine, deliverPush } from '../src/jobs/push';
import { b64u, encryptPayload, isPushEndpoint, vapidAuthorization } from '../src/lib/webpush';
import type { RaceRow } from '../src/db/repo';

vi.mock('cloudflare:workers', () => ({ DurableObject: class {} }));
const { app } = await import('../src/index');

const enc = new TextEncoder();
const cat = (...p: Uint8Array[]) => {
  const o = new Uint8Array(p.reduce((n, x) => n + x.length, 0));
  let i = 0;
  for (const x of p) {
    o.set(x, i);
    i += x.length;
  }
  return o;
};
const hmac = async (k: Uint8Array, d: Uint8Array) =>
  new Uint8Array(await crypto.subtle.sign('HMAC', await crypto.subtle.importKey('raw', k, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']), d));
const hkdf = async (salt: Uint8Array, ikm: Uint8Array, info: Uint8Array, len: number) => (await hmac(await hmac(salt, ikm), cat(info, new Uint8Array([1])))).slice(0, len);

/** 受け取る側（ブラウザ）の鍵 */
async function receiver() {
  const kp = (await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits'])) as CryptoKeyPair;
  const pub = new Uint8Array((await crypto.subtle.exportKey('raw', kp.publicKey)) as ArrayBuffer);
  const auth = crypto.getRandomValues(new Uint8Array(16));
  return { kp, pub, auth, p256dh: b64u.encode(pub), authB64: b64u.encode(auth) };
}
/** RFC 8291 の手順で復号する（ブラウザがすること） */
async function decrypt(r: Awaited<ReturnType<typeof receiver>>, body: Uint8Array): Promise<string> {
  const salt = body.slice(0, 16);
  const idlen = body[20]!;
  const asPub = body.slice(21, 21 + idlen);
  const asKey = await crypto.subtle.importKey('raw', asPub, { name: 'ECDH', namedCurve: 'P-256' }, false, []);
  const shared = new Uint8Array(await crypto.subtle.deriveBits({ name: 'ECDH', public: asKey } as unknown as SubtleCryptoDeriveKeyAlgorithm, r.kp.privateKey, 256));
  const ikm = await hkdf(r.auth, shared, cat(enc.encode('WebPush: info\0'), r.pub, asPub), 32);
  const cek = await hkdf(salt, ikm, enc.encode('Content-Encoding: aes128gcm\0'), 16);
  const nonce = await hkdf(salt, ikm, enc.encode('Content-Encoding: nonce\0'), 12);
  const key = await crypto.subtle.importKey('raw', cek, 'AES-GCM', false, ['decrypt']);
  const plain = new Uint8Array(await crypto.subtle.decrypt({ name: 'AES-GCM', iv: nonce }, key, body.slice(21 + idlen)));
  expect(plain.at(-1)).toBe(2);
  return new TextDecoder().decode(plain.slice(0, -1));
}
async function vapidKeys() {
  const kp = (await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify'])) as CryptoKeyPair;
  const pub = b64u.encode((await crypto.subtle.exportKey('raw', kp.publicKey)) as ArrayBuffer);
  const d = ((await crypto.subtle.exportKey('jwk', kp.privateKey)) as JsonWebKey).d!;
  return { kp, publicKey: pub, privateKey: d, subject: 'https://example.com' };
}

describe('Web Push の暗号化と署名', () => {
  it('本文は受け取る側の鍵で復号できる', async () => {
    const r = await receiver();
    const body = await encryptPayload({ p256dh: r.p256dh, auth: r.authB64 }, '{"title":"🎯 桐生1R 的中"}');
    expect(await decrypt(r, body)).toBe('{"title":"🎯 桐生1R 的中"}');
  });
  it('VAPID の JWT は公開鍵で検証でき、宛先は通知サービスの origin', async () => {
    const k = await vapidKeys();
    const h = await vapidAuthorization('https://fcm.googleapis.com/fcm/send/abc', k, Date.UTC(2026, 10, 6));
    const m = /^vapid t=([^.]+)\.([^.]+)\.([^,]+), k=(.+)$/.exec(h)!;
    expect(m[4]).toBe(k.publicKey);
    expect(JSON.parse(new TextDecoder().decode(b64u.decode(m[2]!)))).toMatchObject({ aud: 'https://fcm.googleapis.com', sub: 'https://example.com' });
    const ok = await crypto.subtle.verify({ name: 'ECDSA', hash: 'SHA-256' }, k.kp.publicKey, b64u.decode(m[3]!), enc.encode(`${m[1]}.${m[2]}`));
    expect(ok).toBe(true);
  });
  it('送り先はブラウザの通知サービスだけ', () => {
    expect(isPushEndpoint('https://fcm.googleapis.com/fcm/send/x')).toBe(true);
    expect(isPushEndpoint('https://web.push.apple.com/abc')).toBe(true);
    expect(isPushEndpoint('https://updates.push.services.mozilla.com/wpush/v2/x')).toBe(true);
    expect(isPushEndpoint('http://fcm.googleapis.com/x')).toBe(false);
    expect(isPushEndpoint('https://evil.example.com/fcm.googleapis.com')).toBe(false);
    expect(isPushEndpoint('https://fcm.googleapis.com.evil.com/x')).toBe(false);
  });
});

describe('登録と送信', () => {
  let db: ReturnType<typeof memoryD1>;
  let keys: Awaited<ReturnType<typeof vapidKeys>>;
  const env = () => ({ DB: db, VAPID_PUBLIC_KEY: keys.publicKey, VAPID_PRIVATE_KEY: keys.privateKey });
  const req = (path: string, body?: unknown, e: object = env()) =>
    app.request(
      path,
      { method: body === undefined ? 'GET' : 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) },
      e,
    );

  beforeEach(async () => {
    db = memoryD1();
    await ensureSchema(db);
    keys = await vapidKeys();
    db.raw
      .prepare("INSERT INTO agents (id, realm, display_name, owner_name, api_key_hash, status, terms_agreed_at, created_at) VALUES ('agt_boo', 'live', 'ブー', 'o', ?, 'active', 'x', 'x')")
      .run(await sha256Hex('k'));
  });
  afterEach(() => vi.unstubAllGlobals());

  const settleHit = async (rno: number, now: number) => {
    const id = `20261106-01-${String(rno).padStart(2, '0')}`;
    db.raw.exec(`
      INSERT INTO races (id, race_date, jcd, rno, deadline_at, deadline_ms, status, updated_at) VALUES ('${id}', '2026-11-06', '01', ${rno}, 'x', 0, 'locked', 'x');
      INSERT INTO race_results (race_id, status, finish_json, refunded_boats_json, payouts_json, fetched_at) VALUES ('${id}', 'official', '[[1],[2],[3]]', '[]', '[{"bet_type":"tansho","combo":"1","payout":1250}]', 'x');
      INSERT INTO submissions (id, agent_id, realm, race_id, race_date, rationale, received_at, received_ms) VALUES ('s${rno}', 'agt_boo', 'live', '${id}', '2026-11-06', 'r', 'x', 0);
      INSERT INTO bets (id, submission_id, agent_id, realm, race_id, race_date, bet_type, combo, amount, status, received_ms, updated_at) VALUES ('b${rno}', 's${rno}', 'agt_boo', 'live', '${id}', '2026-11-06', 'tansho', '1', 1000, 'locked', 0, 'x');`);
    const race = db.raw.prepare(`SELECT * FROM races WHERE id = '${id}'`).get() as unknown as RaceRow;
    expect(await settleRace(db, race, now)).toBe(true);
  };

  it('鍵が未設定なら /push/key は 404（画面はボタンを出さない）', async () => {
    expect((await req('/push/key', undefined, { DB: db })).status).toBe(404);
    expect(await (await req('/push/key')).json()).toEqual({ key: keys.publicKey });
  });

  it('通知サービス以外の URL や、壊れた鍵は登録できない', async () => {
    const r = await receiver();
    expect((await req('/push/subscribe', { endpoint: 'https://example.com/x', keys: { p256dh: r.p256dh, auth: r.authB64 } })).status).toBe(400);
    expect((await req('/push/subscribe', { endpoint: 'https://fcm.googleapis.com/fcm/send/a', keys: { p256dh: 'abc', auth: r.authB64 } })).status).toBe(400);
  });

  it('的中が出たら、登録した端末に暗号化して送る。登録より前の通知は送らない。410 なら登録を消す', async () => {
    const now = Date.UTC(2026, 10, 6, 5);
    await settleHit(1, now); // 登録より前
    const r = await receiver();
    const endpoint = 'https://fcm.googleapis.com/fcm/send/dev1';
    expect((await req('/push/subscribe', { endpoint, keys: { p256dh: r.p256dh, auth: r.authB64 } })).status).toBe(201);

    const sent: { url: string; body: Uint8Array; headers: Headers }[] = [];
    let status = 201;
    vi.stubGlobal('fetch', async (url: string, init: RequestInit) => {
      sent.push({ url, body: init.body as Uint8Array, headers: new Headers(init.headers) });
      return new Response(null, { status });
    });
    expect(await deliverPush(env(), now)).toEqual([]);
    expect(sent).toHaveLength(0);

    await settleHit(2, now);
    expect(await deliverPush(env(), now)).toEqual(['push: sent 1, dropped 0']);
    expect(sent).toHaveLength(1);
    expect(sent[0]!.url).toBe(endpoint);
    expect(sent[0]!.headers.get('Content-Encoding')).toBe('aes128gcm');
    const payload = JSON.parse(await decrypt(r, sent[0]!.body));
    expect(payload).toEqual({ title: '🎯 桐生 2R 的中', body: 'ブー 払戻 12,500円（単勝 1）', url: '/race/20261106-01-02', tag: 'hit-20261106-01-02' });
    // 送り終えたので、次の定時処理では送らない
    await deliverPush(env(), now);
    expect(sent).toHaveLength(1);

    // 2レース分たまっていれば、1件にまとめる
    await settleHit(3, now);
    await settleHit(4, now);
    await deliverPush(env(), now);
    expect(sent).toHaveLength(2);
    expect(JSON.parse(await decrypt(r, sent[1]!.body)).title).toBe('🎯 2レースで的中');

    status = 410;
    await settleHit(5, now);
    expect(await deliverPush(env(), now)).toEqual(['push: sent 0, dropped 1']);
    expect(db.raw.prepare('SELECT COUNT(*) AS n FROM push_subscriptions').get()).toEqual({ n: 0 });
  });

  it('古くなった通知は送らない', async () => {
    const now = Date.UTC(2026, 10, 6, 5);
    const r = await receiver();
    await req('/push/subscribe', { endpoint: 'https://fcm.googleapis.com/fcm/send/dev1', keys: { p256dh: r.p256dh, auth: r.authB64 } });
    await settleHit(1, now);
    const f = vi.fn(async () => new Response(null, { status: 201 }));
    vi.stubGlobal('fetch', f);
    await deliverPush(env(), now + 2 * 60 * 60 * 1000);
    expect(f).not.toHaveBeenCalled();
  });

  it('まとめた通知は、各レースの先頭の行だけを並べる', () => {
    const p = combine([
      { title: '🎯 桐生1R 的中', body: 'A 払戻 1,000円（単勝 1）\nB 払戻 500円（複勝 2）', url: '/race/a', tag: 'a' },
      { title: '🎯 戸田2R 的中', body: 'C 払戻 2,000円（2連単 1-2）', url: '/race/b', tag: 'b' },
    ]);
    expect(p.body).toBe('桐生1R 的中：A 払戻 1,000円（単勝 1） ほか\n戸田2R 的中：C 払戻 2,000円（2連単 1-2）');
  });
});
