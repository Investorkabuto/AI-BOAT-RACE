// 無断欠場の罰金の廃止（決定65）: 無断欠場は金額0で記録して公開し、これまでの罰金はマイグレーションで返す
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { memoryD1 } from './helpers/d1';
import { ensureSchema, splitSql } from '../src/db/migrate';
import { lockRace } from '../src/jobs/settlement';
import { accountBalance } from '../src/db/account';
import type { RaceRow } from '../src/db/repo';
import finesAbolished from '../migrations/0024_fines_abolished.sql';

vi.mock('cloudflare:workers', () => ({ DurableObject: class {} }));
const { app } = await import('../src/index');

let db: ReturnType<typeof memoryD1>;
const R = '20261109-19-04';
const deadline = Date.parse('2026-11-09T10:05:00+09:00');
const get = async (path: string) => (await (await app.request(path, { headers: { Accept: 'application/json', 'User-Agent': 'test/1.0' } }, { DB: db })).json()) as any;

beforeEach(async () => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date('2026-11-09T10:06:00+09:00'));
  db = memoryD1();
  await ensureSchema(db);
  db.raw.exec(`
    INSERT INTO agents (id, realm, display_name, owner_name, api_key_hash, status, terms_agreed_at, created_at) VALUES ('a1', 'live', 'もち', 'o', 'h', 'active', 'x', 'x');
    INSERT INTO account_grants (agent_id, month, amount, start_date, granted_at) VALUES ('a1', '2026-11', 200000, '2026-11-01', 'x');
    INSERT INTO races (id, race_date, jcd, rno, deadline_at, deadline_ms, status, updated_at) VALUES ('${R}', '2026-11-09', '19', 4, '2026-11-09T10:05:00+09:00', ${deadline}, 'scheduled', 'x');
    INSERT INTO entries (realm, agent_id, race_id, race_date, status, declared_at) VALUES ('live', 'a1', '${R}', '2026-11-09', 'entered', 'x');`);
});
afterEach(() => vi.useRealTimers());

describe('無断欠場', () => {
  it('締切で金額0の無断欠場として記録し、残高は減らさない。画面と API には無断欠場と出す', async () => {
    const race = db.raw.prepare('SELECT * FROM races WHERE id = ?').get(R) as unknown as RaceRow;
    await lockRace(db, race, deadline + 60_000);
    expect(db.raw.prepare('SELECT amount FROM fines').all()).toEqual([{ amount: 0 }]);
    const ev = db.raw.prepare("SELECT type, payload FROM events WHERE agent_id = 'a1'").all() as { type: string; payload: string }[];
    expect(ev.map((e) => e.type)).toEqual(['entry.no_show']);
    expect((await accountBalance(db, 'a1', '2026-11'))!.balance).toBe(200_000);
    const d = await get('/declarations?date=2026-11-09');
    expect(d.declarations[0]).toMatchObject({ agent_id: 'a1', no_show: true, fine: 0 });
    expect((await get(`/races/${R}`)).entries[0].no_show).toBe(true);
    expect((await get('/roster/a1')).today.entries[0]).toMatchObject({ state: 'no_show', no_show: true });
  });

  it('これまでの罰金はマイグレーションで返す（日ごとの確定残高も戻し、本人に知らせる）。2回流れても二重に戻さない', async () => {
    db.raw.exec(`
      INSERT INTO fines (agent_id, race_id, race_date, amount, created_at) VALUES ('a1', '20261107-23-01', '2026-11-07', 2000, 'x'), ('a1', ${"'"}${R}${"'"}, '2026-11-09', 2000, 'x');
      INSERT INTO balance_days (agent_id, race_date, month, balance, recorded_at) VALUES ('a1', '2026-11-06', '2026-11', 200000, 'x'), ('a1', '2026-11-07', '2026-11', 198000, 'x'), ('a1', '2026-11-08', '2026-11', 198000, 'x');`);
    expect((await accountBalance(db, 'a1', '2026-11'))!.balance).toBe(196_000);
    for (let i = 0; i < 2; i++) await db.batch(splitSql(finesAbolished).map((s) => db.prepare(s)));
    expect((await accountBalance(db, 'a1', '2026-11'))!.balance).toBe(200_000);
    expect(db.raw.prepare('SELECT race_date, balance FROM balance_days ORDER BY race_date').all().map((r: any) => r.balance)).toEqual([200_000, 200_000, 200_000]);
    expect(db.raw.prepare('SELECT COUNT(*) AS n FROM fines WHERE amount = 0').get()).toEqual({ n: 2 });
    const ev = db.raw.prepare("SELECT type, payload FROM events WHERE agent_id = 'a1'").all() as { type: string; payload: string }[];
    expect(ev.map((e) => [e.type, JSON.parse(e.payload).reason, JSON.parse(e.payload).amount])).toEqual([['fine.waived', 'fines_abolished', 2000], ['fine.waived', 'fines_abolished', 2000]]);
  });
});
