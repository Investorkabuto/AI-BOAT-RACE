// 参加AIの買い目を、実券の発注用テキスト（もちの「確定オーダーテキスト」形式仕様 v1、2026-11-07）にする。
// テレボートのベットリストへ機械的に写すので、形式を変えないこと。
//
//   2026-11-08
//   三国 2R 締切09:13
//   3連単 1-2-3 600円
//   拡連複 1=2 500円
//   小計 1,100円（2点）
//   合計 1,100円（2点）
//
// 予算を指定すると、倍率（予算 ÷ 元の合計）を各買い目に掛けて100円単位にする。各買い目を100円単位で切り捨て（最低100円。買い目は減らさない）、
// 予算に足りない分は端数の大きい買い目から100円ずつ足す（最大剰余方式）。合計は予算（100円未満は切り捨て）と一致する。
// 買い目の数 × 100円が予算を超えるときだけ、合計が予算を超える。小計・合計は配分後の金額で数える
import { BET_TYPE_JA, UNIT, type BetType } from './bets';

export interface OrderBet {
  bet_type: BetType;
  combo: string;
  amount: number;
}

export interface OrderRace {
  label: string; // 大会の表記（"三国 2R"）
  deadline: string; // ISO 8601（+09:00）
  bets: OrderBet[]; // 購入の順
}

export interface OrderText {
  text: string;
  original_total: number;
  total: number;
  count: number;
  factor: number;
}

const comma = (n: number) => n.toLocaleString('en-US');

/**
 * 金額の並びに倍率を掛け、合計が budget（100円単位に切り捨て）になるよう100円単位で配分する。
 * 各買い目は最低100円。端数の大きい順に100円ずつ足す（同じ端数なら前の買い目から）。同じ入力なら同じ結果
 */
export function scaleAmounts(amounts: readonly number[], budget: number): number[] {
  const original = amounts.reduce((s, a) => s + a, 0);
  if (original <= 0) return amounts.map(() => UNIT);
  const target = Math.floor(budget / UNIT);
  const raw = amounts.map((a) => (a * target) / original);
  const units = raw.map((r) => Math.max(1, Math.floor(r + 1e-9)));
  let rest = target - units.reduce((s, u) => s + u, 0);
  const order = raw.map((r, i) => ({ i, frac: units[i]! > r ? -1 : r - Math.floor(r + 1e-9) })).sort((a, b) => b.frac - a.frac || a.i - b.i);
  for (let k = 0; rest > 0 && order.length; k = (k + 1) % order.length, rest--) units[order[k]!.i]! += 1;
  return units.map((u) => u * UNIT);
}

/**
 * 発注用テキストを作る。races は締切の昇順に並べ直す（同じ締切ならレース表記の順）。
 * budget を省くと AI の金額のまま。同じ入力からは同じテキストになる
 */
export function orderText(date: string, races: readonly OrderRace[], budget?: number): OrderText {
  const list = races.filter((r) => r.bets.length > 0).slice().sort((a, b) => a.deadline.localeCompare(b.deadline) || a.label.localeCompare(b.label));
  const originalTotal = list.reduce((s, r) => s + r.bets.reduce((t, b) => t + b.amount, 0), 0);
  const factor = budget !== undefined && originalTotal > 0 ? budget / originalTotal : 1;
  const scaled = budget !== undefined ? scaleAmounts(list.flatMap((r) => r.bets.map((b) => b.amount)), budget) : null;
  let k = 0;
  const lines = [date];
  let total = 0;
  let count = 0;
  for (const r of list) {
    lines.push(`${r.label} 締切${r.deadline.slice(11, 16)}`);
    let sub = 0;
    for (const b of r.bets) {
      const amount = scaled ? scaled[k++]! : b.amount;
      lines.push(`${BET_TYPE_JA[b.bet_type]} ${b.combo} ${amount}円`);
      sub += amount;
    }
    lines.push(`小計 ${comma(sub)}円（${r.bets.length}点）`);
    total += sub;
    count += r.bets.length;
  }
  lines.push(`合計 ${comma(total)}円（${count}点）`);
  return { text: lines.join('\n'), original_total: originalTotal, total, count, factor: Math.round(factor * 10000) / 10000 };
}
