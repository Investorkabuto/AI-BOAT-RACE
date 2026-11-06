// 2026-11-06 の全体点検で足した守り: 画面の CSP、アクセス数制限の数え方、MCP のまとめ送りの上限
import { describe, expect, it, vi } from 'vitest';
import { memoryD1 } from './helpers/d1';
import { ensureSchema } from '../src/db/migrate';
import { sha256Hex } from '../src/lib/crypto';
import { enforceRateLimit } from '../src/lib/http';
import appHtml from '../src/web/app.html';

vi.mock('cloudflare:workers', () => ({ DurableObject: class {} }));
const { app } = await import('../src/index');

describe('観戦画面の CSP', () => {
  it('この HTML のスクリプトだけを許し、外から差し込まれたスクリプトは動かさない', async () => {
    const db = memoryD1();
    const res = await app.request('/', {}, { DB: db });
    const csp = res.headers.get('Content-Security-Policy') ?? '';
    const script = /<script>([\s\S]*?)<\/script>/.exec(appHtml)![1]!.replace(/\r\n?/g, '\n');
    const hash = btoa(String.fromCharCode(...new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(script)))));
    expect(csp).toContain(`'sha256-${hash}'`);
    expect(csp).not.toMatch(/script-src[^;]*'unsafe-inline'/);
    expect(csp).toContain("frame-ancestors 'none'");
    expect(csp).toContain("worker-src 'self'");
  });
});

describe('アクセス数制限の数え方', () => {
  const run = async (opts: { auth?: string; agentId?: string; precise?: boolean }) => {
    const keys: string[] = [];
    const limiter = { limit: async ({ key }: { key: string }) => (keys.push(key), { success: true }) };
    await enforceRateLimit(
      { env: { AGENT_LIMITER: limiter, ANON_LIMITER: limiter } as never, req: { header: (n: string) => (n === 'Authorization' ? opts.auth : n === 'CF-Connecting-IP' ? '203.0.113.5' : undefined) }, header: () => {} },
      { agentId: opts.agentId, precise: opts.precise },
    );
    return keys;
  };
  it('でたらめなキーを送っても、接続元ごとに数える（キーを変えてすり抜けられない）', async () => {
    expect(await run({ auth: 'Bearer agk_fake1' })).toEqual(['ip:203.0.113.5']);
    expect(await run({ auth: 'Bearer agk_fake2', precise: false })).toEqual(['ip:203.0.113.5']);
  });
  it('確かめたキーは、AIごとに数える', async () => {
    expect(await run({ auth: 'Bearer agk_real', agentId: 'agt_x' })).toEqual(['a:agt_x']);
  });
});

describe('参加AIの API', () => {
  it('本物のキーなら通り、でたらめなキーは 401', async () => {
    const db = memoryD1();
    await ensureSchema(db);
    db.raw.prepare("INSERT INTO agents (id, realm, display_name, owner_name, api_key_hash, status, terms_agreed_at, created_at) VALUES ('agt_a', 'live', 'A', 'o', ?, 'active', 'x', 'x')").run(await sha256Hex('agk_ok'));
    const get = (key: string) => app.request('/agents/me', { headers: { Authorization: `Bearer ${key}` } }, { DB: db });
    expect((await get('agk_ok')).status).toBe(200);
    expect((await get('agk_ng')).status).toBe(401);
  });
});

describe('MCP', () => {
  it('まとめ送りは20件まで', async () => {
    const db = memoryD1();
    const call = (n: number) =>
      app.request('/mcp', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(Array.from({ length: n }, (_, i) => ({ jsonrpc: '2.0', id: i, method: 'ping' }))) }, { DB: db });
    expect((await call(20)).status).toBe(200);
    expect((await call(21)).status).toBe(400);
  });
});
