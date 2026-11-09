// D1 の読み書きの行数の計測（2026-11-09 管理者決定）
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { memoryD1 } from './helpers/d1';
import { ensureSchema } from '../src/db/migrate';
import { Meter, d1UsageReport, flushUsage, meterD1, record, resetUsageBuffer } from '../src/lib/d1meter';

// Durable Object の基底クラス（Workers の実行環境にしか無い）の代わり
vi.mock('cloudflare:workers', () => ({ DurableObject: class {} }));

const now = Date.parse('2026-11-09T20:10:00+09:00');

async function setup() {
  const raw = memoryD1();
  await ensureSchema(raw);
  raw.raw.exec("INSERT INTO app_state (key, value, updated_at) VALUES ('a', '1', 'x'), ('b', '2', 'x'), ('c', '3', 'x');");
  return raw;
}

describe('D1 の計測', () => {
  beforeEach(() => resetUsageBuffer());

  it('prepare・first・batch の行数を経路ごとに数え、結果は計測なしと同じ', async () => {
    const raw = await setup();
    const m = new Meter('tick:a');
    const db = meterD1(raw, m);
    expect((await db.prepare('SELECT key FROM app_state ORDER BY key').all()).results).toHaveLength(3);
    expect(await db.prepare('SELECT value FROM app_state WHERE key = ?').bind('b').first<{ value: string }>()).toEqual({ value: '2' });
    expect(await db.prepare('SELECT value FROM app_state WHERE key = ?').bind('b').first('value')).toBe('2');
    expect(await db.prepare('SELECT value FROM app_state WHERE key = ?').bind('zz').first()).toBeNull();
    m.label = 'tick:b';
    await db.batch([db.prepare('SELECT key FROM app_state'), db.prepare("UPDATE app_state SET value = '9' WHERE key = ?").bind('a')]);
    expect(m.by.get('tick:a')).toEqual({ q: 4, r: 3 + 1 + 1 + 0, w: 0 });
    expect(m.by.get('tick:b')).toEqual({ q: 2, r: 3, w: 1 });
    expect(raw.raw.prepare("SELECT value FROM app_state WHERE key = 'a'").get()).toEqual({ value: '9' });
  });

  it('リクエストは最後に経路へまとめ、1時間ごとに d1_usage へ足し込む', async () => {
    const raw = await setup();
    for (let i = 0; i < 2; i++) {
      const m = new Meter();
      const db = meterD1(raw, m);
      await db.prepare('SELECT key FROM app_state').all();
      m.relabel('GET /races/:race_id');
      record(m, now);
    }
    await flushUsage(raw, now, true);
    const r = await d1UsageReport(raw, '2026-11-09');
    expect(r.total_rows_read).toBe(6);
    expect(r.by_label).toEqual([{ label: 'GET /races/:race_id', n: 2, queries: 2, rows_read: 6, rows_written: 0, share_pct: 100, rows_read_per_call: 3 }]);
    expect(r.by_hour).toEqual([{ hour: '2026-11-09T20', n: 2, rows_read: 6, rows_written: 0 }]);
    // 同じ時間・経路は足し込む
    const m = new Meter('tick:settle');
    await meterD1(raw, m).prepare('SELECT key FROM app_state').all();
    record(m, now);
    await flushUsage(raw, now, true);
    expect((await d1UsageReport(raw, '2026-11-09')).total_rows_read).toBe(9);
  });

  it('1分たつまでは書かない', async () => {
    const raw = await setup();
    const m = new Meter('x');
    await meterD1(raw, m).prepare('SELECT key FROM app_state').all();
    record(m, now);
    await flushUsage(raw, now, true);
    record(m, now + 10_000);
    await flushUsage(raw, now + 10_000);
    expect((await d1UsageReport(raw, '2026-11-09')).total_rows_read).toBe(3);
    await flushUsage(raw, now + 61_000);
    expect((await d1UsageReport(raw, '2026-11-09')).total_rows_read).toBe(6);
  });
});

describe('入口での計測', () => {
  beforeEach(() => resetUsageBuffer());

  it('リクエストをルートのパターンで数える', async () => {
    const { default: worker } = await import('../src/index');
    const raw = await setup();
    const waits: Promise<unknown>[] = [];
    const ctx = { waitUntil: (p: Promise<unknown>) => waits.push(p), passThroughOnException() {} } as unknown as ExecutionContext;
    const env = { DB: raw } as never;
    expect((await worker.fetch(new Request('https://x/races/20261109-05-09'), env, ctx)).status).toBe(404);
    expect((await worker.fetch(new Request('https://x/races?date=2026-11-09'), env, ctx)).status).toBe(200);
    await Promise.all(waits);
    await flushUsage(raw, Date.now(), true);
    const hour = new Date(Date.now() + 9 * 3600e3).toISOString().slice(0, 13);
    const labels = raw.raw.prepare('SELECT label, n FROM d1_usage WHERE hour = ? ORDER BY label').all(hour);
    expect(labels).toEqual([
      { label: 'GET /races', n: 1 },
      { label: 'GET /races/:id', n: 1 },
    ]);
  });
});
