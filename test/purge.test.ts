// 過去分（大会開始前のレース）の削除（2026-11-07 管理者決定）
import { describe, expect, it } from 'vitest';
import { memoryD1 } from './helpers/d1';
import { ensureSchema } from '../src/db/migrate';
import { PURGE_BEFORE, purgeHistory } from '../src/jobs/purge';

const now = Date.parse('2026-11-07T12:00:00+09:00');

async function setup() {
  const db = memoryD1();
  await ensureSchema(db);
  const race = (id: string, date: string) =>
    `INSERT INTO races (id, race_date, jcd, rno, deadline_at, deadline_ms, status, updated_at) VALUES ('${id}', '${date}', '01', 1, 'x', 0, 'settled', 'x');
     INSERT INTO race_results (race_id, status, finish_json, refunded_boats_json, payouts_json, fetched_at) VALUES ('${id}', 'official', '[]', '[]', '[]', 'x');
     INSERT INTO race_boats (race_id, boat, race_date, jcd, rno, toban) VALUES ('${id}', 1, '${date}', '01', 1, '4444');
     INSERT INTO race_payouts (race_id, race_date, jcd, bet_type, combo, payout) VALUES ('${id}', '${date}', '01', 'tansho', '1', 150);`;
  db.raw.exec(
    race('20260901-01-01', '2026-09-01') +
      race('20260902-01-01', '2026-09-02') +
      race('20260903-01-01', '2026-09-03') +
      race('20261104-01-01', '2026-11-04') +
      `INSERT INTO agents (id, realm, display_name, owner_name, api_key_hash, status, terms_agreed_at, created_at) VALUES ('a1', 'sandbox', 'x', 'o', 'h', 'active', 'x', 'x');
       INSERT INTO submissions (id, agent_id, realm, race_id, race_date, rationale, received_at, received_ms) VALUES ('s1', 'a1', 'sandbox', '20260902-01-01', '2026-09-02', 'r', 'x', 0);
       INSERT INTO bets (id, submission_id, agent_id, realm, race_id, race_date, bet_type, combo, amount, status, received_ms, updated_at) VALUES ('b1', 's1', 'a1', 'sandbox', '20260902-01-01', '2026-09-02', 'tansho', '1', 100, 'miss', 0, 'x');
       INSERT INTO agg_months (kind, ym, dirty_at, built_at) VALUES ('motor', '2026-09', 'x', 'x');
       INSERT INTO agg_motor (jcd, motor_no, ym, n, w1, w2, w3, tenji_rank_sum, tenji_n) VALUES ('01', 1, '2026-09', 1, 0, 0, 0, 0, 0);`,
  );
  return db;
}

const count = (db: ReturnType<typeof memoryD1>, sql: string) => (db.raw.prepare(sql).get() as { n: number }).n;

describe('過去分の削除', () => {
  it('大会開始前の日を古い順に消し、舟券のある日は残す。消し終えたら事前集計の古い月も消す', async () => {
    const db = await setup();
    expect(await purgeHistory(db, now)).toEqual(['purge: 2026-09-01', 'purge: kept 2026-09-02 (bets or entries)']);
    expect(await purgeHistory(db, now)).toEqual(['purge: 2026-09-03', 'purge: history done']);
    expect(await purgeHistory(db, now)).toEqual([]);

    expect(db.raw.prepare('SELECT id FROM races ORDER BY id').all()).toEqual([{ id: '20260902-01-01' }, { id: '20261104-01-01' }]);
    expect(count(db, "SELECT COUNT(*) AS n FROM race_boats WHERE race_id = '20260901-01-01'")).toBe(0);
    expect(count(db, "SELECT COUNT(*) AS n FROM race_payouts WHERE race_id = '20260903-01-01'")).toBe(0);
    expect(count(db, "SELECT COUNT(*) AS n FROM race_results WHERE race_id = '20260903-01-01'")).toBe(0);
    expect(count(db, "SELECT COUNT(*) AS n FROM race_boats WHERE race_id = '20261104-01-01'")).toBe(1); // 大会の日は消さない
    expect(count(db, 'SELECT COUNT(*) AS n FROM agg_motor')).toBe(0);
    expect(db.raw.prepare('SELECT ym FROM agg_months GROUP BY ym').all()).toEqual([{ ym: PURGE_BEFORE.slice(0, 7) }]);
  });
});
