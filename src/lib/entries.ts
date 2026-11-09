// 朝のエントリー申告・見送り・罰金（要件定義 v0.6 §8）の決まりごと。DB に依存しない部分だけを置く

import { jstIso, jstToMs } from './time';
import { BET_SPEC, BET_TYPE_JA, BET_TYPES, normalizeCombo, type BetType } from './bets';

/**
 * 新ルール（申告の必須化・罰金・開始残高20,000円）を適用する最初の開催日。null の間は未定で、従来どおり
 * （申告なしで提出でき、罰金なし、開始残高10,000円）。決まったら日付を入れ、RULES_VERSION を上げる
 */
export const ENTRY_RULES_START: string | null = '2026-11-05'; // 2026-11-04 管理者決定

/** 従来の開始残高と、新ルールの開始残高（円） */
export const LEGACY_DAILY_BUDGET = 10_000;
export const ENTRY_DAILY_BUDGET = 20_000;
/**
 * 無断欠場1回の罰金（円）。2026-11-09 に廃止して0円にした（決定65。それまでの罰金もすべて返した。migrations/0024）。
 * 無断欠場は引き続き fines に金額0の行で記録し、回数を公開する
 */
export const NO_SHOW_FINE = 0;
/**
 * 朝の申告の期限（確定・公開の時刻。当日の日本時間）。開催日ごとに、from 以降で最も新しいものを使う。
 * 2026-11-09 の申告分から 8:30 → 8:15（決定58、2026-11-08 管理者決定。締切 8:35 のレースでも購入・見送りの時間を20分取るため）
 */
type DeadlineHm = { from: string; hour: number; minute: number };
const FIRST_DEADLINE: DeadlineHm = { from: '0000-00-00', hour: 8, minute: 30 };
/** 現行（最新）の申告の期限。文書・説明文に使う表記 */
export const ENTRY_DEADLINE_HM: DeadlineHm = { from: '2026-11-09', hour: 8, minute: 15 };
export const ENTRY_DEADLINES: readonly DeadlineHm[] = [FIRST_DEADLINE, ENTRY_DEADLINE_HM];
export const ENTRY_DEADLINE_LABEL = hmLabel(ENTRY_DEADLINE_HM);

function hmLabel(t: { hour: number; minute: number }): string {
  return `${t.hour}:${String(t.minute).padStart(2, '0')}`;
}

/** その開催日の申告の期限（時・分） */
export function entryDeadlineHm(raceDate: string): { hour: number; minute: number } {
  let hm = FIRST_DEADLINE;
  for (const d of ENTRY_DEADLINES) if (raceDate >= d.from) hm = d;
  return hm;
}

/** その開催日の申告の期限の表記（例 "8:15"） */
export function entryDeadlineLabel(raceDate: string): string {
  return hmLabel(entryDeadlineHm(raceDate));
}
/**
 * 何日先のレースまで申告を受け付けるか。0 = 当日の分だけ（日本時間 0:00 から）。
 * 番組表（Bファイル）の取り込みで、前日の夕方から翌日のレースが作られるようになったが、前日からの申告を認めるかは
 * 決まっていない（要件定義にない）ため、従来の運用（当日の朝から）を保つ。認めるなら 1 にする
 */
export const ENTRY_DAYS_AHEAD = 0;

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
  const hm = entryDeadlineHm(raceDate);
  return jstToMs(raceDate, hm.hour, hm.minute);
}

/**
 * 申告ルールの改定（決定62、2026-11-08 管理者決定）を適用する最初の開催日。この日から:
 * - 注文（購入・取消）・見送り・申告の変更は、各レースの締切の ORDER_CUTOFF_MIN 分前まで
 * - 朝の申告の買い目は任意（根拠は必須）。申告した買い目にかかわらず買える
 * - 申告済みのレースの買い目と根拠は、締切の5分前まで何度でも変えられる（PUT /entries/{race_id}。変更の理由が必須）
 * - 申告（買い目・根拠）とその変更は、申告・変更した時点で公開する（8:15 の一斉公開はやめる）
 * 出るレースは従来どおり朝の申告の期限（8:15）で固定し、以後は追加申告と見送りだけ
 */
export const FLEX_RULES_START = '2026-11-09';
/** 締切の何分前で注文・見送り・申告の変更を締め切るか */
export const ORDER_CUTOFF_MIN = 5;

/** その開催日に、申告ルールの改定（決定62）を適用するか */
export function flexRulesApply(raceDate: string, start: string = FLEX_RULES_START): boolean {
  return raceDate >= start;
}

/** そのレースの注文（購入・取消）・見送り・申告の変更の締切（epoch ms）。改定前の開催日はレースの締切そのもの */
export function orderCutoffMs(race: { race_date: string; deadline_ms: number }): number {
  return race.deadline_ms - (flexRulesApply(race.race_date) ? ORDER_CUTOFF_MIN * 60_000 : 0);
}

/** 注文の締切の表記（"締切の5分前（9:08）" など）。改定前は "締切（9:13）" */
export function orderCutoffLabel(race: { race_date: string; deadline_ms: number }): string {
  const hm = jstIso(orderCutoffMs(race)).slice(11, 16);
  return flexRulesApply(race.race_date) ? `締切の${ORDER_CUTOFF_MIN}分前（${hm}）` : `締切（${hm}）`;
}

/** 申告の買い目と根拠を公開してよいか。改定後は申告した時点から、改定前は申告の期限から */
export function plansPublic(raceDate: string, nowMs: number): boolean {
  return flexRulesApply(raceDate) || nowMs >= entryDeadlineMs(raceDate);
}

/** 1レースに申告できる買い目の数の上限（1回の提出の上限と同じ） */
export const MAX_PLAN_TICKETS = 60;

export interface PlanTicket {
  bet_type: BetType;
  combo: string;
}

/**
 * 申告の買い目を検証して正規化する（券種と組番だけ。金額は含めない）。
 * 誤りは errors に積み、正しいものだけを返す
 */
export function parsePlanTickets(raw: unknown, errors: string[], prefix: string, optional = false): PlanTicket[] {
  if (optional && (raw === undefined || raw === null)) return [];
  if (!Array.isArray(raw) || raw.length < (optional ? 0 : 1) || raw.length > MAX_PLAN_TICKETS) {
    errors.push(`${prefix}tickets は${optional ? 0 : 1}〜${MAX_PLAN_TICKETS}件の配列（買い目1点ごとに {bet_type, combo}。金額は含めない）${optional ? '。省略してもよい' : ''}`);
    return [];
  }
  const out: PlanTicket[] = [];
  const seen = new Set<string>();
  raw.forEach((t, i) => {
    const x = (t && typeof t === 'object' ? t : {}) as Record<string, unknown>;
    const type = x.bet_type;
    if (typeof type !== 'string' || !(BET_TYPES as readonly string[]).includes(type)) {
      errors.push(`${prefix}tickets[${i}].bet_type は ${BET_TYPES.map((b) => `${b}（${BET_TYPE_JA[b]}）`).join(' / ')} のどれか`);
      return;
    }
    const bt = type as BetType;
    const combo = normalizeCombo(bt, x.combo);
    if (!combo) {
      errors.push(`${prefix}tickets[${i}].combo は${BET_TYPE_JA[bt]}なら異なる艇番（1〜6）を${BET_SPEC[bt].boats}つ。例: "${['1', '1-2', '1-2-3'][BET_SPEC[bt].boats - 1]}"`);
      return;
    }
    const key = `${bt}:${combo}`;
    if (seen.has(key)) return; // 同じ買い目の重複は1つにまとめる
    seen.add(key);
    out.push({ bet_type: bt, combo });
  });
  return out;
}

/** 申告していない買い目（購入時の確認用）。すべて申告済みなら空 */
export function undeclaredTickets(plan: readonly PlanTicket[], tickets: readonly { bet_type: string; combo: string }[]): string[] {
  const ok = new Set(plan.map((t) => `${t.bet_type}:${t.combo}`));
  return tickets.filter((t) => !ok.has(`${t.bet_type}:${t.combo}`)).map((t) => `${BET_TYPE_JA[t.bet_type as BetType] ?? t.bet_type} ${t.combo}`);
}
