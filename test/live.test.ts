// 締切前の直前情報とオッズ（決定64）: 取り込み（PUT /internal/live）と、GET /races/{race_id} での公開
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { memoryD1 } from './helpers/d1';
import { ensureSchema } from '../src/db/migrate';
import { normalizeOdds, topOdds } from '../src/lib/live';

vi.mock('cloudflare:workers', () => ({ DurableObject: class {} }));
const { app } = await import('../src/index');

let db: ReturnType<typeof memoryD1>;
const TOKEN = 'ingest_test';
const env = () => ({ DB: db, INGEST_TOKEN: TOKEN });
const req = async (method: string, path: string, body?: unknown, token: string | null = TOKEN) => {
  const res = await app.request(
    path,
    { method, headers: { 'Content-Type': 'application/json', Accept: 'application/json', 'User-Agent': 'test/1.0', ...(token ? { Authorization: `Bearer ${token}` } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) },
    env(),
  );
  return { status: res.status, body: (await res.json()) as any };
};
const R = '20261109-19-11';
const perms = (k: number, ordered: boolean) => {
  const out: string[] = [];
  const rec = (pre: number[]) => {
    if (pre.length === k) return void out.push(pre.join(ordered ? '-' : '='));
    for (let b = 1; b <= 6; b++) if (!pre.includes(b) && (ordered || !pre.length || b > pre[pre.length - 1]!)) rec([...pre, b]);
  };
  rec([]);
  return out;
};
const oddsOf = (combos: string[]) => Object.fromEntries(combos.map((c, i) => [c, i === 1 ? null : 1.5 + i]));
const odds = { sanrentan: oddsOf(perms(3, true)), sanrenpuku: oddsOf(perms(3, false)), nirentan: oddsOf(perms(2, true)), nirenpuku: oddsOf(perms(2, false)), as_of: '20:00' };
const beforeinfo = {
  boats: [1, 2, 3, 4, 5, 6].map((boat) => ({ boat, weight: 52, adjust_weight: 0, exhibit_time: 6.7 + boat / 100, tilt: -0.5, propeller: null, parts: boat === 3 ? ['ピストン'] : [] })),
  start_exhibition: [1, 2, 3, 4, 5, 6].map((boat) => ({ course: boat, boat, st: '.12' })),
  weather: { as_of: '10R時点', weather: '曇り', temperature: 13, wind_m: 1, wind_dir: 5, water_temperature: 20, wave_cm: 1 },
};

beforeEach(async () => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date('2026-11-09T20:00:00+09:00'));
  db = memoryD1();
  await ensureSchema(db);
  db.raw
    .prepare("INSERT INTO races (id, race_date, jcd, rno, deadline_at, deadline_ms, status, updated_at) VALUES (?, '2026-11-09', '19', 11, ?, ?, 'scheduled', 'x')")
    .run(R, '2026-11-09T20:07:00+09:00', Date.parse('2026-11-09T20:07:00+09:00'));
});
afterEach(() => vi.useRealTimers());

describe('取り込み', () => {
  it('取るレースの一覧は、受付中で締切前のレースと締切（epoch 秒）', async () => {
    const r = await req('GET', '/internal/live-targets?date=2026-11-09');
    expect(r.body.races).toEqual([{ race_id: R, deadline_s: Date.parse('2026-11-09T20:07:00+09:00') / 1000, focus: false }]);
    // 申告（見送りを除く）があるレースは focus（10分前・7分前のオッズも取る）
    db.raw.exec("INSERT INTO agents (id, realm, display_name, owner_name, api_key_hash, status, terms_agreed_at, created_at) VALUES ('a1', 'live', 'A', 'o', 'h', 'active', 'x', 'x')");
    db.raw.exec(`INSERT INTO entries (realm, agent_id, race_id, race_date, status, declared_at) VALUES ('live', 'a1', '${R}', '2026-11-09', 'passed', 'x')`);
    expect((await req('GET', '/internal/live-targets?date=2026-11-09')).body.races[0].focus).toBe(false);
    db.raw.exec(`UPDATE entries SET status = 'entered'`);
    expect((await req('GET', '/internal/live-targets?date=2026-11-09')).body.races[0].focus).toBe(true);
    expect((await req('GET', '/internal/live-targets', undefined, 'wrong')).status).toBe(401);
  });

  it('直前情報とオッズ（30分前・10分前・7分前）を保存し、GET /races/{race_id} で古い順に公開する', async () => {
    vi.setSystemTime(new Date('2026-11-09T19:37:00+09:00'));
    await req('PUT', '/internal/live', { race_id: R, kind: 'odds', slot: 't30', data: odds });
    vi.setSystemTime(new Date('2026-11-09T20:00:00+09:00'));
    expect((await req('PUT', '/internal/live', { race_id: R, kind: 'beforeinfo', data: beforeinfo })).body.stored).toBe(true);
    expect((await req('PUT', '/internal/live', { race_id: R, kind: 'odds', slot: 't10', data: odds })).body.types).toEqual(['sanrentan']);
    vi.setSystemTime(new Date('2026-11-09T20:00:30+09:00'));
    await req('PUT', '/internal/live', { race_id: R, kind: 'odds', slot: 't7', data: odds });
    const race = await req('GET', `/races/${R}`, undefined, null);
    expect(race.body.beforeinfo.boats[2]).toMatchObject({ boat: 3, exhibit_time: 6.73, parts: ['ピストン'] });
    expect(race.body.beforeinfo.weather).toMatchObject({ wind_m: 1, wave_cm: 1 });
    expect(race.body.odds.map((o: any) => [o.slot, o.minutes_before])).toEqual([['t30', 30], ['t10', 10], ['t7', 7]]);
    expect(race.body.odds[1].sanrentan['1-2-3']).toBe(1.5);
    expect(race.body.odds[1].sanrentan['1-2-4']).toBeNull();
    expect(race.body.odds[0].nirenpuku).toBeUndefined(); // 3連単だけ
  });

  it('締切を過ぎた分は保存しない。形の違うものは 400', async () => {
    expect((await req('PUT', '/internal/live', { race_id: R, kind: 'odds', slot: 't5', data: odds })).status).toBe(400);
    expect((await req('PUT', '/internal/live', { race_id: R, kind: 'beforeinfo', data: { boats: [] } })).status).toBe(400);
    vi.setSystemTime(new Date('2026-11-09T20:07:00+09:00'));
    expect((await req('PUT', '/internal/live', { race_id: R, kind: 'odds', slot: 't7', data: odds })).body).toEqual({ stored: false, reason: 'after_deadline' });
  });
});

describe('オッズの正規化', () => {
  it('3連単だけを、120組そろったときに残す。人気順の上位は発売なしを除く', () => {
    const o = normalizeOdds({ sanrentan: Object.fromEntries(Object.entries(odds.sanrentan).map(([k, v]) => [k.replace(/-/g, ''), v])), sanrenpuku: odds.sanrenpuku });
    expect(Object.keys(o!)).toEqual(['sanrentan']);
    expect(o!.sanrentan!['1-2-3']).toBe(1.5);
    expect(normalizeOdds({ sanrentan: { '1-2-3': 2 } })).toBeNull();
    expect(topOdds({ '1-2': 5, '2-1': null, '1-3': 2 }, 2)).toEqual([{ combo: '1-3', odds: 2 }, { combo: '1-2', odds: 5 }]);
  });
});
