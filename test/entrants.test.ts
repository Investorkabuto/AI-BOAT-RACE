import { describe, expect, it } from 'vitest';
import { normalizeEntrants, normalizeStarts } from '../src/lib/entrants';

const six = () =>
  [1, 2, 3, 4, 5, 6].map((boat) => ({ boat, toban: String(4000 + boat), name: `選手　${boat}`, grade: 'A1', branch: '東京', age: 30 + boat }));

describe('normalizeEntrants', () => {
  it('枠番順にそろえ、氏名の全角空白を半角にする', () => {
    const r = normalizeEntrants(six().reverse());
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.entrants.map((e) => e.boat)).toEqual([1, 2, 3, 4, 5, 6]);
    expect(r.entrants[0]).toEqual({ boat: 1, toban: '4001', name: '選手 1', grade: 'A1', branch: '東京', age: 31 });
  });

  it('級別・支部・年齢は不明なら null にする', () => {
    const r = normalizeEntrants([{ boat: 1, toban: '4001', name: 'a', grade: 'X9', age: 200 }]);
    expect(r.ok && r.entrants[0]).toEqual({ boat: 1, toban: '4001', name: 'a', grade: null, branch: null, age: null });
  });

  it('枠番の重複・登録番号の誤り・氏名なし・人数の誤りは受け付けない', () => {
    const dup = six();
    dup[1]!.boat = 1;
    expect(normalizeEntrants(dup).ok).toBe(false);
    expect(normalizeEntrants([{ boat: 1, toban: '12', name: 'a' }]).ok).toBe(false);
    expect(normalizeEntrants([{ boat: 1, toban: '4001', name: '  ' }]).ok).toBe(false);
    expect(normalizeEntrants([]).ok).toBe(false);
    expect(normalizeEntrants([...six(), { boat: 7, toban: '4007', name: 'a' }]).ok).toBe(false);
  });
});

describe('normalizeStarts', () => {
  it('コース順にそろえ、タイミングを 0.15 / F0.01 の形にする', () => {
    expect(
      normalizeStarts([
        { course: 2, boat: 3, st: '.09' },
        { course: 1, boat: 1, st: '.15' },
        { course: 3, boat: 2, st: 'F.01' },
        { course: 4, boat: 4, st: 'L' },
        { course: 5, boat: 5, st: '??' },
      ]),
    ).toEqual([
      { course: 1, boat: 1, st: '0.15' },
      { course: 2, boat: 3, st: '0.09' },
      { course: 3, boat: 2, st: 'F0.01' },
      { course: 4, boat: 4, st: 'L' },
      { course: 5, boat: 5, st: null },
    ]);
  });
  it('コースや艇の重複、範囲外は null', () => {
    expect(normalizeStarts([{ course: 1, boat: 1, st: '.1' }, { course: 1, boat: 2, st: '.12' }])).toBeNull();
    expect(normalizeStarts([{ course: 1, boat: 7, st: '.12' }])).toBeNull();
    expect(normalizeStarts([])).toBeNull();
  });
});
