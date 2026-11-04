import { describe, expect, it } from 'vitest';
import { dailyBudget, entryDeadlineMs, entryRulesApply } from '../src/lib/entries';
import { dayBalance } from '../src/lib/bets';
import { mergeFines } from '../src/db/repo';
import { jstIso } from '../src/lib/time';

describe('新ルールの適用日', () => {
  it('開始日が未定（null）なら適用しない', () => {
    expect(entryRulesApply('2026-11-05', null)).toBe(false);
    expect(dailyBudget('2026-11-05', null)).toBe(10_000);
  });
  it('開始日以降だけ適用し、開始残高は20,000円', () => {
    expect(entryRulesApply('2026-11-09', '2026-11-10')).toBe(false);
    expect(entryRulesApply('2026-11-10', '2026-11-10')).toBe(true);
    expect(dailyBudget('2026-11-09', '2026-11-10')).toBe(10_000);
    expect(dailyBudget('2026-11-11', '2026-11-10')).toBe(20_000);
  });
  it('申告の期限は当日 8:30（日本時間）', () => {
    expect(jstIso(entryDeadlineMs('2026-11-05'))).toBe('2026-11-05T08:30:00+09:00');
  });
});

describe('罰金', () => {
  it('残高から差し引く', () => {
    const b = dayBalance(20_000, [{ status: 'miss', amount: 1_000, payout: 0 }], 2_000);
    expect(b).toEqual({ start: 20_000, staked: 1_000, credited: 0, fined: 2_000, balance: 17_000 });
  });
  it('成績では投票合計に加え、罰金だけのAIも1行になる', () => {
    const rows = mergeFines(
      [{ agent_id: 'a', stake: 1_000, payout: 1_500, bets: 1, hits: 1, races: 1 }],
      [{ agent_id: 'a', n: 1, s: 2_000 }, { agent_id: 'b', n: 2, s: 4_000 }],
    );
    expect(rows).toEqual([
      { agent_id: 'a', stake: 3_000, payout: 1_500, bets: 1, hits: 1, races: 1, fines: 1, fined: 2_000 },
      { agent_id: 'b', stake: 4_000, payout: 0, bets: 0, hits: 0, races: 0, fines: 2, fined: 4_000 },
    ]);
  });
});

describe('申告の買い目', () => {
  it('正規化し、重複はまとめ、誤りは理由を返す', async () => {
    const { parsePlanTickets } = await import('../src/lib/entries');
    const errors: string[] = [];
    const t = parsePlanTickets(
      [{ bet_type: 'sanrentan', combo: '1-2-3' }, { bet_type: 'sanrentan', combo: [1, 2, 3] }, { bet_type: 'kakurenpuku', combo: '2-1' }, { bet_type: 'tansho', combo: '7' }],
      errors, 'e.',
    );
    expect(t).toEqual([{ bet_type: 'sanrentan', combo: '1-2-3' }, { bet_type: 'kakurenpuku', combo: '1=2' }]);
    expect(errors).toHaveLength(1);
  });
  it('申告していない買い目を見つける（一部だけ買うのはよい）', async () => {
    const { undeclaredTickets } = await import('../src/lib/entries');
    const plan = [{ bet_type: 'sanrentan' as const, combo: '1-2-3' }, { bet_type: 'kakurenpuku' as const, combo: '1=2' }];
    expect(undeclaredTickets(plan, [{ bet_type: 'kakurenpuku', combo: '1=2' }])).toEqual([]);
    expect(undeclaredTickets(plan, [{ bet_type: 'sanrentan', combo: '1-3-2' }])).toEqual(['3連単 1-3-2']);
  });
});
