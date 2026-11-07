// 一部の券種が「不成立」のレース（2026-11-07 戸田7R・江戸川2R）の取り込みと精算。
// 公式HTMLでは成立した券種だけに払戻金があり、ほかは「不成立 ¥100」（全額返還）。着順は2艇以下か、表そのものが無い
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { memoryD1 } from './helpers/d1';
import { ensureSchema } from '../src/db/migrate';
import { settleRace } from '../src/jobs/settlement';
import type { RaceRow } from '../src/db/repo';

vi.mock('cloudflare:workers', () => ({ DurableObject: class {} }));
const { app } = await import('../src/index');

let db: ReturnType<typeof memoryD1>;
const env = () => ({ DB: db, INGEST_TOKEN: 'ing' });
const post = (path: string, body: unknown) =>
  app.request(path, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ing' }, body: JSON.stringify(body) }, env());

const RACE = '20261107-02-07';
const BETS: [string, string, string, number][] = [
  ['a1', 'sanrentan', '1-3-2', 1700],
  ['a1', 'nirentan', '1-6', 300],
  ['a2', 'kakurenpuku', '1=3', 300],
  ['a2', 'tansho', '6', 200],
  ['a2', 'nirenpuku', '4=6', 100],
];

beforeEach(async () => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date('2026-11-07T14:10:00+09:00'));
  db = memoryD1();
  await ensureSchema(db);
  db.raw.exec(`INSERT INTO races (id, race_date, jcd, rno, deadline_at, deadline_ms, status, locked_at, updated_at)
    VALUES ('${RACE}', '2026-11-07', '02', 7, '2026-11-07T13:28:00+09:00', ${Date.parse('2026-11-07T13:28:00+09:00')}, 'locked', 'x', 'x')`);
  for (const a of ['a1', 'a2'])
    db.raw.exec(`INSERT INTO agents (id, realm, display_name, owner_name, api_key_hash, status, terms_agreed_at, created_at) VALUES ('${a}', 'live', '${a}', 'o', 'h${a}', 'active', 'x', 'x')`);
  BETS.forEach(([agent, type, combo, amount], i) =>
    db.raw.exec(`INSERT INTO submissions (id, agent_id, realm, race_id, race_date, rationale, received_at, received_ms) VALUES ('s${i}', '${agent}', 'live', '${RACE}', '2026-11-07', 'r', 'x', 0);
      INSERT INTO bets (id, submission_id, agent_id, realm, race_id, race_date, bet_type, combo, amount, status, received_ms, updated_at)
      VALUES ('b${i}', 's${i}', '${agent}', 'live', '${RACE}', '2026-11-07', '${type}', '${combo}', ${amount}, 'locked', 0, 'x')`),
  );
});
afterEach(() => vi.useRealTimers());

describe('一部の券種が不成立のレース', () => {
  it('着順なし・単勝だけ成立の結果を受け付け、不成立の券種と返還艇の舟券を返還して精算する', async () => {
    const res = await post('/internal/results', {
      results: [{
        race_id: RACE, status: 'official', finish: [], refunded_boats: [1, 2, 3, 5],
        payouts: [{ bet_type: 'tansho', combo: '6', payout: 130 }],
        unsold: ['sanrentan', 'sanrenpuku', 'nirentan', 'nirenpuku', 'kakurenpuku', 'fukusho'],
      }],
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ upserted: 1, rejected: [] });

    const race = db.raw.prepare('SELECT * FROM races WHERE id = ?').get(RACE) as unknown as RaceRow;
    expect(await settleRace(db, race, Date.now())).toBe(true);

    const bets = db.raw.prepare('SELECT id, status, payout, refund_reason FROM bets ORDER BY id').all();
    expect(bets).toEqual([
      { id: 'b0', status: 'refunded', payout: 0, refund_reason: 'boat_refunded' },
      { id: 'b1', status: 'refunded', payout: 0, refund_reason: 'boat_refunded' },
      { id: 'b2', status: 'refunded', payout: 0, refund_reason: 'boat_refunded' },
      { id: 'b3', status: 'hit', payout: 260, refund_reason: null },
      { id: 'b4', status: 'refunded', payout: 0, refund_reason: 'bet_type_unsold' },
    ]);
    expect((db.raw.prepare('SELECT status FROM races WHERE id = ?').get(RACE) as { status: string }).status).toBe('settled');

    const detail = (await (await app.request(`/races/${RACE}`, {}, env())).json()) as { result: { unsold: string[] } };
    expect(detail.result.unsold).toContain('sanrentan');
  });
});
