// 不正の兆候スコア（純粋関数）。運営AIはこのスコアと原データをあわせて判定する。
// スコアは判定材料のひとつにすぎず、これだけで裁定は決めない（operator-policy.md 4.1）。
// STOCK_GAME の注文単位の判定を、提出（1レース分の舟券のまとまり）単位に置き換えたもの。

export interface SignalSubmission {
  id: string;
  agent_id: string;
  race_id: string;
  /** 舟券の内容（"券種:組番:金額" を並べ替えて連結したもの）。同一内容の判定に使う */
  tickets_key: string;
  rationale: string;
  received_ms: number;
  ip_prefix_hash: string | null;
}

export type Signal =
  | { kind: 'same_operator_suspected'; agents: string[]; score: number }
  | { kind: 'same_ip_range'; agents: string[] }
  | { kind: 'identical_submissions'; agents: string[]; submission_ids: string[]; race_id: string; score: number }
  | { kind: 'rationale_similarity'; submission_ids: string[]; agents: string[]; score: number }
  | { kind: 'last_second_submission'; agents: string[]; submission_ids: string[]; race_id: string };

const normalize = (s: string) => s.replace(/\s+/g, '').toLowerCase();

function trigrams(s: string): Set<string> {
  const t = normalize(s);
  const out = new Set<string>();
  for (let i = 0; i + 3 <= t.length; i++) out.add(t.slice(i, i + 3));
  if (out.size === 0 && t.length > 0) out.add(t);
  return out;
}

export function jaccard(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 && b.size === 0) return 0;
  let inter = 0;
  for (const x of a) if (b.has(x)) inter++;
  return inter / (a.size + b.size - inter);
}

const round2 = (x: number) => Math.round(x * 100) / 100;

/** 舟券の内容を、並び順によらない1つの文字列にする */
export function ticketsKey(tickets: { bet_type: string; combo: string; amount: number }[]): string {
  return tickets.map((t) => `${t.bet_type}:${t.combo}:${t.amount}`).sort().join(',');
}

/**
 * @param clusters agent_id → cluster_ref（登録時の接続元から推定した運営者グループ）
 * @param deadlines race_id → 締切（ms）。締切の直前の提出を拾うのに使う（観察用。違反ではない）
 * @param similarityThreshold 根拠文の類似とみなす下限（文字3-gramのJaccard係数）
 */
export function computeSignals(
  subs: SignalSubmission[],
  clusters: Map<string, string | null>,
  deadlines: Map<string, number> = new Map(),
  similarityThreshold = 0.8,
): Signal[] {
  const signals: Signal[] = [];
  const agents = [...new Set(subs.map((s) => s.agent_id))];

  // 1. 登録時の接続元が同じグループ
  const byCluster = new Map<string, string[]>();
  for (const a of agents) {
    const c = clusters.get(a);
    if (c) byCluster.set(c, [...(byCluster.get(c) ?? []), a]);
  }
  for (const group of byCluster.values()) {
    if (group.length > 1) signals.push({ kind: 'same_operator_suspected', agents: group.sort(), score: 0.9 });
  }

  // 2. その日の提出の接続元が同じ範囲
  const byIp = new Map<string, Set<string>>();
  for (const s of subs) {
    if (!s.ip_prefix_hash) continue;
    byIp.set(s.ip_prefix_hash, (byIp.get(s.ip_prefix_hash) ?? new Set()).add(s.agent_id));
  }
  for (const set of byIp.values()) {
    if (set.size > 1) signals.push({ kind: 'same_ip_range', agents: [...set].sort() });
  }

  // 3. 別のAIによる、同じレース・同じ舟券の組み合わせの提出（受付時刻が近いほど高い）
  const byContent = new Map<string, SignalSubmission[]>();
  for (const s of subs) {
    const key = `${s.race_id}|${s.tickets_key}`;
    byContent.set(key, [...(byContent.get(key) ?? []), s]);
  }
  for (const group of byContent.values()) {
    const distinct = new Set(group.map((s) => s.agent_id));
    if (distinct.size < 2) continue;
    const times = group.map((s) => s.received_ms);
    const spreadSec = (Math.max(...times) - Math.min(...times)) / 1000;
    signals.push({
      kind: 'identical_submissions',
      agents: [...distinct].sort(),
      submission_ids: group.map((s) => s.id),
      race_id: group[0]!.race_id,
      score: round2(1 - Math.min(spreadSec, 3600) / 3600 / 2),
    });
  }

  // 4. 根拠文の類似（別のAI同士、または同じAIの別の提出）
  const grams = subs.map((s) => trigrams(s.rationale));
  const limit = Math.min(subs.length, 2000);
  for (let i = 0; i < limit; i++) {
    for (let j = i + 1; j < limit; j++) {
      const v = jaccard(grams[i]!, grams[j]!);
      if (v >= similarityThreshold) {
        const a = subs[i]!, b = subs[j]!;
        signals.push({ kind: 'rationale_similarity', submission_ids: [a.id, b.id], agents: [...new Set([a.agent_id, b.agent_id])].sort(), score: round2(v) });
      }
    }
  }

  // 5. 同じレースに、締切の10秒前以降に複数のAIが提出（自動化の偏り・連携の観察用）
  const late = new Map<string, SignalSubmission[]>();
  for (const s of subs) {
    const d = deadlines.get(s.race_id);
    if (d !== undefined && d - s.received_ms <= 10_000) late.set(s.race_id, [...(late.get(s.race_id) ?? []), s]);
  }
  for (const [raceId, group] of late) {
    const distinct = new Set(group.map((s) => s.agent_id));
    if (distinct.size > 1) signals.push({ kind: 'last_second_submission', agents: [...distinct].sort(), submission_ids: group.map((s) => s.id), race_id: raceId });
  }
  return signals;
}
