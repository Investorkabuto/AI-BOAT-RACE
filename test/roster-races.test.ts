// GET /roster/{agent_id}/races（参加者ページの「エントリー」。1か月分のエントリーと結果、日ごとのまとめ）
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { memoryD1 } from './helpers/d1';
import { ensureSchema } from '../src/db/migrate';

vi.mock('cloudflare:workers', () => ({ DurableObject: class {} }));
const { app } = await import('../src/index');

let db: ReturnType<typeof memoryD1>;
const env = () => ({ DB: db });
const get = async (path: string) => {
  const res = await app.request(path, { headers: { Accept: 'application/json' } }, env());
  return { status: res.status, body: (await res.json()) as any };
};

const race = (id: string, date: string, jcd: string, rno: number, hm: string, status: string) =>
  `INSERT INTO races (id, race_date, jcd, rno, deadline_at, deadline_ms, status, updated_at)
   VALUES ('${id}', '${date}', '${jcd}', ${rno}, '${date}T${hm}:00+09:00', ${Date.parse(`${date}T${hm}:00+09:00`)}, '${status}', 'x');`;
const bet = (id: string, raceId: string, date: string, combo: string, amount: number, status: string, payout: number) =>
  `INSERT INTO submissions (id, agent_id, realm, race_id, race_date, rationale, received_at, received_ms) VALUES ('s${id}', 'a1', 'live', '${raceId}', '${date}', 'r', 'x', 0);
   INSERT INTO bets (id, submission_id, agent_id, realm, race_id, race_date, bet_type, combo, amount, status, payout, received_ms, updated_at)
   VALUES ('${id}', 's${id}', 'a1', 'live', '${raceId}', '${date}', 'nirentan', '${combo}', ${amount}, '${status}', ${payout}, 0, 'x');`;
const entry = (raceId: string, date: string, status = 'entered') =>
  `INSERT INTO entries (realm, agent_id, race_id, race_date, status, declared_at) VALUES ('live', 'a1', '${raceId}', '${date}', '${status}', 'x');`;

beforeEach(async () => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date('2026-11-08T12:00:00+09:00'));
  db = memoryD1();
  await ensureSchema(db);
  db.raw.exec(`INSERT INTO agents (id, realm, display_name, owner_name, api_key_hash, status, terms_agreed_at, created_at) VALUES ('a1', 'live', 'ハヤテ', 'o', 'h', 'active', 'x', 'x');`);
  db.raw.exec(
    race('20261105-02-03', '2026-11-05', '02', 3, '10:00', 'settled') + entry('20261105-02-03', '2026-11-05') + bet('b1', '20261105-02-03', '2026-11-05', '1-2', 1000, 'hit', 3200) +
    race('20261105-04-08', '2026-11-05', '04', 8, '13:00', 'settled') + entry('20261105-04-08', '2026-11-05') + bet('b2', '20261105-04-08', '2026-11-05', '3-4', 500, 'miss', 0) +
    race('20261106-12-01', '2026-11-06', '12', 1, '11:00', 'settled') + entry('20261106-12-01', '2026-11-06', 'passed') +
    race('20261108-01-05', '2026-11-08', '01', 5, '15:00', 'scheduled') + entry('20261108-01-05', '2026-11-08') + bet('b3', '20261108-01-05', '2026-11-08', '1-3', 800, 'accepted', 0) +
    race('20261031-01-01', '2026-10-31', '01', 1, '10:00', 'settled') + entry('20261031-01-01', '2026-10-31') + bet('b4', '20261031-01-01', '2026-10-31', '2-1', 400, 'hit', 900),
  );
});
afterEach(() => vi.useRealTimers());

describe('GET /roster/{agent_id}/races', () => {
  it('その月のエントリーを締切順に返し、日ごとのレース数・的中数・回収率をまとめる', async () => {
    const { status, body } = await get('/roster/a1/races?month=2026-11');
    expect(status).toBe(200);
    expect(body.entries.map((e: any) => [e.date, e.race_id, e.state])).toEqual([
      ['2026-11-05', '20261105-02-03', 'hit'],
      ['2026-11-05', '20261105-04-08', 'miss'],
      ['2026-11-06', '20261106-12-01', 'passed'],
      ['2026-11-08', '20261108-01-05', 'pending'],
    ]);
    expect(body.entries[0]).toMatchObject({ label: expect.any(String), amount: 1000, payout: 3200, bets: [{ combo: '1-2', status: 'hit', payout: 3200 }] });
    expect(body.days).toEqual([
      { date: '2026-11-05', races: 2, hits: 1, stake: 1500, payout: 3200, recovery_pct: expect.closeTo(213.3, 1) },
      { date: '2026-11-06', races: 1, hits: 0, stake: 0, payout: 0, recovery_pct: null },
      { date: '2026-11-08', races: 1, hits: 0, stake: 0, payout: 0, recovery_pct: null },
    ]);
  });

  it('月を指定すると、その月だけを返す', async () => {
    const { body } = await get('/roster/a1/races?month=2026-10');
    expect(body.entries.map((e: any) => e.race_id)).toEqual(['20261031-01-01']);
    expect(body.days).toMatchObject([{ date: '2026-10-31', races: 1, hits: 1 }]);
  });

  it('今日のエントリーは GET /roster/{agent_id} の today.entries と同じ内容（date を除く）', async () => {
    const [{ body: month }, { body: one }] = await Promise.all([get('/roster/a1/races?month=2026-11'), get('/roster/a1?date=2026-11-08')]);
    const { date: _d, ...todayFromMonth } = month.entries.find((e: any) => e.date === '2026-11-08');
    expect(one.today.entries).toEqual([todayFromMonth]);
  });

  it('存在しないAIは 404、月の形が違えば 400', async () => {
    expect((await get('/roster/nobody/races?month=2026-11')).status).toBe(404);
    expect((await get('/roster/a1/races?month=2026-11-01')).status).toBe(400);
  });
});
