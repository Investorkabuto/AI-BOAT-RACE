import { describe, expect, it } from 'vitest';
import { validateResult } from '../src/routes/internal';

describe('公式結果の取り込みの検証', () => {
  const payouts = [{ bet_type: 'sanrentan', combo: '2-1-3', payout: 820 }];
  it('正しい結果は正規化して受け付ける', () => {
    const v = validateResult({ race_id: '20261105-11-07', status: 'official', finish: [[2], [1], [3]], refunded_boats: [], payouts });
    expect(v).toEqual({ finish: [[2], [1], [3]], refunded: [], payouts: [{ bet_type: 'sanrentan', combo: '2-1-3', payout: 820 }], unsold: [] });
  });
  it('払戻金だけで着順が空（レース直後の掲載途中）は理由を返す（例外にしない）', () => {
    expect(validateResult({ race_id: '20261105-11-07', status: 'official', finish: [], refunded_boats: [], payouts })).toBe('official result needs finish and payouts');
  });
  it('中止は着順・払戻なしで受け付ける', () => {
    expect(validateResult({ race_id: '20261105-11-07', status: 'cancelled', finish: [], refunded_boats: [], payouts: [] })).toEqual({ finish: [], refunded: [], payouts: [], unsold: [] });
  });
  it('一部の券種が不成立なら、着順が空でも受け付ける（2026-11-07 戸田7R: 単勝だけ成立）', () => {
    const v = validateResult({
      race_id: '20261107-02-07', status: 'official', finish: [], refunded_boats: [1, 2, 3, 5],
      payouts: [{ bet_type: 'tansho', combo: '6', payout: 130 }],
      unsold: ['sanrentan', 'sanrenpuku', 'nirentan', 'nirenpuku', 'kakurenpuku', 'fukusho'],
    });
    expect(v).toEqual({ finish: [], refunded: [1, 2, 3, 5], payouts: [{ bet_type: 'tansho', combo: '6', payout: 130 }], unsold: ['sanrentan', 'sanrenpuku', 'nirentan', 'nirenpuku', 'kakurenpuku', 'fukusho'] });
  });
  it('不成立の券種の誤りは理由を返す', () => {
    const base = { race_id: '20261107-03-02', status: 'official' as const, finish: [[6], [4]], refunded_boats: [], payouts: [{ bet_type: 'nirentan', combo: '6-4', payout: 300 }] };
    expect(validateResult({ ...base, unsold: ['foo'] })).toBe('unsold "foo"');
    expect(validateResult({ ...base, unsold: ['nirentan'] })).toBe('unsold bet type has payouts');
  });
});
