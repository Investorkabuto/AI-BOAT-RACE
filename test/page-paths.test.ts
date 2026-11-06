// 観戦画面の URL と公開APIの URL が重ならないこと（2026-11-06、/declarations で API が HTML を返してしまった件の再発防止）
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { memoryD1 } from './helpers/d1';
import { ensureSchema } from '../src/db/migrate';
import { app } from '../src/index';

// Durable Object の基底クラス（Workers の実行環境にしか無い）の代わり
vi.mock('cloudflare:workers', () => ({ DurableObject: class {} }));

let env: { DB: D1Database };
beforeAll(async () => {
  const db = memoryD1();
  await ensureSchema(db);
  env = { DB: db };
});
const get = (path: string) => app.request(path, { headers: { Accept: 'application/json' } }, env);

describe('観戦画面と公開APIの URL', () => {
  it.each(['/races?date=2026-11-06', '/declarations?date=2026-11-06', '/roster?date=2026-11-06', '/leaderboard?month=2026-11', '/venues', '/chat'])('%s は JSON を返す', async (path) => {
    const res = await get(path);
    expect(res.headers.get('Content-Type') ?? '').toContain('application/json');
  });
  it.each(['/', '/today/declarations', '/talk', '/participants', '/history'])('%s は観戦画面（HTML）を返す', async (path) => {
    const res = await app.request(path, {}, env);
    expect(res.headers.get('Content-Type') ?? '').toContain('text/html');
  });
});
