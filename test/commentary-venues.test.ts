// 実況のタスクを積む「日×場」の判定（定時処理が5分ごとに流す）。2026-11-12: 舟券の総数に比例して読み取りが増えていたのを直した
import { describe, expect, it } from 'vitest';
import { memoryD1 } from './helpers/d1';
import { ensureSchema } from '../src/db/migrate';
import { COMMENTARY_VENUES_SQL } from '../src/operator/scheduler';

async function setup() {
  const db = memoryD1();
  await ensureSchema(db);
  const race = (id: string, date: string, jcd: string, status: string) =>
    `INSERT INTO races (id, race_date, jcd, rno, deadline_at, deadline_ms, status, updated_at) VALUES ('${id}', '${date}', '${jcd}', ${Number(id.slice(-2))}, 'x', 0, '${status}', 'x');`;
  const bet = (id: string, raceId: string, date: string, realm: string, status: string) =>
    `INSERT INTO bets (id, submission_id, agent_id, realm, race_id, race_date, bet_type, combo, amount, status, received_ms, updated_at) VALUES ('${id}', 's', 'a', '${realm}', '${raceId}', '${date}', 'tansho', '1', 100, '${status}', 0, 'x');`;
  db.raw.exec(
    `INSERT INTO agents (id, realm, display_name, owner_name, api_key_hash, status, terms_agreed_at, created_at) VALUES ('a', 'live', 'x', 'o', 'h', 'active', 'x', 'x');` +
    race('20261111-05-01', '2026-11-11', '05', 'settled') +
    `INSERT INTO submissions (id, agent_id, realm, race_id, race_date, rationale, received_at, received_ms) VALUES ('s', 'a', 'live', '20261111-05-01', '2026-11-11', 'r', 'x', 0);` +
    // 11/11 05場: 全レース精算・本番の舟券あり → 対象
    race('20261111-05-02', '2026-11-11', '05', 'settled') + bet('b1', '20261111-05-02', '2026-11-11', 'live', 'miss') +
      // 11/11 06場: 舟券なし → 対象外
      race('20261111-06-01', '2026-11-11', '06', 'settled') +
      // 11/11 07場: サンドボックスの舟券だけ → 対象外
      race('20261111-07-01', '2026-11-11', '07', 'settled') + bet('b2', '20261111-07-01', '2026-11-11', 'sandbox', 'hit') +
      // 11/12 05場: まだ締切前のレースが残る → 対象外
      race('20261112-05-01', '2026-11-12', '05', 'settled') + race('20261112-05-02', '2026-11-12', '05', 'scheduled') + bet('b3', '20261112-05-01', '2026-11-12', 'live', 'hit') +
      // 11/12 12場: 返還だけ・すでにタスクあり → 対象外
      race('20261112-12-01', '2026-11-12', '12', 'cancelled') + bet('b4', '20261112-12-01', '2026-11-12', 'live', 'refunded') +
      "INSERT INTO operator_tasks (id, type, status, subject_id, payload_json, due_at, created_at) VALUES ('t1', 'commentary', 'pending', '2026-11-12:12', '{}', 'x', 'x');" +
      // 11/12 24場: 返還だけで判定済み → 対象
      race('20261112-24-01', '2026-11-12', '24', 'cancelled') + bet('b5', '20261112-24-01', '2026-11-12', 'live', 'refunded') +
      // 範囲より前の日 → 対象外
      race('20261110-05-01', '2026-11-10', '05', 'settled') + bet('b6', '20261110-05-01', '2026-11-10', 'live', 'hit'),
  );
  return db;
}

describe('実況のタスクを積む日×場', () => {
  it('全レースが終わり、本番の判定済みの舟券があり、まだタスクの無い日×場だけを返す', async () => {
    const db = await setup();
    const rows = db.raw.prepare(`${COMMENTARY_VENUES_SQL} ORDER BY r.race_date, r.jcd`).all('2026-11-11', '2026-11-11');
    expect(rows).toEqual([
      { race_date: '2026-11-11', jcd: '05' },
      { race_date: '2026-11-12', jcd: '24' },
    ]);
  });

  it('舟券は日付の索引で絞り、日×場ごとに大会の舟券を全部たどらない', async () => {
    const db = await setup();
    const plan = (db.raw.prepare(`EXPLAIN QUERY PLAN ${COMMENTARY_VENUES_SQL}`).all('2026-11-11', '2026-11-11') as { detail: string }[]).map((x) => x.detail).join('\n');
    expect(plan).toMatch(/SEARCH b USING (COVERING )?INDEX bets_date \(realm=\? AND race_date>\?\)/);
    expect(plan).not.toMatch(/CORRELATED[^\n]*\n[^\n]*SEARCH b /);
    expect(plan).not.toMatch(/bets_race \(realm=\?\)/);
  });
});

describe('舟券を AI×レース で引く相関サブクエリ（参加者ページ・申告の一覧）', () => {
  it('bets_agent_race の索引で引き、そのAIの舟券を全期間たどらない', async () => {
    const db = memoryD1();
    await ensureSchema(db);
    const q = `SELECT e.race_id,
         (SELECT COALESCE(SUM(payout), 0) FROM bets b WHERE b.agent_id = e.agent_id AND b.race_id = e.race_id AND b.status = 'hit') AS payout,
         EXISTS (SELECT 1 FROM bets b WHERE b.agent_id = e.agent_id AND b.race_id = e.race_id AND b.status != 'cancelled') AS bought
       FROM entries e WHERE e.agent_id = ? AND e.realm = 'live' AND e.race_date BETWEEN ? AND ?`;
    const plan = (db.raw.prepare(`EXPLAIN QUERY PLAN ${q}`).all('a', '2026-11-01', '2026-11-30') as { detail: string }[]).map((x) => x.detail).join('\n');
    expect(plan).toMatch(/SEARCH b USING (COVERING )?INDEX bets_agent_race \(agent_id=\? AND race_id=\?/);
    expect(plan).not.toMatch(/bets_agent_date \(agent_id=\?\)/);
  });
});
