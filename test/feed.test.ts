// 出走表の補足フィードの受け口（もちの夜間バッチ → アプリ。決定54）と、送信専用トークン
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { memoryD1 } from './helpers/d1';
import { ensureSchema } from '../src/db/migrate';

vi.mock('cloudflare:workers', () => ({ DurableObject: class {} }));
const { app } = await import('../src/index');

let db: ReturnType<typeof memoryD1>;
const env = () => ({ DB: db, ADMIN_TOKEN: 'adm' });
const req = (method: string, path: string, token?: string, body?: unknown) =>
  app.request(path, { method, headers: { 'Content-Type': 'application/json', Accept: 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) }, env());

const boat = (n: number) => ({
  boat: n, reg_no: 3900 + n, name: `選手${n}`, grade: 'A1', nw: 6.5, n2: 40.1, lw: 6.1, l2: 38.2, motor_no: 10 + n, m2: 33.3, boat_no: 20 + n, b2: 31.0,
  avg_st: 0.161, st_starts: 823, avg_st_by_course: { '1': { avg_st: 0.153, starts: 164 } }, prediction: { secret: true },
});
const race = (id: string) => ({ race_id: id, venue: '三国', deadline: '10:58', boats: [1, 2, 3, 4, 5, 6].map(boat), features: { win_diff: 1.2 }, prediction: { pred_nige: 0.61 } });
const payload = (date: string, races: unknown[]) => ({ schema_version: 1, date, generated_at: '2026-11-07T23:12:00+09:00', source: 'mochi-pastdb', definition: 'avg_st = mean of valid ST', races });

beforeEach(async () => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date('2026-11-07T23:30:00+09:00'));
  db = memoryD1();
  await ensureSchema(db);
});
afterEach(() => vi.useRealTimers());

async function issue(): Promise<string> {
  const res = await req('POST', '/admin/feed-tokens', 'adm', { label: 'mochi-feed' });
  expect(res.status).toBe(201);
  const t = ((await res.json()) as { token: string }).token;
  expect(t).toMatch(/^fdk_/);
  return t;
}

describe('送信専用トークン', () => {
  it('管理者が発行し、実値は保存しない。同時に2本まで。失効させると使えない', async () => {
    const t = await issue();
    expect(JSON.stringify(db.raw.prepare('SELECT * FROM feed_tokens').all())).not.toContain(t);
    await issue();
    expect((await req('POST', '/admin/feed-tokens', 'adm', {})).status).toBe(409);
    const id = (db.raw.prepare("SELECT id FROM feed_tokens ORDER BY created_at LIMIT 1").get() as { id: string }).id;
    expect((await req('DELETE', `/admin/feed-tokens/${id}`, 'adm')).status).toBe(200);
    const revoked = db.raw.prepare('SELECT token_hash FROM feed_tokens WHERE id = ?').get(id);
    expect(revoked).toBeTruthy();
  });

  it('トークンが無い・運営トークン・無効なトークンは 401', async () => {
    expect((await req('POST', '/feed/card-supplements', undefined, payload('2026-11-08', [race('20261108-10-02')]))).status).toBe(401);
    expect((await req('POST', '/feed/card-supplements', 'opk_x', payload('2026-11-08', [race('20261108-10-02')]))).status).toBe(401);
    expect((await req('POST', '/feed/card-supplements', 'fdk_wrong', payload('2026-11-08', [race('20261108-10-02')]))).status).toBe(401);
  });
});

describe('受け取り', () => {
  it('翌日分を保存し、GET /races/{race_id} の supplement で返す（予測は出さない）', async () => {
    const t = await issue();
    const res = await req('POST', '/feed/card-supplements', t, payload('2026-11-08', [race('20261108-10-02'), race('20261108-10-03')]));
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ date: '2026-11-08', received_races: 2, stored_races: 2, frozen_races: [], rejected: [] });

    // レースは朝の出走表（公式HTML）で作られる
    db.raw.prepare("INSERT INTO races (id, race_date, jcd, rno, deadline_at, deadline_ms, status, updated_at) VALUES ('20261108-10-02', '2026-11-08', '10', 2, 'x', ?, 'scheduled', 'x')").run(Date.parse('2026-11-08T10:58:00+09:00'));
    const detail = (await (await req('GET', '/races/20261108-10-02')).json()) as { supplement: Record<string, unknown> & { boats: Record<string, unknown>[] } };
    expect(detail.supplement).toMatchObject({ source: 'mochi', definition: 'avg_st = mean of valid ST', venue: '三国', features: { win_diff: 1.2 } });
    expect(detail.supplement.boats[0]).toMatchObject({ boat: 1, reg_no: 3901, avg_st: 0.161, st_starts: 823, avg_st_by_course: { '1': { avg_st: 0.153, starts: 164 } } });
    expect(JSON.stringify(detail)).not.toContain('pred_nige');
    expect(JSON.stringify(detail)).not.toContain('secret');

    const got = (await (await req('GET', '/feed/card-supplements?date=2026-11-08', t)).json()) as { received: { races: number } };
    expect(got.received.races).toBe(2);
  });

  it('同じ日の再送は全部置き換える。締切を過ぎたレースは凍結する', async () => {
    const t = await issue();
    await req('POST', '/feed/card-supplements', t, payload('2026-11-08', [race('20261108-10-01'), race('20261108-10-02'), race('20261108-10-03')]));
    db.raw.prepare("INSERT INTO races (id, race_date, jcd, rno, deadline_at, deadline_ms, status, updated_at) VALUES ('20261108-10-01', '2026-11-08', '10', 1, 'x', ?, 'scheduled', 'x')").run(Date.parse('2026-11-08T10:30:00+09:00'));
    vi.setSystemTime(new Date('2026-11-08T10:45:00+09:00')); // 1R の締切後
    const changed = { ...race('20261108-10-01'), features: { win_diff: 9 } };
    const res = await req('POST', '/feed/card-supplements', t, payload('2026-11-08', [changed, race('20261108-10-02')]));
    expect(await res.json()).toMatchObject({ stored_races: 1, frozen_races: ['20261108-10-01'] });
    const rows = db.raw.prepare('SELECT race_id, race_json FROM card_supplements ORDER BY race_id').all() as { race_id: string; race_json: string }[];
    expect(rows.map((r) => r.race_id)).toEqual(['20261108-10-01', '20261108-10-02']); // 3R は再送に無いので消え、凍結した 1R は元のまま
    expect(JSON.parse(rows[0]!.race_json).features.win_diff).toBe(1.2);
  });

  it('日付・schema_version・レースを確かめる。おかしいレースだけ外して保存する', async () => {
    const t = await issue();
    expect((await req('POST', '/feed/card-supplements', t, payload('2026-11-06', [race('20261106-10-02')]))).status).toBe(400); // 過去の日
    expect((await req('POST', '/feed/card-supplements', t, payload('2026-11-20', [race('20261120-10-02')]))).status).toBe(400); // 先すぎる
    expect((await req('POST', '/feed/card-supplements', t, { ...payload('2026-11-08', [race('20261108-10-02')]), schema_version: 2 })).status).toBe(400);
    expect((await req('POST', '/feed/card-supplements', t, payload('2026-11-08', []))).status).toBe(400);
    const res = await req('POST', '/feed/card-supplements', t, payload('2026-11-08', [race('20261108-10-02'), race('20261109-10-02'), race('bad'), { race_id: '20261108-10-04', boats: [{ boat: 7 }] }, race('20261108-10-02')]));
    const j = (await res.json()) as { stored_races: number; rejected: { race_id: string }[] };
    expect(j.stored_races).toBe(1);
    expect(j.rejected.map((r) => r.race_id)).toEqual(['20261109-10-02', 'bad', '20261108-10-04', '20261108-10-02']);
  });
});
