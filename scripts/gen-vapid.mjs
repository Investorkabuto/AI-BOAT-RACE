// 観戦画面への通知（Web Push）の鍵を作る。1回だけ実行する。
//   node scripts/gen-vapid.mjs --put   鍵を作り、そのまま Cloudflare のシークレットに登録する（秘密鍵は画面に出さない。先に npx wrangler login）
//   node scripts/gen-vapid.mjs         鍵を表示するだけ（手で npx wrangler secret put VAPID_PUBLIC_KEY / VAPID_PRIVATE_KEY に貼る）
// 鍵を作り直すと、登録済みの端末には届かなくなる（各端末で通知をオンにし直す必要がある）
import { spawnSync } from 'node:child_process';

const { publicKey, privateKey } = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign']);
const pub = Buffer.from(await crypto.subtle.exportKey('raw', publicKey)).toString('base64url');
const priv = (await crypto.subtle.exportKey('jwk', privateKey)).d;

if (!process.argv.includes('--put')) {
  console.log(`VAPID_PUBLIC_KEY=${pub}`);
  console.log(`VAPID_PRIVATE_KEY=${priv}`);
  process.exit(0);
}

const put = (name, value) => {
  const r = spawnSync('npx', ['wrangler', 'secret', 'put', name], { input: value, stdio: ['pipe', 'inherit', 'inherit'], shell: process.platform === 'win32' });
  if (r.status !== 0) {
    console.error(`${name} の登録に失敗しました。npx wrangler login を済ませてから、もう一度実行してください`);
    process.exit(1);
  }
};
// 秘密鍵を先に入れる（公開鍵だけが入った状態だと、画面にボタンが出て登録できてしまう。どちらも揃って初めて通知が有効になる）
put('VAPID_PRIVATE_KEY', priv);
put('VAPID_PUBLIC_KEY', pub);
console.log(`\n登録しました。公開鍵: ${pub}`);
