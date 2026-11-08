// 申告ルールの改定（決定62、2026-11-09 の開催分から）: 注文・取消・見送り・申告の変更は締切の5分前まで、
// 買い目の申告は任意（根拠は必須）、申告済みのレースの買い目と根拠は変更の理由つきで変えられ、申告とその変更は即時公開
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { memoryD1 } from './helpers/d1';
import { ensureSchema } from '../src/db/migrate';
import { sha256Hex } from '../src/lib/crypto';
import { flexRulesApply, orderCutoffLabel, orderCutoffMs, plansPublic } from '../src/lib/entries';

vi.mock('cloudflare:workers', () => ({ DurableObject: class {} }));
const { app } = await import('../src/index');

let db: ReturnType<typeof memoryD1>;
const env = () => ({ DB: db });
const KEY = 'key_agt_a';
const at = (date: string, hm: string) => vi.setSystemTime(new Date(`${date}T${hm}:00+09:00`));
const req = async (method: string, path: string, body?: unknown, key: string | null = KEY) => {
  const res = await app.request(
    path,
    { method, headers: { 'Content-Type': 'application/json', Accept: 'application/json', 'User-Agent': 'test-agent/1.0', ...(key ? { Authorization: `Bearer ${key}` } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) },
    env(),
  );
  return { status: res.status, body: (await res.json()) as any };
};
let nonce = 0;
const challenge = () => {
  const n = `n${++nonce}`;
  db.raw.prepare('INSERT INTO challenges (nonce, answer, issued_ms, used) VALUES (?, ?, ?, 0)').run(n, 'ok', Date.now());
  return { nonce: n, answer: 'ok' };
};
const buy = (race_id: string, tickets: { bet_type: string; combo: string; amount: number }[], extra: Record<string, unknown> = {}) =>
  req('POST', '/bets', { challenge: challenge(), race_id, tickets, ...extra });
const addRace = (id: string, date: string, jcd: string, rno: number, hm: string) =>
  db.raw
    .prepare("INSERT INTO races (id, race_date, jcd, rno, deadline_at, deadline_ms, status, updated_at) VALUES (?, ?, ?, ?, ?, ?, 'scheduled', 'x')")
    .run(id, date, jcd, rno, `${date}T${hm}:00+09:00`, Date.parse(`${date}T${hm}:00+09:00`));

const R1 = '20261109-12-07';
const R2 = '20261109-12-08';
const R3 = '20261109-12-09';

beforeEach(async () => {
  vi.useFakeTimers({ toFake: ['Date'] });
  at('2026-11-09', '07:00');
  db = memoryD1();
  await ensureSchema(db);
  db.raw
    .prepare("INSERT INTO agents (id, realm, display_name, owner_name, api_key_hash, status, terms_agreed_at, created_at) VALUES ('agt_a', 'live', 'ハヤテ', 'o', ?, 'active', 'x', 'x')")
    .run(await sha256Hex(KEY));
  addRace(R1, '2026-11-09', '12', 7, '10:00');
  addRace(R2, '2026-11-09', '12', 8, '10:30');
  addRace(R3, '2026-11-09', '12', 9, '11:00');
  addRace('20261108-12-07', '2026-11-08', '12', 7, '10:00');
});
afterEach(() => vi.useRealTimers());

describe('締切と公開の決まり', () => {
  it('2026-11-09 の開催分から、注文の締切は締切の5分前。それより前は締切そのもの', () => {
    const d = Date.parse('2026-11-09T10:00:00+09:00');
    expect(flexRulesApply('2026-11-08')).toBe(false);
    expect(flexRulesApply('2026-11-09')).toBe(true);
    expect(orderCutoffMs({ race_date: '2026-11-09', deadline_ms: d })).toBe(d - 5 * 60_000);
    expect(orderCutoffMs({ race_date: '2026-11-08', deadline_ms: d })).toBe(d);
    expect(orderCutoffLabel({ race_date: '2026-11-09', deadline_ms: d })).toBe('締切の5分前（09:55）');
  });
  it('申告の買い目と根拠は、改定後は申告の時点から、改定前は申告の期限から公開', () => {
    expect(plansPublic('2026-11-09', Date.parse('2026-11-09T07:00:00+09:00'))).toBe(true);
    expect(plansPublic('2026-11-08', Date.parse('2026-11-08T08:00:00+09:00'))).toBe(false);
    expect(plansPublic('2026-11-08', Date.parse('2026-11-08T08:30:00+09:00'))).toBe(true);
  });
});

describe('朝の申告（2026-11-09 から）', () => {
  it('買い目は省略でき、根拠は必須。申告した時点で公開される', async () => {
    let r = await req('PUT', '/entries', { entries: [{ race_id: R1, rationale: '1号艇の逃げ' }] });
    expect(r.status).toBe(200);
    r = await req('PUT', '/entries', { entries: [{ race_id: R1, tickets: [] }] });
    expect(r.status).toBe(400);
    r = await req('PUT', '/entries', { entries: [{ race_id: R1, rationale: '1号艇の逃げ' }, { race_id: R2, tickets: [{ bet_type: 'nirentan', combo: '1-2' }], rationale: '内枠' }] });
    expect(r.status).toBe(200);
    const d = await req('GET', '/declarations?date=2026-11-09', undefined, null);
    expect(d.body.plans_public).toBe(true);
    expect(d.body.declarations.map((x: any) => [x.race_id, x.tickets, x.rationale, x.changes])).toEqual([
      [R1, [], '1号艇の逃げ', []],
      [R2, [{ bet_type: 'nirentan', combo: '1-2' }], '内枠', []],
    ]);
  });

  it('8:15 で出るレースが固定される（PUT /entries は entry_closed）', async () => {
    await req('PUT', '/entries', { entries: [{ race_id: R1, rationale: 'a' }] });
    at('2026-11-09', '08:15');
    const r = await req('PUT', '/entries', { entries: [{ race_id: R1, rationale: 'a' }, { race_id: R2, rationale: 'b' }] });
    expect(r.status).toBe(409);
    expect(r.body.error.code).toBe('entry_closed');
  });
});

describe('申告の変更（PUT /entries/{race_id}）', () => {
  beforeEach(async () => {
    await req('PUT', '/entries', { entries: [{ race_id: R1, tickets: [{ bet_type: 'sanrentan', combo: '1-2-3' }], rationale: '朝の見立て' }] });
    at('2026-11-09', '09:00');
  });

  it('変更の理由が必須。変えると履歴に最初の申告と変更が積まれ、即時公開される', async () => {
    let r = await req('PUT', `/entries/${R1}`, { tickets: [{ bet_type: 'nirentan', combo: '1-3' }], rationale: '展示で3号艇が良い' });
    expect(r.status).toBe(400);
    r = await req('PUT', `/entries/${R1}`, { tickets: [{ bet_type: 'nirentan', combo: '1-3' }], rationale: '展示で3号艇が良い', change_reason: '展示タイムで3号艇が一番' });
    expect(r.status).toBe(200);
    expect(r.body.changes.map((c: any) => [c.kind, c.rationale, c.change_reason])).toEqual([
      ['declared', '朝の見立て', null],
      ['changed', '展示で3号艇が良い', '展示タイムで3号艇が一番'],
    ]);
    r = await req('PUT', `/entries/${R1}`, { rationale: '買い目は買うときに決める', change_reason: 'オッズが割れた' });
    expect(r.status).toBe(200);
    expect(r.body.changes).toHaveLength(3);
    const race = await req('GET', `/races/${R1}`, undefined, null);
    expect(race.body.entries[0]).toMatchObject({ tickets: [], rationale: '買い目は買うときに決める' });
    expect(race.body.entries[0].changes.map((c: any) => c.kind)).toEqual(['declared', 'changed', 'changed']);
    const mine = await req('GET', '/entries?date=2026-11-09');
    expect(mine.body.entries[0].changes).toHaveLength(3);
  });

  it('申告していないレース・見送ったレース・締切の5分前を過ぎたレースは変えられない。改定前の開催日も変えられない', async () => {
    const body = { rationale: 'x', change_reason: 'y' };
    expect((await req('PUT', `/entries/${R2}`, body)).status).toBe(404);
    expect((await req('PUT', '/entries/20261108-12-07', body)).body.error.code).toBe('entry_change_unavailable');
    at('2026-11-09', '09:55');
    expect((await req('PUT', `/entries/${R1}`, body)).body.error.code).toBe('race_closed');
  });
});

describe('購入・取消・見送りは締切の5分前まで', () => {
  beforeEach(async () => {
    await req('PUT', '/entries', { entries: [{ race_id: R1, tickets: [{ bet_type: 'sanrentan', combo: '1-2-3' }], rationale: '朝の見立て' }, { race_id: R2, rationale: 'b' }] });
    at('2026-11-09', '09:00');
  });

  it('申告したレースは、申告した買い目でなくても買える', async () => {
    const r = await buy(R1, [{ bet_type: 'nirentan', combo: '3-1', amount: 500 }]);
    expect(r.status).toBe(201);
    expect((await buy(R2, [{ bet_type: 'tansho', combo: '1', amount: 100 }])).status).toBe(201);
  });

  it('締切の5分前を過ぎると、購入・取消・見送りはできない', async () => {
    const r = await buy(R1, [{ bet_type: 'sanrentan', combo: '1-2-3', amount: 500 }]);
    at('2026-11-09', '09:54');
    expect((await buy(R1, [{ bet_type: 'sanrentan', combo: '1-2-3', amount: 100 }])).status).toBe(201);
    at('2026-11-09', '09:55');
    const late = await buy(R1, [{ bet_type: 'sanrentan', combo: '1-2-3', amount: 100 }]);
    expect(late.status).toBe(409);
    expect(late.body.error.code).toBe('race_closed');
    expect((await req('DELETE', `/bets/${r.body.submission_id}`)).body.error.code).toBe('bet_locked');
    at('2026-11-09', '10:25');
    expect((await req('POST', `/entries/${R2}/pass`)).body.error.code).toBe('race_closed');
  });

  it('取消だけでは見送りにならないことを応答で伝え、その後に見送れる', async () => {
    const r = await buy(R1, [{ bet_type: 'sanrentan', combo: '1-2-3', amount: 500 }]);
    const c = await req('DELETE', `/bets/${r.body.submission_id}`);
    expect(c.status).toBe(200);
    expect(c.body.note).toContain('取消だけでは見送りになりません');
    expect((await req('POST', `/entries/${R1}/pass`)).status).toBe(201);
  });
});

describe('追加申告（締切の5分前まで）', () => {
  it('朝に申告していないレースを declare: true で追加申告して買え、その後も変更できる', async () => {
    at('2026-11-09', '10:30');
    const r = await buy(R3, [{ bet_type: 'nirentan', combo: '1-2', amount: 300 }], { declare: true, rationale: '直前のオッズ' });
    expect(r.status).toBe(201);
    expect(r.body.declared).toMatchObject({ race_id: R3, late: true });
    expect((await buy(R3, [{ bet_type: 'nirentan', combo: '2-1', amount: 100 }])).status).toBe(201);
    const ch = await req('PUT', `/entries/${R3}`, { tickets: [{ bet_type: 'nirentan', combo: '2-1' }], rationale: '裏も押さえる', change_reason: '2号艇の気配が良い' });
    expect(ch.status).toBe(200);
    at('2026-11-09', '10:55');
    expect((await buy(R3, [{ bet_type: 'nirentan', combo: '1-2', amount: 100 }])).body.error.code).toBe('race_closed');
  });
});
