import { describe, expect, it } from 'vitest';
import { decodeSeries, encodeSeries, entrantsOf, normalizeCard, packRacers, unpackRacers, type CardRacer } from '../src/lib/cards';

// 2026-11-05 福岡 1R の1号艇（Bファイルの実物の行を scripts/boatrace_text.py で解析した結果）
const racer = (boat: number, toban: string, over: Record<string, unknown> = {}) => ({
  boat, toban, name: '山本寛久', age: 50, branch: '岡山', weight: 52, grade: 'A2',
  nat_win: 6.68, nat_2r: 44.9, loc_win: 5.92, loc_2r: 45.83, motor_no: 59, motor_2r: 39.74, boat_no: 141, boat_2r: 35.51,
  series: [[3, 2], [1], [2, 4], [1, 2]], next_rno: 10, ...over,
});
const six = () => [1, 2, 3, 4, 5, 6].map((b) => racer(b, String(3000 + b)));

describe('normalizeCard', () => {
  it('実物の形を受け付け、枠番順に並べる', () => {
    const r = normalizeCard({ racers: [...six()].reverse(), fixed_course: false, distance: 1800 });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.card.racers.map((x) => x.boat)).toEqual([1, 2, 3, 4, 5, 6]);
      expect(r.card.distance).toBe(1800);
      expect(r.card.fixed_course).toBe(false);
    }
  });

  it('進入固定は true のときだけ true', () => {
    const f = (v: unknown) => {
      const r = normalizeCard({ racers: six(), fixed_course: v });
      return r.ok && r.card.fixed_course;
    };
    expect([f(true), f(false), f('true'), f(undefined)]).toEqual([true, false, false, false]);
  });

  it('5人立ては受け付ける。4人以下と7人以上は拒否する', () => {
    expect(normalizeCard({ racers: six().slice(0, 5) }).ok).toBe(true);
    expect(normalizeCard({ racers: six().slice(0, 4) }).ok).toBe(false);
    expect(normalizeCard({ racers: [...six(), racer(7, '3007')] }).ok).toBe(false);
  });

  it.each([
    ['級別', { grade: 'Z9' }],
    ['登録番号', { toban: '12' }],
    ['勝率の範囲', { nat_win: 16.68 }],
    ['2連率の範囲', { motor_2r: 100.01 }],
    ['体重が整数でない', { weight: 52.5 }],
    ['今節成績が6日分', { series: [[], [], [], [], [], []] }],
    ['今節成績が1日3走', { series: [[1, 2, 3]] }],
    ['今節成績の着順が範囲外', { series: [[7]] }],
    ['今節成績の記号が小文字', { series: [['s']] }],
    ['氏名なし', { name: '  ' }],
  ])('不正な選手を拒否する: %s', (_label, over) => {
    const racers = six();
    racers[2] = racer(3, '3003', over);
    expect(normalizeCard({ racers }).ok).toBe(false);
  });

  it('枠番の重複・同じ選手が複数の枠にいる場合を拒否する', () => {
    const dupBoat = six();
    dupBoat[1] = racer(1, '3002');
    expect(normalizeCard({ racers: dupBoat }).ok).toBe(false);
    const dupToban = six();
    dupToban[1] = racer(2, '3001');
    const r = normalizeCard({ racers: dupToban });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toContain('同じ選手');
  });

  it('勝率 0.00（実績なし）は欠損にしない。値がなければ null', () => {
    const r = normalizeCard({ racers: [racer(1, '3001', { nat_win: 0, loc_win: 0 }), ...six().slice(1, 5).map((x) => ({ ...x, motor_no: null }))] });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.card.racers[0]!.nat_win).toBe(0);
      expect(r.card.racers[1]!.motor_no).toBeNull();
    }
  });

  it('氏名の全角空白は半角ひとつにそろえる（出走表の取り込みと同じ）', () => {
    const racers = six();
    racers[0] = racer(1, '3001', { name: '澤　大介' });
    const r = normalizeCard({ racers });
    expect(r.ok && r.card.racers[0]!.name).toBe('澤 大介');
  });
});

describe('詰めた形', () => {
  it('保存して読み戻すと同じ値になる', () => {
    const r = normalizeCard({ racers: six(), distance: 1800 });
    if (!r.ok) throw new Error(r.reason);
    expect(unpackRacers(packRacers(r.card.racers))).toEqual(r.card.racers);
  });

  it('小数2桁の値は、×100 の整数にして戻しても1つもずれない（0.00〜100.00 の全値）', () => {
    for (let i = 0; i <= 10000; i++) {
      const v = i / 100; // JS の浮動小数で表した 2 桁の小数
      const base = racer(1, '3001', { nat_2r: v, loc_2r: v, motor_2r: v, boat_2r: v }) as unknown as CardRacer;
      const back = unpackRacers(packRacers([base]))[0]!;
      if (back.nat_2r !== v) throw new Error(`${v} → ${back.nat_2r}`);
    }
  });

  it('1艇は配列で持ち、項目名を繰り返さない', () => {
    const r = normalizeCard({ racers: six() });
    if (!r.ok) throw new Error(r.reason);
    const packed = JSON.parse(packRacers(r.card.racers)) as unknown[][];
    expect(packed[0]).toEqual([1, '3001', '山本寛久', 50, '岡山', 52, 'A2', 668, 4490, 592, 4583, 59, 3974, 141, 3551, '32,1,24,12', 10]);
    expect(packRacers(r.card.racers)).not.toContain('nat_win');
  });

  it('今節成績の符号化: 出走のない日は空、記号はそのまま', () => {
    const s = [[3, 2], [1], [], [6, 'S'], ['F']];
    expect(encodeSeries(s)).toBe('32,1,,6S,F');
    expect(decodeSeries('32,1,,6S,F')).toEqual(s);
    expect(decodeSeries('')).toEqual([]); // 第1日（前日までの成績なし）
    expect(decodeSeries(',,,')).toEqual([[], [], [], []]); // 第5日で、4日とも出走なし
    expect(encodeSeries([[], [], [], []])).toBe(',,,');
  });

  it('出走表の基本情報だけを取り出せる', () => {
    const r = normalizeCard({ racers: six() });
    if (!r.ok) throw new Error(r.reason);
    expect(entrantsOf(r.card.racers)[0]).toEqual({ boat: 1, toban: '3001', name: '山本寛久', grade: 'A2', branch: '岡山', age: 50 });
  });
});
