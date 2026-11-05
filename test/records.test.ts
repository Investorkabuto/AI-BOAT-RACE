import { describe, expect, it } from 'vitest';
import { normalizeRecord, packPayouts, packRows, packUnsold, unpackPayouts, unpackRows, unpackUnsold } from '../src/lib/records';

// 2026-11-04 大村 1R（Kファイルの実物を scripts/boatrace_text.py で解析した結果）
const row = (rank: string, boat: number, toban: string, over: Record<string, unknown> = {}) => ({
  rank, boat, toban, motor_no: 53, boat_no: 61, tenji: 6.81, course: boat, st: 0.03, time: 109.4, ...over,
});
const rows = () => [
  row('1', 1, '4423'), row('2', 3, '5308', { time: 110.0 }), row('3', 6, '4410'), row('4', 2, '3315'),
  row('5', 4, '4213', { time: null }), row('6', 5, '5086', { time: null }),
];
const payouts = () => [
  { bet_type: 'tansho', combo: '1', payout: 120, pop: null },
  { bet_type: 'fukusho', combo: '1', payout: 110, pop: null },
  { bet_type: 'nirentan', combo: '1-3', payout: 300, pop: 1 },
  { bet_type: 'nirenpuku', combo: '1=3', payout: 260, pop: 1 },
  { bet_type: 'kakurenpuku', combo: '1=3', payout: 180, pop: 3 },
  { bet_type: 'sanrentan', combo: '1-3-6', payout: 1060, pop: 2 },
  { bet_type: 'sanrenpuku', combo: '1=3=6', payout: 690, pop: 4 },
];
const base = (over: Record<string, unknown> = {}) => ({ weather: '曇り', wind_dir: '北', wind_m: 1, wave_cm: 1, kimarite: '逃げ', rows: rows(), payouts: payouts(), unsold: [], ...over });

describe('normalizeRecord', () => {
  it('実物の形を受け付ける（着順は文字で来ても数にそろえる）', () => {
    const r = normalizeRecord(base());
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.record.rows.map((x) => x.place)).toEqual([1, 2, 3, 4, 5, 6]);
      expect(r.record.weather).toBe('曇り');
      expect(r.record.kimarite).toBe('逃げ');
    }
  });

  it('F・L・K・S の記号はそのまま残す（欠場は展示・進入・STが無い）', () => {
    const r = normalizeRecord(base({ rows: [...rows().slice(0, 5), row('K0', 5, '5086', { tenji: null, course: null, st: null, time: null })] }));
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.record.rows[5]).toMatchObject({ place: 'K0', tenji: null, course: null, st: null });
  });

  it('特払いの組番 "*" と、不成立の券種を受け付ける', () => {
    const r = normalizeRecord(base({ payouts: [{ bet_type: 'tansho', combo: '*', payout: 70, pop: null }, ...payouts().slice(1, 3)], unsold: ['kakurenpuku', 'sanrentan'] }));
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.record.payouts[0]!.combo).toBe('*');
      expect(r.record.unsold).toEqual(['kakurenpuku', 'sanrentan']);
    }
  });

  it('順序のない券種の組番は昇順の "=" にそろう', () => {
    const r = normalizeRecord(base({ payouts: [{ bet_type: 'sanrenpuku', combo: '6=1=3', payout: 690, pop: 4 }] }));
    expect(r.ok && r.record.payouts[0]!.combo).toBe('1=3=6');
  });

  it.each([
    ['艇が3つ', { rows: rows().slice(0, 3) }],
    ['1着がいない', { rows: rows().map((r) => (r.rank === '1' ? { ...r, rank: '2' } : r)) }],
    ['着順の欄', { rows: [{ ...rows()[0]!, rank: 'X' }, ...rows().slice(1)] }],
    ['枠番の重複', { rows: [rows()[0]!, { ...rows()[1]!, boat: 1 }, ...rows().slice(2)] }],
    ['登録番号', { rows: [{ ...rows()[0]!, toban: '12' }, ...rows().slice(1)] }],
    ['進入コース', { rows: [{ ...rows()[0]!, course: 7 }, ...rows().slice(1)] }],
    ['展示タイム', { rows: [{ ...rows()[0]!, tenji: 61 }, ...rows().slice(1)] }],
    ['払戻金が空', { payouts: [] }],
    ['券種', { payouts: [{ bet_type: 'xx', combo: '1', payout: 100, pop: null }] }],
    ['組番', { payouts: [{ bet_type: 'nirentan', combo: '9-9', payout: 100, pop: 1 }] }],
    ['払戻金の負数', { payouts: [{ bet_type: 'tansho', combo: '1', payout: -1, pop: null }] }],
    ['不成立の券種', { unsold: ['zz'] }],
    ['風速', { wind_m: 'x' }],
  ])('不正は拒否する: %s', (_name, over) => {
    expect(normalizeRecord(base(over as Record<string, unknown>)).ok).toBe(false);
  });
});

describe('保存用の詰めた形', () => {
  it('艇は ×100 / ×10 の整数で持ち、読み戻すと元の値になる', () => {
    const n = normalizeRecord(base());
    if (!n.ok) throw new Error(n.reason);
    const packed = packRows(n.record.rows);
    expect(JSON.parse(packed)[0]).toEqual([1, 1, '4423', 53, 61, 681, 1, 3, 1094]);
    expect(unpackRows(packed)).toEqual(n.record.rows);
  });

  it('展示タイムとSTは、浮動小数の誤差が出ない（0.00〜9.99 を全部往復）', () => {
    for (let v = 0; v <= 999; v++) {
      const t = v / 100;
      const r = unpackRows(packRows([{ place: 1, boat: 1, toban: '1000', motor_no: 1, boat_no: 1, tenji: t, course: 1, st: t, time: null }]))[0]!;
      expect([r.tenji, r.st]).toEqual([t, t]);
    }
  });

  it('レースタイムは十分の一秒まで往復する（1.49.4 = 109.4）', () => {
    const r = unpackRows(packRows([{ place: 1, boat: 1, toban: '1000', motor_no: 1, boat_no: 1, tenji: 6.8, course: 1, st: 0.1, time: 109.4 }]))[0]!;
    expect(r.time).toBe(109.4);
  });

  it('払戻金は券種を番号で持ち、読み戻すと元になる', () => {
    const n = normalizeRecord(base());
    if (!n.ok) throw new Error(n.reason);
    const packed = packPayouts(n.record.payouts);
    expect(JSON.parse(packed)[5]).toEqual([5, '1-3-6', 1060, 2]);
    expect(unpackPayouts(packed)).toEqual(n.record.payouts);
  });

  it('不成立の券種は番号の文字列で、空は空', () => {
    expect(packUnsold(['kakurenpuku', 'sanrentan'])).toBe('4,5');
    expect(unpackUnsold('4,5')).toEqual(['kakurenpuku', 'sanrentan']);
    expect(packUnsold([])).toBe('');
    expect(unpackUnsold('')).toEqual([]);
  });
});
