// レースの種別（race_name）と大会名・何日目か（番組表Bから）: 公式HTMLの出走表の取り込みで種別が消えないこと、/races で返すこと
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { memoryD1 } from './helpers/d1';
import { ensureSchema } from '../src/db/migrate';

vi.mock('cloudflare:workers', () => ({ DurableObject: class {} }));
const { app } = await import('../src/index');

let db: ReturnType<typeof memoryD1>;
const env = () => ({ DB: db, INGEST_TOKEN: 'ing' });
const ID = '20261109-23-01';

beforeEach(async () => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date('2026-11-09T07:30:00+09:00'));
  db = memoryD1();
  await ensureSchema(db);
  // 前日の夕方に番組表Bから入ったレース
  db.raw.exec(`INSERT INTO races (id, race_date, jcd, rno, race_name, deadline_at, deadline_ms, status, updated_at)
      VALUES ('${ID}', '2026-11-09', '23', 1, '朝1戦', '2026-11-09T08:35:00+09:00', ${Date.parse('2026-11-09T08:35:00+09:00')}, 'scheduled', 'x');
    INSERT INTO race_cards (race_id, fixed_course, distance, rows, fetched_at, day, series_title) VALUES ('${ID}', 0, 1800, '', 'x', 4, 'BTSみやき開設17周年記念');`);
});
afterEach(() => vi.useRealTimers());

describe('レースの種別と大会名', () => {
  it('公式HTMLの出走表（種別なし）を取り込んでも、番組表Bの種別を残す。締切は更新する', async () => {
    const res = await app.request('/internal/races', { method: 'PUT', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ing' }, body: JSON.stringify({ race_date: '2026-11-09', races: [{ jcd: '23', rno: 1, deadline: '08:40' }] }) }, env());
    expect(res.status).toBe(200);
    expect(db.raw.prepare('SELECT race_name, deadline_at FROM races WHERE id = ?').get(ID)).toEqual({ race_name: '朝1戦', deadline_at: '2026-11-09T08:40:00+09:00' });
  });

  it('GET /races と GET /races/{race_id} は大会名と何日目かを返す', async () => {
    const list = (await (await app.request('/races?date=2026-11-09', { headers: { Accept: 'application/json' } }, env())).json()) as any;
    expect(list.races[0]).toMatchObject({ race_id: ID, race_name: '朝1戦', series_title: 'BTSみやき開設17周年記念', day: 4 });
    const one = (await (await app.request(`/races/${ID}`, { headers: { Accept: 'application/json' } }, env())).json()) as any;
    expect(one).toMatchObject({ race_name: '朝1戦', series_title: 'BTSみやき開設17周年記念', day: 4 });
  });
});
