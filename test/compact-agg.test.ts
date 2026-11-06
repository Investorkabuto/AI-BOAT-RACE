// v1.3（決定50〜52）: 詰めた形をやめても参加APIの出走表・競走成績が変わらないこと、片付けと事前集計の SQL を、本物の SQLite で確かめる
import { beforeEach, describe, expect, it } from 'vitest';
import { memoryD1 } from './helpers/d1';
import { ensureSchema } from '../src/db/migrate';
import { internalApi } from '../src/routes/internal';
import { publicApi } from '../src/routes/public';
import { normalizeCard, type CardRacer } from '../src/lib/cards';
import { normalizeRecord } from '../src/lib/records';
import { addDays, jstDate, jstToMs } from '../src/lib/time';
import { raceId } from '../src/lib/venues';
import { compactPacked, sameRows, samePayouts } from '../src/jobs/compact';
import { aggregate, markAggDirty } from '../src/jobs/aggregate';

const TOKEN = 't';
const racer = (boat: number, over: Record<string, unknown> = {}) => ({
  boat, toban: String(4000 + boat), name: `選手${boat}`, age: 30 + boat, branch: '福岡', weight: 52, grade: 'A1',
  nat_win: 6.68, nat_2r: 44.9, loc_win: 5.92, loc_2r: 45.83, motor_no: 10 + boat, motor_2r: 39.74, boat_no: 140 + boat, boat_2r: 35.51,
  series: [[3, 2], [1]], next_rno: null, ...over,
});
const card = () => ({ fixed_course: false, distance: 1800, day: 2, series_title: '一般戦', racers: [1, 2, 3, 4, 5, 6].map((b) => racer(b)) });
const krow = (rank: string, boat: number, over: Record<string, unknown> = {}) => ({
  rank, boat, toban: String(4000 + boat), motor_no: 10 + boat, boat_no: 140 + boat, tenji: 6.8 + boat / 100, course: boat, st: 0.1 + boat / 100, time: 110.5, ...over,
});
// 3号艇はモーターが替わった（B は 13、K は 99）。6号艇はフライング
const record = () => ({
  weather: '晴', wind_dir: '北', wind_m: 2, wave_cm: 2, kimarite: '逃げ', unsold: [],
  rows: [krow('1', 1), krow('2', 3, { motor_no: 99 }), krow('3', 2), krow('4', 4), krow('5', 5, { time: null }), krow('F', 6, { time: null })],
  payouts: [
    { bet_type: 'tansho', combo: '1', payout: 150, pop: null },
    { bet_type: 'nirentan', combo: '1-3', payout: 620, pop: 3 },
    { bet_type: 'sanrentan', combo: '1-3-2', payout: 2350, pop: 7 },
    { bet_type: 'sanrenpuku', combo: '1=2=3', payout: 480, pop: 2 },
  ],
});

let db: ReturnType<typeof memoryD1>;
const env = () => ({ DB: db, INGEST_TOKEN: TOKEN });
const put = (path: string, body: unknown) =>
  internalApi.request(path, { method: 'PUT', headers: { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json' }, body: JSON.stringify(body) }, env());
const getRace = async (id: string) => (await (await publicApi.request(`/races/${id}`, {}, env())).json()) as { card: { racers: CardRacer[] } | null; record: Record<string, unknown> | null };
const one = <T>(sql: string, ...args: (string | number)[]) => db.raw.prepare(sql).get(...args) as T;

const expected = () => {
  const c = normalizeCard(card());
  const r = normalizeRecord(record());
  if (!c.ok || !r.ok) throw new Error('fixture');
  return { racers: c.card.racers, record: r.record };
};

beforeEach(async () => {
  db = memoryD1();
  await ensureSchema(db);
});

describe('過去分の取り込み（詰めた形を書かない）', () => {
  it('race_boats・race_payouts から、取り込んだとおりの出走表と競走成績を返す', async () => {
    const date = addDays(jstDate(Date.now()), -30);
    const res = await put('/history', { race_date: date, races: [{ jcd: '22', rno: 1, deadline: '10:00', card: card(), record: record() }] });
    expect(res.status).toBe(200);
    const id = raceId(date, '22', 1);
    expect(one<{ rows: string }>('SELECT rows FROM race_cards WHERE race_id = ?', id).rows).toBe('');
    expect(one<{ rows: string; payouts: string }>('SELECT rows, payouts FROM race_records WHERE race_id = ?', id)).toEqual({ rows: '', payouts: '' });
    // K の番号が B と違う艇だけ k_motor_no に入る
    expect(db.raw.prepare('SELECT boat, motor_no, k_motor_no FROM race_boats WHERE race_id = ? AND k_motor_no IS NOT NULL').all(id)).toEqual([{ boat: 3, motor_no: 13, k_motor_no: 99 }]);

    const got = await getRace(id);
    const exp = expected();
    expect(got.card!.racers).toEqual(exp.racers);
    const rec = got.record as { rows: never[]; payouts: never[]; kimarite: string; unsold: unknown[] };
    expect(sameRows(rec.rows, exp.record.rows)).toBe(true);
    expect(samePayouts(rec.payouts, exp.record.payouts)).toBe(true);
    expect(rec.rows.map((r: { boat: number }) => r.boat)).toEqual([1, 3, 2, 4, 5, 6]); // 着順の順、記号の艇は後ろ
    expect(rec.kimarite).toBe('逃げ');
    expect(rec.unsold).toEqual([]);
  });
});

describe('当日の取り込み → 片付け', () => {
  it('片付けの前後で、参加APIの出走表と競走成績は変わらない。0012 より前の分は K の番号を入れ直す', async () => {
    const date = addDays(jstDate(Date.now()), 1);
    const id = raceId(date, '22', 1);
    expect((await put('/cards', { race_date: date, races: [{ jcd: '22', rno: 1, deadline: '15:00', ...card() }] })).status).toBe(200);
    expect(one<{ rows: string }>('SELECT rows FROM race_cards WHERE race_id = ?', id).rows).not.toBe(''); // 締切前は版の比較のために持つ
    db.raw.prepare('UPDATE races SET deadline_ms = ? WHERE id = ?').run(Date.now() - 1000, id);
    expect((await put('/records', { race_date: date, races: [{ jcd: '22', rno: 1, ...record() }] })).status).toBe(200);
    expect(one<{ rows: string }>('SELECT rows FROM race_records WHERE race_id = ?', id).rows).not.toBe('');

    const before = await getRace(id);
    expect(before.card!.racers).toEqual(expected().racers);
    db.raw.prepare('UPDATE race_boats SET k_motor_no = NULL').run(); // 0012 より前に取り込んだ分

    // 直近（RECORD_KEEP_DAYS 以内）は競走成績を残す
    await compactPacked(db, jstToMs(addDays(date, 1), 12, 0), '2099-01-01T00:00:00+09:00');
    expect(one<{ rows: string }>('SELECT rows FROM race_cards WHERE race_id = ?', id).rows).toBe('');
    expect(one<{ rows: string }>('SELECT rows FROM race_records WHERE race_id = ?', id).rows).not.toBe('');

    const log = await compactPacked(db, jstToMs(addDays(date, 10), 12, 0), '2099-01-01T00:00:00+09:00');
    expect(log).toEqual(['compact records: 1 races']);
    expect(one<{ rows: string; payouts: string }>('SELECT rows, payouts FROM race_records WHERE race_id = ?', id)).toEqual({ rows: '', payouts: '' });
    expect(one<{ k_motor_no: number }>('SELECT k_motor_no FROM race_boats WHERE race_id = ? AND boat = 3', id).k_motor_no).toBe(99);
    expect(await getRace(id)).toEqual(before);
  });

  it('race_boats と合わないレースは空にしない', async () => {
    const date = addDays(jstDate(Date.now()), 1);
    const id = raceId(date, '22', 1);
    await put('/cards', { race_date: date, races: [{ jcd: '22', rno: 1, deadline: '15:00', ...card() }] });
    db.raw.prepare("UPDATE race_boats SET name = '別人' WHERE race_id = ? AND boat = 2").run(id);
    const log = await compactPacked(db, jstToMs(addDays(date, 1), 12, 0), '2099-01-01T00:00:00+09:00');
    expect(log).toEqual(['compact cards: 0 races, 1 not matching race_boats (kept)']);
    expect(one<{ rows: string }>('SELECT rows FROM race_cards WHERE race_id = ?', id).rows).not.toBe('');
  });
});

describe('事前集計', () => {
  const load = async () => {
    const date = addDays(jstDate(Date.now()), -30);
    await put('/history', { race_date: date, races: [{ jcd: '22', rno: 1, deadline: '10:00', card: card(), record: record() }] });
    return date;
  };

  it('取り込んだ月を、選手×コース・モーター・場×コース・決まり手・配当の分布に集計する', async () => {
    const date = await load();
    const ym = date.slice(0, 7);
    const log = await aggregate(db, Date.now(), 10);
    expect(log.filter((l) => l.startsWith('aggregate: ') && !l.includes('seeded'))).toEqual([
      `aggregate: motor ${ym}`, `aggregate: payout ${ym}`, `aggregate: racer_course ${ym}`, `aggregate: venue_course ${ym}`,
    ]);
    expect(one('SELECT n, w1, w2, w3, st_sum, st_n, f_n, l_n FROM agg_racer_course WHERE toban = ? AND ym = ? AND course = 1', '4001', ym)).toEqual({
      n: 1, w1: 1, w2: 1, w3: 1, st_sum: 0.11, st_n: 1, f_n: 0, l_n: 0,
    });
    // F の艇は出走に数え、ST は F の側に持つ
    expect(one('SELECT n, st_n, f_n, f_st_sum FROM agg_racer_course WHERE toban = ? AND course = 6', '4006')).toEqual({ n: 1, st_n: 0, f_n: 1, f_st_sum: 0.16 });
    // 実際に乗ったモーター（3号艇は K の 99）。展示順位は展示タイムの順
    expect(one('SELECT n, w2, tenji_rank_sum, tenji_n FROM agg_motor WHERE jcd = ? AND motor_no = 99', '22')).toEqual({ n: 1, w2: 1, tenji_rank_sum: 3, tenji_n: 1 });
    expect(one('SELECT COUNT(*) AS n FROM agg_motor WHERE motor_no = 13')).toEqual({ n: 0 });
    expect(one('SELECT n, w1 FROM agg_venue_course WHERE jcd = ? AND course = 1', '22')).toEqual({ n: 1, w1: 1 });
    expect(db.raw.prepare('SELECT course, kimarite, n FROM agg_venue_kimarite').all()).toEqual([{ course: 1, kimarite: '逃げ', n: 1 }]);
    expect(one('SELECT band, pop, n, payout_sum FROM agg_payout WHERE bet_type = ?', 'sanrentan')).toEqual({ band: 2000, pop: 7, n: 1, payout_sum: 2350 });

    // 作り直しの印が無ければ何もしない
    expect((await aggregate(db, Date.now(), 10)).filter((l) => l.startsWith('aggregate: '))).toEqual([]);
  });

  it('作り直しても値が同じなら、集計の表には書き込まない', async () => {
    const date = await load();
    await aggregate(db, Date.now(), 10);
    await markAggDirty(db, [date], Date.now() + 1000);
    const usage = { key: 'bg:usage:x', r: 0, w: 0 };
    await aggregate(db, Date.now(), 10, usage);
    expect(usage.w).toBe(4); // agg_months の4行（表ごとの built_at）だけ
  });

  it('作り直しで、値が変わった行を書き換え、無くなった行を消す', async () => {
    const date = await load();
    await aggregate(db, Date.now(), 10);
    const id = raceId(date, '22', 1);
    db.raw.prepare('UPDATE race_boats SET course = 2 WHERE race_id = ? AND boat = 1').run(id);
    db.raw.prepare('UPDATE race_boats SET course = 1 WHERE race_id = ? AND boat = 2').run(id);
    await markAggDirty(db, [date], Date.now() + 1000);
    await aggregate(db, Date.now(), 10);
    expect(db.raw.prepare('SELECT toban, course FROM agg_racer_course WHERE toban IN (?, ?) ORDER BY toban').all('4001', '4002')).toEqual([
      { toban: '4001', course: 2 }, { toban: '4002', course: 1 },
    ]);
    db.raw.prepare('DELETE FROM race_payouts').run();
    await markAggDirty(db, [date], Date.now() + 2000);
    await aggregate(db, Date.now(), 10);
    expect(one('SELECT COUNT(*) AS n FROM agg_payout')).toEqual({ n: 0 });
  });
});
