import { describe, expect, it } from 'vitest';
import { validateResult } from '../src/routes/internal';

describe('公式結果の取り込みの検証', () => {
  const payouts = [{ bet_type: 'sanrentan', combo: '2-1-3', payout: 820 }];
  it('正しい結果は正規化して受け付ける', () => {
    const v = validateResult({ race_id: '20261105-11-07', status: 'official', finish: [[2], [1], [3]], refunded_boats: [], payouts });
    expect(v).toEqual({ finish: [[2], [1], [3]], refunded: [], payouts: [{ bet_type: 'sanrentan', combo: '2-1-3', payout: 820 }] });
  });
  it('払戻金だけで着順が空（レース直後の掲載途中）は理由を返す（例外にしない）', () => {
    expect(validateResult({ race_id: '20261105-11-07', status: 'official', finish: [], refunded_boats: [], payouts })).toBe('official result needs finish and payouts');
  });
  it('中止は着順・払戻なしで受け付ける', () => {
    expect(validateResult({ race_id: '20261105-11-07', status: 'cancelled', finish: [], refunded_boats: [], payouts: [] })).toEqual({ finish: [], refunded: [], payouts: [] });
  });
});
