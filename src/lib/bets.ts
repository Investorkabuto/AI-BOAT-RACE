// 舟券の判定エンジン（純粋関数）。DBに依存しないので、単体テストで挙動を固定できる。
//
// 本番の精算は「公式の払戻金一覧（勝式・組番・100円あたり払戻金）との照合」で行う（requirements.md 2.1）。
// 同着で的中の組番が複数あっても、公式の一覧にすべて載るので、照合するだけで正しく払い戻せる。
// 着順から的中の組番を作る winningCombos は、サンドボックスの即時精算とテストで使う。

/** 券種（ボートレースの実在の7券種） */
export const BET_TYPES = ['tansho', 'fukusho', 'nirentan', 'nirenpuku', 'kakurenpuku', 'sanrentan', 'sanrenpuku'] as const;
export type BetType = (typeof BET_TYPES)[number];

export const BET_TYPE_JA: Record<BetType, string> = {
  tansho: '単勝',
  fukusho: '複勝',
  nirentan: '2連単',
  nirenpuku: '2連複',
  kakurenpuku: '拡連複',
  sanrentan: '3連単',
  sanrenpuku: '3連複',
};

/** 券種ごとの、選ぶ艇の数と、着順を区別するか */
export const BET_SPEC: Record<BetType, { boats: number; ordered: boolean; rule: string }> = {
  tansho: { boats: 1, ordered: true, rule: '1着の艇を当てる' },
  fukusho: { boats: 1, ordered: true, rule: '2着以内に入る艇を当てる' },
  nirentan: { boats: 2, ordered: true, rule: '1着・2着を着順どおりに当てる' },
  nirenpuku: { boats: 2, ordered: false, rule: '1着・2着の2艇を着順不問で当てる' },
  kakurenpuku: { boats: 2, ordered: false, rule: '3着以内に入る2艇を着順不問で当てる' },
  sanrentan: { boats: 3, ordered: true, rule: '1着・2着・3着を着順どおりに当てる' },
  sanrenpuku: { boats: 3, ordered: false, rule: '1着・2着・3着の3艇を着順不問で当てる' },
};

export const BOATS = 6;
/** 金額の単位（円） */
export const UNIT = 100;
/** 特払い（的中者がいないときに全員へ払い戻す）を表す組番 */
export const SPECIAL_COMBO = '*';

/**
 * 組番を正規化する。着順を区別する券種は "1-2-3"、区別しない券種は昇順に並べて "1=2=3"（公式の表記と同じ）。
 * 入力は "1-2-3"、"1=2=3"、"123"、[1,2,3] のどれでもよい。不正なら null
 */
export function normalizeCombo(type: BetType, input: unknown): string | null {
  let boats: number[];
  if (Array.isArray(input)) {
    boats = input.map((x) => (typeof x === 'number' ? x : typeof x === 'string' && /^[1-6]$/.test(x) ? Number(x) : NaN));
  } else if (typeof input === 'number') {
    boats = [...String(input)].map(Number);
  } else if (typeof input === 'string') {
    const s = input.replace(/\s+/g, '');
    boats = (/[-=]/.test(s) ? s.split(/[-=]/) : [...s]).map((x) => (/^[1-6]$/.test(x) ? Number(x) : NaN));
  } else {
    return null;
  }
  const spec = BET_SPEC[type];
  if (boats.length !== spec.boats) return null;
  if (boats.some((b) => !Number.isInteger(b) || b < 1 || b > BOATS)) return null;
  if (new Set(boats).size !== boats.length) return null;
  return spec.ordered ? boats.join('-') : [...boats].sort((a, b) => a - b).join('=');
}

export function comboBoats(combo: string): number[] {
  return combo === SPECIAL_COMBO ? [] : combo.split(/[-=]/).map(Number);
}

/**
 * 着順（1着から順に艇番。同着は同じ配列要素に複数艇）から、券種ごとの的中組番を作る。
 * 例: [[1], [3], [2]] → 3連単 "1-3-2"。同着の例: [[1], [2, 4], [5]] → 2連単は "1-2" と "1-4"。
 * 公式の払戻金が分からないサンドボックスとテストで使う
 */
export function winningCombos(finish: number[][]): Record<BetType, string[]> {
  // 着順の各位置に入りうる艇（同着は複数）を展開する
  const places: number[][] = [];
  for (const group of finish) for (let i = 0; i < group.length; i++) places.push(group);
  const at = (i: number) => places[i] ?? [];
  const uniq = (xs: string[]) => [...new Set(xs)];
  const ordered = (n: number): number[][] => {
    // 着順 1..n の並びで、同じ艇を重複して使わないものすべて
    let acc: number[][] = [[]];
    for (let i = 0; i < n; i++) {
      const next: number[][] = [];
      for (const seq of acc) for (const b of at(i)) if (!seq.includes(b)) next.push([...seq, b]);
      acc = next;
    }
    return acc;
  };
  const top = (n: number) => uniq(Array.from({ length: n }, (_, i) => at(i)).flat().map(String)).map(Number);
  const pairs = (boats: number[]) => {
    const out: string[] = [];
    for (let i = 0; i < boats.length; i++) for (let j = i + 1; j < boats.length; j++) out.push([boats[i]!, boats[j]!].sort((a, b) => a - b).join('='));
    return out;
  };
  return {
    tansho: uniq(at(0).map(String)),
    fukusho: top(2).map(String),
    nirentan: uniq(ordered(2).map((s) => s.join('-'))),
    nirenpuku: uniq(ordered(2).map((s) => [...s].sort((a, b) => a - b).join('='))),
    kakurenpuku: uniq(pairs(top(3))),
    sanrentan: uniq(ordered(3).map((s) => s.join('-'))),
    sanrenpuku: uniq(ordered(3).map((s) => [...s].sort((a, b) => a - b).join('='))),
  };
}

/** 公式の払戻金一覧の1行（100円あたり） */
export interface Payout {
  bet_type: BetType;
  combo: string;
  payout: number;
}

export interface RaceResult {
  /** official = 確定、cancelled = 中止・不成立（全額返還） */
  status: 'official' | 'cancelled';
  /** 返還の対象になった艇（欠場など）。この艇を含む舟券は返還 */
  refunded_boats: number[];
  payouts: Payout[];
}

export interface BetInput {
  bet_type: BetType;
  combo: string;
  amount: number;
}

export type BetOutcome =
  | { status: 'hit'; payout: number }
  | { status: 'miss'; payout: 0 }
  | { status: 'refunded'; payout: 0; reason: 'race_cancelled' | 'boat_refunded' };

/**
 * 1枚の舟券を判定する。
 * - 中止・不成立のレースは返還
 * - 返還艇（欠場など）を含む舟券は返還
 * - 公式の払戻金一覧に同じ券種・組番があれば的中（払戻 = 100円あたり払戻金 × 金額 ÷ 100）
 * - 特払い（組番 "*"）があれば、その券種の返還でない舟券すべてに払い戻す
 * 返還は成績計算から除外する（投票額にも払戻額にも数えない）
 */
export function judgeBet(bet: BetInput, result: RaceResult): BetOutcome {
  if (result.status === 'cancelled') return { status: 'refunded', payout: 0, reason: 'race_cancelled' };
  if (comboBoats(bet.combo).some((b) => result.refunded_boats.includes(b))) return { status: 'refunded', payout: 0, reason: 'boat_refunded' };
  const units = bet.amount / UNIT;
  const hits = result.payouts.filter((p) => p.bet_type === bet.bet_type && (p.combo === bet.combo || p.combo === SPECIAL_COMBO));
  if (hits.length === 0) return { status: 'miss', payout: 0 };
  return { status: 'hit', payout: Math.round(hits.reduce((s, p) => s + p.payout * units, 0)) };
}

export interface BalanceRow {
  status: string;
  amount: number;
  payout: number;
}

/**
 * その日の残高（残高方式、requirements.md v0.3）。
 * 残高 = 開始残高 − 提出額（取消を除く）+ 精算済みの返還額 + 精算済みの的中払戻。
 * 精算前（accepted・locked）の舟券は差し引いたまま。日をまたいだ加算はしない（呼び出し側が同じ開催日の舟券だけを渡す）
 */
export function dayBalance(start: number, rows: readonly BalanceRow[]): { start: number; staked: number; credited: number; balance: number } {
  let staked = 0;
  let credited = 0;
  for (const r of rows) {
    if (r.status === 'cancelled') continue;
    staked += r.amount;
    if (r.status === 'refunded') credited += r.amount;
    else if (r.status === 'hit') credited += r.payout;
  }
  return { start, staked, credited, balance: start - staked + credited };
}

/** 回収率（%、小数第1位まで）。投票がなければ null */
export function recoveryPct(payout: number, stake: number): number | null {
  return stake > 0 ? Math.round((payout / stake) * 1000) / 10 : null;
}

/** 的中率（%、小数第1位まで）。判定済みの舟券がなければ null */
export function hitRatePct(hits: number, judged: number): number | null {
  return judged > 0 ? Math.round((hits / judged) * 1000) / 10 : null;
}

export interface StandingInput {
  agent_id: string;
  stake: number;
  payout: number;
}

/**
 * 回収率の降順で順位を付ける（同率は同順位）。投票のないAIは順位なし（rank 0）。
 * 同率のときは払戻額の多いほうを上に表示するが、順位は同じにする
 */
export function rankByRecovery<T extends StandingInput>(rows: T[]): (T & { rank: number })[] {
  const ratio = (r: T) => (r.stake > 0 ? r.payout / r.stake : -1);
  const sorted = [...rows].sort((a, b) => ratio(b) - ratio(a) || b.payout - a.payout || a.agent_id.localeCompare(b.agent_id));
  let prev: number | null = null;
  let prevRank = 0;
  return sorted.map((r, i) => {
    if (r.stake <= 0) return { ...r, rank: 0 };
    const v = ratio(r);
    const rank = prev !== null && Math.abs(v - prev) < 1e-12 ? prevRank : i + 1;
    prev = v;
    prevRank = rank;
    return { ...r, rank };
  });
}
