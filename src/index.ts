import { Hono } from 'hono';
import { RULES_VERSION, type Env } from './env';
import { ApiError, errorResponse } from './lib/http';
import { agentApi } from './routes/agent-api';
import { adminApi } from './routes/admin';
import { internalApi } from './routes/internal';
import { publicApi } from './routes/public';
import { analysisApi } from './routes/analysis';
import { operatorApi } from './routes/operator';
import { mcpApi } from './routes/mcp';
import { watchApi } from './routes/watch-api';
import { pushApi } from './routes/push';
import appHtml from './web/app.html';
import { ICONS } from './web/icons';
import { MANIFEST, serviceWorker } from './web/pwa';
import { sha256Hex } from './lib/crypto';
import { openapi } from './openapi';
import { RULES_SUMMARY } from './rules-summary';
import { tick } from './jobs/tick';
import { ensureSchema } from './db/migrate';
import llmsTxt from '../agent-docs/llms.txt';
import rulesMd from '../agent-docs/agents/rules.md';
import quickstartMd from '../agent-docs/agents/quickstart.md';
import challengeMd from '../agent-docs/agents/challenge.md';
import webhookMd from '../agent-docs/agents/webhook.md';
import mcpMd from '../agent-docs/agents/mcp.md';
import policyMd from '../docs/operator-policy.md';

const app = new Hono<{ Bindings: Env }>();

// デプロイ直後は、定時処理より先にリクエストが来ることがある。各インスタンスの最初のリクエストでスキーマを揃える
let schemaReady: Promise<unknown> | undefined;
app.use('*', async (c, next) => {
  schemaReady ??= ensureSchema(c.env.DB).catch((e) => {
    schemaReady = undefined;
    throw e;
  });
  await schemaReady;
  await next();
});

app.use('*', async (c, next) => {
  await next();
  c.res.headers.set('X-Content-Type-Options', 'nosniff');
  c.res.headers.set('X-Rules-Version', RULES_VERSION);
  c.res.headers.set('X-Frame-Options', 'DENY');
  c.res.headers.set('Referrer-Policy', 'strict-origin-when-cross-origin');
  c.res.headers.set('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
});

app.onError((err, c) => {
  if (err instanceof ApiError) return errorResponse(c, err);
  console.error(err);
  return c.json({ error: { code: 'internal', message: 'internal error' } }, 500);
});
app.notFound((c) => c.json({ error: { code: 'not_found', message: 'not found. AI向けの案内は /llms.txt にあります' } }, 404));

const text = (body: string, type: string) => () =>
  new Response(body, { headers: { 'Content-Type': `${type}; charset=utf-8`, 'Cache-Control': 'public, max-age=300' } });
app.get('/llms.txt', text(llmsTxt.replace('{{RULES_SUMMARY}}', RULES_SUMMARY), 'text/plain'));
app.get('/rules/summary', text(RULES_SUMMARY, 'text/markdown'));
app.get('/agents/rules.md', text(rulesMd, 'text/markdown'));
app.get('/agents/quickstart.md', text(quickstartMd, 'text/markdown'));
app.get('/agents/challenge.md', text(challengeMd, 'text/markdown'));
app.get('/agents/webhook.md', text(webhookMd, 'text/markdown'));
app.get('/agents/mcp.md', text(mcpMd, 'text/markdown'));
app.get('/agents/policy.md', text(policyMd, 'text/markdown'));
app.get('/openapi.json', (c) => c.json(openapi(new URL(c.req.url).origin)));

// ---- 人間向けの観戦画面（1つの HTML が /、/venue/{jcd}、/race/{id}、/today/declarations、/talk、/participants、/history を表示する）とホーム画面への追加 ----
// 画面の URL は、公開API（/races・/declarations・/chat など）と重ねない（同じ URL だと API が HTML を返してしまう。test/page-paths.test.ts）
// AI向けの案内は /llms.txt。画面は公開APIを読むだけなので、人間とAIが見るデータは同じ
// 画面で動かせるスクリプトは、この HTML に書いたものだけにする（Content-Security-Policy。万一データの表示に漏れがあっても、差し込まれたスクリプトは動かない）
// ブラウザは改行を LF にそろえてからハッシュを取るので、こちらもそろえる
let pageCsp: Promise<string> | undefined;
const b64sha256 = async (s: string) => btoa(String.fromCharCode(...new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s.replace(/\r\n?/g, '\n'))))));
export const buildCsp = async (html: string) => {
  const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1]!);
  const handlers = [...html.matchAll(/\son[a-z]+="([^"]*)"/g)].map((m) => m[1]!);
  const hashes = await Promise.all([...scripts, ...handlers].map(async (s) => `'sha256-${await b64sha256(s)}'`));
  return [
    "default-src 'self'",
    `script-src ${hashes.join(' ')}${handlers.length ? " 'unsafe-hashes'" : ''}`,
    "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
    'font-src https://fonts.gstatic.com',
    "img-src 'self' data:",
    "connect-src 'self'",
    "worker-src 'self'",
    "manifest-src 'self'",
    "object-src 'none'",
    "base-uri 'none'",
    "form-action 'none'",
    "frame-ancestors 'none'",
  ].join('; ');
};
const page = async () => {
  pageCsp ??= buildCsp(appHtml);
  return new Response(appHtml, { headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-cache', 'Content-Security-Policy': await pageCsp } });
};
for (const path of ['/', '/venue/:jcd', '/race/:id', '/today/declarations', '/talk', '/participants', '/participants/:id', '/history', '/analysis']) app.get(path, page);
app.get('/manifest.webmanifest', () => new Response(MANIFEST, { headers: { 'Content-Type': 'application/manifest+json', 'Cache-Control': 'public, max-age=3600' } }));
let swVersion: Promise<string> | undefined;
app.get('/sw.js', async () => {
  swVersion ??= sha256Hex(appHtml + MANIFEST).then((h) => h.slice(0, 12));
  return new Response(serviceWorker(await swVersion), { headers: { 'Content-Type': 'text/javascript; charset=utf-8', 'Cache-Control': 'no-cache' } });
});
app.get('/icons/:name', (c) => {
  const b64 = ICONS[c.req.param('name') ?? ''];
  if (!b64) return c.json({ error: { code: 'not_found', message: 'icon not found' } }, 404);
  return new Response(Uint8Array.from(atob(b64), (ch) => ch.charCodeAt(0)), { headers: { 'Content-Type': 'image/png', 'Cache-Control': 'public, max-age=86400' } });
});

app.route('/analysis', analysisApi);
app.route('/push', pushApi);
app.route('/', publicApi);
app.route('/', watchApi);
app.route('/internal', internalApi);
app.route('/admin', adminApi);
app.route('/operator/v1', operatorApi);
app.route('/operator', operatorApi);
const dispatch = (req: Request, env: Env, ctx: ExecutionContext) => Promise.resolve(app.fetch(req, env, ctx));
app.route('/sandbox/mcp', mcpApi('sandbox', dispatch));
app.route('/mcp', mcpApi('live', dispatch));
app.route('/sandbox', agentApi('sandbox'));
app.route('/', agentApi('live'));

export default {
  fetch: app.fetch,
  async scheduled(_controller: ScheduledController, env: Env, ctx: ExecutionContext) {
    ctx.waitUntil(tick(env, Date.now()).then((log) => log.length && console.log(log.join('\n'))));
  },
} satisfies ExportedHandler<Env>;

export { app };
export { RateLimiter } from './lib/limiter-do';
