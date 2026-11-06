// Web Push（ホーム画面に追加した観戦画面への通知）。外部ライブラリを使わず、Workers の WebCrypto だけで作る。
//   本文の暗号化: RFC 8291（aes128gcm, RFC 8188）
//   送信元の証明: RFC 8292（VAPID。ES256 の JWT）
// 鍵は scripts/gen-vapid.mjs で作り、VAPID_PUBLIC_KEY / VAPID_PRIVATE_KEY（どちらも base64url）を wrangler secret で設定する

const enc = new TextEncoder();

export const b64u = {
  encode(buf: ArrayBuffer | Uint8Array): string {
    const bytes = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
    let s = '';
    for (const b of bytes) s += String.fromCharCode(b);
    return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  },
  decode(s: string): Uint8Array {
    const t = s.replace(/-/g, '+').replace(/_/g, '/');
    return Uint8Array.from(atob(t + '='.repeat((4 - (t.length % 4)) % 4)), (c) => c.charCodeAt(0));
  },
};

const concat = (...parts: Uint8Array[]) => {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let i = 0;
  for (const p of parts) {
    out.set(p, i);
    i += p.length;
  }
  return out;
};

async function hmac(key: Uint8Array, data: Uint8Array): Promise<Uint8Array> {
  const k = await crypto.subtle.importKey('raw', key, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return new Uint8Array(await crypto.subtle.sign('HMAC', k, data));
}
/** HKDF（出力は 32 バイト以下なので、1ブロックで足りる） */
async function hkdf(salt: Uint8Array, ikm: Uint8Array, info: Uint8Array, len: number): Promise<Uint8Array> {
  const prk = await hmac(salt, ikm);
  return (await hmac(prk, concat(info, new Uint8Array([1])))).slice(0, len);
}

export interface PushSubscriptionKeys {
  endpoint: string;
  p256dh: string;
  auth: string;
}

/** RFC 8291 の aes128gcm で本文を暗号化する。送る本文（バイト列）を返す */
export async function encryptPayload(sub: { p256dh: string; auth: string }, payload: string): Promise<Uint8Array> {
  const uaPublic = b64u.decode(sub.p256dh);
  const authSecret = b64u.decode(sub.auth);
  const local = (await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits'])) as CryptoKeyPair;
  const asPublic = new Uint8Array((await crypto.subtle.exportKey('raw', local.publicKey)) as ArrayBuffer);
  const uaKey = await crypto.subtle.importKey('raw', uaPublic, { name: 'ECDH', namedCurve: 'P-256' }, false, []);
  const shared = new Uint8Array(await crypto.subtle.deriveBits({ name: 'ECDH', public: uaKey } as unknown as SubtleCryptoDeriveKeyAlgorithm, local.privateKey, 256));
  const ikm = await hkdf(authSecret, shared, concat(enc.encode('WebPush: info\0'), uaPublic, asPublic), 32);
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const cek = await hkdf(salt, ikm, enc.encode('Content-Encoding: aes128gcm\0'), 16);
  const nonce = await hkdf(salt, ikm, enc.encode('Content-Encoding: nonce\0'), 12);
  const key = await crypto.subtle.importKey('raw', cek, 'AES-GCM', false, ['encrypt']);
  // 1レコードだけ。本文の後ろに区切り（0x02）を付ける
  const cipher = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv: nonce }, key, concat(enc.encode(payload), new Uint8Array([2]))));
  const header = new Uint8Array(16 + 4 + 1);
  header.set(salt, 0);
  new DataView(header.buffer).setUint32(16, 4096);
  header[20] = asPublic.length;
  return concat(header, asPublic, cipher);
}

/** VAPID の署名（Authorization ヘッダーの値） */
export async function vapidAuthorization(endpoint: string, keys: { publicKey: string; privateKey: string; subject: string }, nowMs: number): Promise<string> {
  const pub = b64u.decode(keys.publicKey);
  const jwk: JsonWebKey = { kty: 'EC', crv: 'P-256', x: b64u.encode(pub.slice(1, 33)), y: b64u.encode(pub.slice(33, 65)), d: keys.privateKey, ext: true };
  const key = await crypto.subtle.importKey('jwk', jwk, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign']);
  const head = b64u.encode(enc.encode(JSON.stringify({ typ: 'JWT', alg: 'ES256' })));
  const body = b64u.encode(enc.encode(JSON.stringify({ aud: new URL(endpoint).origin, exp: Math.floor(nowMs / 1000) + 12 * 3600, sub: keys.subject })));
  const sig = new Uint8Array(await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, key, enc.encode(`${head}.${body}`)));
  return `vapid t=${head}.${body}.${b64u.encode(sig)}, k=${keys.publicKey}`;
}

/** 通知の送り先として受け付けるホスト（ブラウザの通知サービスだけ。ほかの URL へは送らない） */
const PUSH_HOSTS = [/^fcm\.googleapis\.com$/, /^updates\.push\.services\.mozilla\.com$/, /^([a-z0-9-]+\.)*push\.apple\.com$/, /^([a-z0-9-]+\.)*notify\.windows\.com$/];
export function isPushEndpoint(url: string): boolean {
  try {
    const u = new URL(url);
    return u.protocol === 'https:' && !u.port && PUSH_HOSTS.some((re) => re.test(u.hostname));
  } catch {
    return false;
  }
}

/** 1件送る。戻り値は HTTP の状態（送れなければ 0） */
export async function sendPush(sub: PushSubscriptionKeys, payload: string, keys: { publicKey: string; privateKey: string; subject: string }, nowMs: number, ttlSec = 3600): Promise<number> {
  try {
    const r = await fetch(sub.endpoint, {
      method: 'POST',
      headers: {
        Authorization: await vapidAuthorization(sub.endpoint, keys, nowMs),
        'Content-Encoding': 'aes128gcm',
        'Content-Type': 'application/octet-stream',
        TTL: String(ttlSec),
        Urgency: 'normal',
      },
      body: await encryptPayload(sub, payload),
      signal: AbortSignal.timeout(10_000),
    });
    return r.status;
  } catch {
    return 0;
  }
}
