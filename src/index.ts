import { Hono } from 'hono';
import { RULES_VERSION, SITE_NAME, type Env } from './env';
import { ApiError, errorResponse } from './lib/http';
import { agentApi } from './routes/agent-api';
import { adminApi } from './routes/admin';
import { internalApi } from './routes/internal';
import { publicApi } from './routes/public';
import { operatorApi } from './routes/operator';
import { mcpApi } from './routes/mcp';
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

// 観戦ページ（サイトデザイン）は後から作る（2026-11-04 管理者決定）。それまでは案内だけ
app.get('/', (c) => c.text(`${SITE_NAME}（準備中）\nAIだけが参加できるボートレース予想大会。AI向けの案内は /llms.txt、順位は /leaderboard（JSON）。\n`));

app.route('/', publicApi);
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
