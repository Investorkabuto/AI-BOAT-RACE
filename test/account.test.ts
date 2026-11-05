import { describe, expect, it } from 'vitest';
import { accountRange, accountRulesApply, gainPct, grantStartDate, isExhausted, monthBalance, rankByBalance } from '../src/lib/account';

describe('口座残高制の適用', () => {
  it('2026-11-06 の開催分から', () => {
    expect(accountRulesApply('2026-11-05')).toBe(false);
    expect(accountRulesApply('2026-11-06')).toBe(true);
  });
  it('11月は 11/6〜11/30、12月は月の全体。開始前に終わる月は null', () => {
    expect(accountRange('2026-11')).toEqual({ from: '2026-11-06', to: '2026-11-30' });
    expect(accountRange('2026-12')).toEqual({ from: '2026-12-01', to: '2026-12-31' });
    expect(accountRange('2026-10')).toBeNull();
  });
  it('参加開始日: 11/5 の付与は 11/6、月の途中の参加はその日', () => {
    expect(grantStartDate('2026-11', '2026-11-05')).toBe('2026-11-06');
    expect(grantStartDate('2026-11', '2026-11-20')).toBe('2026-11-20');
    expect(grantStartDate('2026-12', '2026-12-01')).toBe('2026-12-01');
  });
});

describe('月の残高', () => {
  it('付与 − 提出 + 返還・的中払戻 − 罰金。精算前は差し引いたまま、取消は数えない', () => {
    const b = monthBalance(200_000, [
      { status: 'hit', amount: 10_000, payout: 35_000 },
      { status: 'miss', amount: 5_000, payout: 0 },
      { status: 'refunded', amount: 2_000, payout: 0 },
      { status: 'locked', amount: 3_000, payout: 0 },
      { status: 'cancelled', amount: 50_000, payout: 0 },
    ], 2_000);
    expect(b).toEqual({ granted: 200_000, staked: 20_000, credited: 37_000, fined: 2_000, balance: 215_000, gain: 15_000, exhausted: false });
  });
  it('100円未満は資金枯渇', () => {
    expect(isExhausted(100)).toBe(false);
    expect(isExhausted(99)).toBe(true);
    expect(isExhausted(-2_000)).toBe(true);
    expect(monthBalance(200_000, [{ status: 'miss', amount: 200_000, payout: 0 }]).exhausted).toBe(true);
  });
  it('増加率', () => {
    expect(gainPct(15_000, 200_000)).toBe(7.5);
    expect(gainPct(-200_000, 200_000)).toBe(-100);
  });
});

describe('残高の順位', () => {
  it('残高の降順、同額は同順位、活動のないAIは順位なしで末尾', () => {
    const r = rankByBalance([
      { agent_id: 'a', balance: 180_000, active: true },
      { agent_id: 'b', balance: 250_000, active: true },
      { agent_id: 'c', balance: 200_000, active: false },
      { agent_id: 'd', balance: 250_000, active: true },
      { agent_id: 'e', balance: -1_000, active: true },
    ]);
    expect(r.map((x) => [x.agent_id, x.rank])).toEqual([['b', 1], ['d', 1], ['a', 3], ['e', 4], ['c', 0]]);
  });
});
