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
const race = (id: string) => ({ race_id: id, venue: '三国', deadline: '10:58', boats: [1, 2, 3, 4, 5, 6].map(boat), features: { win_diff: 1.2 }, prediction: { pred_nige: 0.61, pred_win1: 0.55, judgeable: true, layer_n: 1234, window_months: 24 } });
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
  it('翌日分を保存する。公開API（GET /races/{race_id}）には出さず、観戦画面専用の /view で一部だけ出す（決定57）', async () => {
    const t = await issue();
    const res = await req('POST', '/feed/card-supplements', t, payload('2026-11-08', [race('20261108-10-02'), race('20261108-10-03')]));
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ date: '2026-11-08', received_races: 2, stored_races: 2, frozen_races: [], rejected: [] });

    // レースは朝の出走表（公式HTML）で作られる。公開APIには補足を出さない
    db.raw.prepare("INSERT INTO races (id, race_date, jcd, rno, deadline_at, deadline_ms, status, updated_at) VALUES ('20261108-10-02', '2026-11-08', '10', 2, 'x', ?, 'scheduled', 'x')").run(Date.parse('2026-11-08T10:58:00+09:00'));
    const detail = await (await req('GET', '/races/20261108-10-02')).json();
    expect(detail).not.toHaveProperty('supplement');
    expect(JSON.stringify(detail)).not.toContain('avg_st');

    // 観戦画面専用: モーター・平均ST・逃げ切り率だけ（特徴量・1着率・登録番号などは出さない）
    const view = (await (await req('GET', '/view/races/20261108-10-02/supplement')).json()) as { supplement: { boats: Record<string, unknown>[]; nige: unknown } };
    expect(view.supplement.boats[0]).toEqual({ boat: 1, motor_no: 11, m2: 33.3, avg_st: 0.161, st_starts: 823, avg_st_by_course: { '1': { avg_st: 0.153, starts: 164 } } });
    expect(view.supplement.nige).toEqual({ rate: 0.61, layer_n: 1234, window_months: 24 });
    expect(JSON.stringify(view)).not.toContain('win_diff');
    expect(JSON.stringify(view)).not.toContain('pred_win1');
    expect((await (await req('GET', '/view/races/20261108-10-09/supplement')).json())).toEqual({ race_id: '20261108-10-09', supplement: null });

    // 送った側の照合: 送信専用トークンで、保存した要素をそのまま
    const stored = (await (await req('GET', '/feed/card-supplements?race_id=20261108-10-02', t)).json()) as { stored: { race: { prediction: unknown } } };
    expect(stored.stored.race.prediction).toMatchObject({ pred_nige: 0.61, pred_win1: 0.55 });
    expect((await req('GET', '/feed/card-supplements?race_id=20261108-10-02')).status).toBe(401);
    const got = (await (await req('GET', '/feed/card-supplements?date=2026-11-08', t)).json()) as { received: { races: number } };
    expect(got.received.races).toBe(2);
  });

  it('v0.6 の期間別・モーター・直近10走は届いたものだけ載せ、調子を5段階で付ける（決定59）', async () => {
    const t = await issue();
    const w = (win: number, avg_st: number, starts: number) => ({ win_rate: win, r2: 0.45, r3: 62.5, avg_st, starts, st_starts: starts, by_course: { '1': { avg_st, starts: 12 }, '7': { avg_st: 0.1, starts: 1 } } });
    const rich = {
      ...race('20261108-10-05'),
      boats: [
        { ...boat(1), windows: { '2y': w(6.6, 0.16, 400), '1y': w(6.85, 0.15, 200), '6m': w(7.1, 0.14, 100), '50r': w(7.4, 0.13, 50), '9z': w(1, 1, 1) }, motor: { all: { r2: 52.0, r3: 70.2, starts: 160 }, '20r': { r2: 49.1, r3: 63, starts: 20 } }, recent10: [1, 2, 'F', 'L0', 7, 'x', 3] },
        { ...boat(2), windows: { '1y': w(5.1, 0.16, 200), '50r': w(4.6, 0.172, 50) } },
        { ...boat(3), windows: { '1y': w(5.0, 0.16, 200), '50r': w(5.05, 0.158, 10) } }, // 直近の出走が少ない
        boat(4),
      ],
    };
    await req('POST', '/feed/card-supplements', t, payload('2026-11-08', [rich]));
    const view = (await (await req('GET', '/view/races/20261108-10-05/supplement')).json()) as { supplement: { boats: Record<string, any>[] } };
    const [b1, b2, b3, b4] = view.supplement.boats as [Record<string, any>, Record<string, any>, Record<string, any>, Record<string, any>];
    expect(Object.keys(b1.windows)).toEqual(['2y', '1y', '6m', '50r']);
    expect(b1.windows['50r']).toEqual({ win: 7.4, r2: 45, r3: 62.5, avg_st: 0.13, starts: 50, st_starts: 50, by_course: { '1': { avg_st: 0.13, starts: 12 } } });
    expect(b1.motor).toEqual({ all: { r2: 52, r3: 70.2, starts: 160 } }); // 直近20走は出さない（決定60）
    expect(b1.recent10).toEqual(['1', '2', 'F', 'L0', '3']);
    expect(b1.form).toMatchObject({ level: 5, label: '絶好調' });
    expect(b2.form).toMatchObject({ level: 1, label: '不調' });
    expect(b3).not.toHaveProperty('form');
    expect(b4).toEqual({ boat: 4, motor_no: 14, m2: 33.3, avg_st: 0.161, st_starts: 823, avg_st_by_course: { '1': { avg_st: 0.153, starts: 164 } } });
  });

  it('v0.7 のコース付きの直近30走・当地・モーターの使用開始日と特定方法を読む（決定60）', async () => {
    const t = await issue();
    const rich = {
      ...race('20261108-10-06'),
      boats: [
        { ...boat(1), motor: { all: { r2: 37.6, r3: 50.5, starts: 101 }, '20r': { r2: 15, r3: 30, starts: 20 }, since: '2026-05-01', basis: 'official' },
          recent30: [{ f: 1, c: 1 }, { f: 'F', c: 4 }, { f: 3, c: 9 }, { f: 'x', c: 2 }, 2], recent_local: [{ f: 4, c: 6 }], recent_local_from: '2024-03-02' },
        { ...boat(2), motor: { all: { r2: 30, r3: 40, starts: 50 }, since: 'x', basis: 'weird' } },
      ],
    };
    await req('POST', '/feed/card-supplements', t, payload('2026-11-08', [rich]));
    const view = (await (await req('GET', '/view/races/20261108-10-06/supplement')).json()) as { supplement: { boats: Record<string, any>[] } };
    const [b1, b2] = view.supplement.boats as [Record<string, any>, Record<string, any>];
    expect(b1.motor).toEqual({ all: { r2: 37.6, r3: 50.5, starts: 101 }, since: '2026-05-01', basis: 'official' });
    expect(b1.recent30).toEqual([{ f: '1', c: 1 }, { f: 'F', c: 4 }, { f: '3', c: null }, '2']);
    expect(b1.recent_local).toEqual([{ f: '4', c: 6 }]);
    expect(b1.recent_local_from).toBe('2024-03-02');
    expect(b2.motor).toEqual({ all: { r2: 30, r3: 40, starts: 50 } });
  });

  it('逃げ切り率は判定できるレースだけ出す', async () => {
    const t = await issue();
    await req('POST', '/feed/card-supplements', t, payload('2026-11-08', [{ ...race('20261108-10-04'), prediction: { pred_nige: 0.7, judgeable: false } }]));
    const view = (await (await req('GET', '/view/races/20261108-10-04/supplement')).json()) as { supplement: { nige: unknown } };
    expect(view.supplement.nige).toBeNull();
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
