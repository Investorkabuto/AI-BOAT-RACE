// 口座残高制（要件定義 v0.8 §2・§8）の決まりごと。DB に依存しない部分だけを置く
//
// - 月初（月の途中から参加するAIは参加開始日）に 200,000円を付与し、残高は月の中で繰り越す。翌月1日にリセット
// - 1日・1レースの金額は自由で、上限はその時点の残高だけ
// - 精算が翌月にずれても、そのレースは開催日の月に帰属する（開催日 race_date で月を決める）
// - 2026-11-05 までの開催分は旧ルール（日次残高）で確定し、月次残高・月次成績には含めない

import { monthRange } from './time';
import { UNIT } from './bets';

/** 口座残高制を適用する最初の開催日（2026-11-05 管理者決定） */
export const ACCOUNT_RULES_START = '2026-11-06';
/** 月初の付与額（円） */
export const MONTHLY_GRANT = 200_000;

/** その開催日に口座残高制が適用されるか */
export function accountRulesApply(raceDate: string, start: string = ACCOUNT_RULES_START): boolean {
  return raceDate >= start;
}

/**
 * その月の残高に数える開催日の範囲。口座残高制の開始より前に終わる月は null。
 * 2026-11 は 2026-11-06〜2026-11-30（11/5 までは旧ルール）
 */
export function accountRange(month: string, start: string = ACCOUNT_RULES_START): { from: string; to: string } | null {
  const { startsOn, endsOn } = monthRange(month);
  if (endsOn < start) return null;
  return { from: startsOn < start ? start : startsOn, to: endsOn };
}

/** 付与のときの参加開始日（その月の残高に数える最初の開催日）。今日と、その月の範囲の初日の遅いほう */
export function grantStartDate(month: string, today: string, start: string = ACCOUNT_RULES_START): string {
  const r = accountRange(month, start);
  const from = r?.from ?? `${month}-01`;
  return today > from ? today : from;
}

/** 資金枯渇（1枚も買えない）。残高が0以下、または最低単位の100円未満 */
export function isExhausted(balance: number): boolean {
  return balance < UNIT;
}

/** 増加率（%、小数第1位まで） */
export function gainPct(gain: number, granted: number): number | null {
  return granted > 0 ? Math.round((gain / granted) * 1000) / 10 : null;
}

export interface AccountRow {
  status: string;
  amount: number;
  payout: number;
}

/**
 * 月の残高。残高 = 付与額 − 提出額（取消を除く）+ 精算済みの返還額 + 精算済みの的中払戻 − 罰金。
 * 精算前（accepted・locked）の舟券は差し引いたまま
 */
export function monthBalance(granted: number, rows: readonly AccountRow[], fined = 0) {
  let staked = 0;
  let credited = 0;
  for (const r of rows) {
    if (r.status === 'cancelled') continue;
    staked += r.amount;
    if (r.status === 'refunded') credited += r.amount;
    else if (r.status === 'hit') credited += r.payout;
  }
  const balance = granted - staked + credited - fined;
  return { granted, staked, credited, fined, balance, gain: balance - granted, exhausted: isExhausted(balance) };
}

export interface BalanceStanding {
  agent_id: string;
  balance: number;
  /** その月に提出（取消を除く）か罰金があったか。なければ順位を付けない */
  active: boolean;
}

/**
 * 残高の降順で順位を付ける（同額は同順位）。その月に提出も罰金もないAIは順位なし（rank 0）で末尾に並べる
 */
export function rankByBalance<T extends BalanceStanding>(rows: T[]): (T & { rank: number })[] {
  const sorted = [...rows].sort((a, b) => Number(b.active) - Number(a.active) || b.balance - a.balance || a.agent_id.localeCompare(b.agent_id));
  let prev: number | null = null;
  let prevRank = 0;
  return sorted.map((r, i) => {
    if (!r.active) return { ...r, rank: 0 };
    const rank = prev !== null && r.balance === prev ? prevRank : i + 1;
    prev = r.balance;
    prevRank = rank;
    return { ...r, rank };
  });
}
