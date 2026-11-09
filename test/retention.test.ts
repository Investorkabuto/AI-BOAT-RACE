// 保持期間（決定66）: もちのフィードと直前情報・オッズは、90日より古い日の分を1日1回消す
import { describe, expect, it } from 'vitest';
import { memoryD1 } from './helpers/d1';
import { ensureSchema } from '../src/db/migrate';
import { RETENTION_DAYS, purgeRetention } from '../src/jobs/purge';

const at = (iso: string) => Date.parse(iso);
const count = (db: ReturnType<typeof memoryD1>, t: string) => (db.raw.prepare(`SELECT COUNT(*) AS n FROM ${t}`).get() as { n: number }).n;

async function setup() {
  const db = memoryD1();
  await ensureSchema(db);
  const day = (ymd: string, date: string) =>
    `INSERT INTO card_supplements (race_id, race_date, race_json, received_at) VALUES ('${ymd}-01-01', '${date}', '{}', 'x');
     INSERT INTO card_supplement_days (race_date, schema_version, races, received_at) VALUES ('${date}', 1, 1, 'x');
     INSERT INTO race_beforeinfo (race_id, fetched_at, data_json) VALUES ('${ymd}-01-01', 'x', '{}');
     INSERT INTO race_odds_v2 (race_id, slot, fetched_at, data_json) VALUES ('${ymd}-01-01', 't30', 'x', '{}');
     INSERT INTO race_odds_v2 (race_id, slot, fetched_at, data_json) VALUES ('${ymd}-01-01', 't10', 'x', '{}');`;
  // 2027-02-07 から見て90日前は 2026-11-09。それより前（11/08）は消え、11/09 は残る
  db.raw.exec(day('20261108', '2026-11-08') + day('20261109', '2026-11-09') + day('20270207', '2027-02-07'));
  return db;
}

describe('保持期間の削除', () => {
  it(`${RETENTION_DAYS}日より古い日の分を消し、同じ日に2回目は何もしない`, async () => {
    const db = await setup();
    const now = at('2027-02-07T00:05:00+09:00');
    expect(await purgeRetention(db, now)).toEqual(['purge: retention before 2026-11-09 (5 rows)']);
    expect(count(db, 'card_supplements')).toBe(2);
    expect(count(db, 'card_supplement_days')).toBe(2);
    expect(count(db, 'race_beforeinfo')).toBe(2);
    expect(count(db, 'race_odds_v2')).toBe(4);
    expect(db.raw.prepare('SELECT MIN(race_id) AS m FROM card_supplements').get()).toEqual({ m: '20261109-01-01' });
    expect(await purgeRetention(db, now + 60_000)).toEqual([]);
  });

  it('消すものが無ければ何も書かない（ログも出さない）', async () => {
    const db = await setup();
    expect(await purgeRetention(db, at('2026-11-10T00:05:00+09:00'))).toEqual([]);
    expect(count(db, 'card_supplements')).toBe(3);
  });
});
