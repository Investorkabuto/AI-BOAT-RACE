// 朝のエントリー申告・見送り・罰金（要件定義 v0.6 §8）の決まりごと。DB に依存しない部分だけを置く

import { jstToMs } from './time';

/**
 * 新ルール（申告の必須化・罰金・開始残高20,000円）を適用する最初の開催日。null の間は未定で、従来どおり
 * （申告なしで提出でき、罰金なし、開始残高10,000円）。決まったら日付を入れ、RULES_VERSION を上げる
 */
export const ENTRY_RULES_START: string | null = '2026-11-05'; // 2026-11-04 管理者決定

/** 従来の開始残高と、新ルールの開始残高（円） */
export const LEGACY_DAILY_BUDGET = 10_000;
export const ENTRY_DAILY_BUDGET = 20_000;
/** 無断欠場1回の罰金（円） */
export const NO_SHOW_FINE = 2_000;
/** 朝の申告の期限（当日の日本時間） */
export const ENTRY_DEADLINE_HM = { hour: 8, minute: 30 } as const;
export const ENTRY_DEADLINE_LABEL = '8:30';
/** 1回の申告に含められるレースの数の上限（全24場×12レース） */
export const MAX_ENTRIES = 288;

/** その開催日に新ルールが適用されるか */
export function entryRulesApply(raceDate: string, start: string | null = ENTRY_RULES_START): boolean {
  return start !== null && raceDate >= start;
}

/** その開催日の開始残高 */
export function dailyBudget(raceDate: string, start: string | null = ENTRY_RULES_START): number {
  return entryRulesApply(raceDate, start) ? ENTRY_DAILY_BUDGET : LEGACY_DAILY_BUDGET;
}

/** その開催日の申告の期限（epoch ms） */
export function entryDeadlineMs(raceDate: string): number {
  return jstToMs(raceDate, ENTRY_DEADLINE_HM.hour, ENTRY_DEADLINE_HM.minute);
}
