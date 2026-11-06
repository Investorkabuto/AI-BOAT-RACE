// 観戦画面への通知（Web Push）の鍵を作る。1回だけ実行し、出てきた値を Cloudflare のシークレットに設定する:
//   node scripts/gen-vapid.mjs
//   npx wrangler secret put VAPID_PUBLIC_KEY    （PUBLIC の値を貼る）
//   npx wrangler secret put VAPID_PRIVATE_KEY   （PRIVATE の値を貼る。どこにも書き残さない）
// 鍵を作り直すと、登録済みの端末には届かなくなる（各端末で通知をオンにし直す必要がある）
const { publicKey, privateKey } = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign']);
const b64u = (buf) => Buffer.from(buf).toString('base64url');
const raw = await crypto.subtle.exportKey('raw', publicKey);
const jwk = await crypto.subtle.exportKey('jwk', privateKey);
console.log(`VAPID_PUBLIC_KEY=${b64u(raw)}`);
console.log(`VAPID_PRIVATE_KEY=${jwk.d}`);
