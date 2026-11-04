import { describe, expect, it } from 'vitest';
import { dayBalance, hitRatePct, judgeBet, normalizeCombo, rankByRecovery, recoveryPct, winningCombos, type RaceResult } from '../src/lib/bets';

describe('normalizeCombo', () => {
  it('着順ありはそのまま、着順なしは昇順', () => {
    expect(normalizeCombo('sanrentan', '3-1-2')).toBe('3-1-2');
    expect(normalizeCombo('sanrenpuku', '3-1-2')).toBe('1=2=3');
    expect(normalizeCombo('nirenpuku', [4, 2])).toBe('2=4');
    expect(normalizeCombo('kakurenpuku', '5=1')).toBe('1=5');
    expect(normalizeCombo('nirentan', '21')).toBe('2-1');
    expect(normalizeCombo('tansho', 6)).toBe('6');
    expect(normalizeCombo('fukusho', '1')).toBe('1');
  });
  it('不正な組番は null', () => {
    expect(normalizeCombo('sanrentan', '1-1-2')).toBeNull();
    expect(normalizeCombo('sanrentan', '1-2')).toBeNull();
    expect(normalizeCombo('tansho', '7')).toBeNull();
    expect(normalizeCombo('nirentan', '0-1')).toBeNull();
    expect(normalizeCombo('nirenpuku', { a: 1 })).toBeNull();
  });
});

describe('winningCombos', () => {
  it('通常の着順', () => {
    const w = winningCombos([[3], [1], [5], [2], [4], [6]]);
    expect(w.tansho).toEqual(['3']);
    expect(w.fukusho).toEqual(['3', '1']);
    expect(w.nirentan).toEqual(['3-1']);
    expect(w.nirenpuku).toEqual(['1=3']);
    expect(w.kakurenpuku.sort()).toEqual(['1=3', '1=5', '3=5']);
    expect(w.sanrentan).toEqual(['3-1-5']);
    expect(w.sanrenpuku).toEqual(['1=3=5']);
  });
  it('2着同着は2連単・3連単が2通り', () => {
    const w = winningCombos([[1], [2, 4], [5]]);
    expect(w.nirentan.sort()).toEqual(['1-2', '1-4']);
    expect(w.sanrentan.sort()).toEqual(['1-2-4', '1-4-2']);
    expect(w.sanrenpuku).toEqual(['1=2=4']);
    expect(w.fukusho.sort()).toEqual(['1', '2', '4']);
  });
});

const result: RaceResult = {
  status: 'official',
  refunded_boats: [],
  payouts: [
    { bet_type: 'sanrentan', combo: '1-2-3', payout: 1230 },
    { bet_type: 'kakurenpuku', combo: '1=2', payout: 150 },
    { bet_type: 'kakurenpuku', combo: '1=3', payout: 210 },
  ],
};

describe('judgeBet', () => {
  it('的中は 100円あたり払戻金 × 金額 ÷ 100', () => {
    expect(judgeBet({ bet_type: 'sanrentan', combo: '1-2-3', amount: 300 }, result)).toEqual({ status: 'hit', payout: 3690 });
    expect(judgeBet({ bet_type: 'kakurenpuku', combo: '1=3', amount: 1000 }, result)).toEqual({ status: 'hit', payout: 2100 });
  });
  it('券種が違えば同じ組番でも不的中', () => {
    expect(judgeBet({ bet_type: 'sanrenpuku', combo: '1=2=3', amount: 100 }, result).status).toBe('miss');
    expect(judgeBet({ bet_type: 'sanrentan', combo: '1-3-2', amount: 100 }, result).status).toBe('miss');
  });
  it('返還艇を含む舟券は返還、中止は全額返還', () => {
    expect(judgeBet({ bet_type: 'sanrentan', combo: '1-2-4', amount: 100 }, { ...result, refunded_boats: [4] })).toEqual({ status: 'refunded', payout: 0, reason: 'boat_refunded' });
    expect(judgeBet({ bet_type: 'sanrentan', combo: '1-2-3', amount: 100 }, { ...result, status: 'cancelled' })).toEqual({ status: 'refunded', payout: 0, reason: 'race_cancelled' });
  });
  it('特払いはその券種の全舟券に払い戻す', () => {
    const r: RaceResult = { ...result, payouts: [{ bet_type: 'sanrentan', combo: '*', payout: 70 }] };
    expect(judgeBet({ bet_type: 'sanrentan', combo: '6-5-4', amount: 200 }, r)).toEqual({ status: 'hit', payout: 140 });
    expect(judgeBet({ bet_type: 'tansho', combo: '6', amount: 200 }, r).status).toBe('miss');
  });
});

describe('成績', () => {
  it('回収率と的中率', () => {
    expect(recoveryPct(12300, 10000)).toBe(123);
    expect(recoveryPct(0, 0)).toBeNull();
    expect(hitRatePct(1, 3)).toBe(33.3);
  });
  it('回収率の降順、同率は同順位、投票なしは順位なし', () => {
    const r = rankByRecovery([
      { agent_id: 'a', stake: 1000, payout: 500 },
      { agent_id: 'b', stake: 1000, payout: 2000 },
      { agent_id: 'c', stake: 2000, payout: 1000 },
      { agent_id: 'd', stake: 0, payout: 0 },
    ]);
    expect(r.map((x) => [x.agent_id, x.rank])).toEqual([['b', 1], ['c', 2], ['a', 2], ['d', 0]]);
  });
});

describe('dayBalance（残高方式）', () => {
  it('提出で減り、精算された返還・的中払戻で増える。精算前は差し引いたまま、取消は戻る', () => {
    const b = dayBalance(10000, [
      { status: 'hit', amount: 1000, payout: 3000 },
      { status: 'miss', amount: 2000, payout: 0 },
      { status: 'refunded', amount: 500, payout: 0 },
      { status: 'locked', amount: 1500, payout: 0 },
      { status: 'accepted', amount: 1000, payout: 0 },
      { status: 'cancelled', amount: 4000, payout: 0 },
    ]);
    expect(b).toEqual({ start: 10000, staked: 6000, credited: 3500, fined: 0, balance: 7500 });
  });
  it('払戻で開始残高を超えて使える', () => {
    expect(dayBalance(10000, [{ status: 'hit', amount: 10000, payout: 12000 }]).balance).toBe(12000);
  });
});
