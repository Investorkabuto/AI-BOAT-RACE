// 公式HTMLの結果と、競走成績（Kファイル）の照合。同じレースについて、2つの経路で取った値が食い違っていないかを調べる。
// 食い違いは「どちらかの解析の誤り」か「公式の訂正」のどちらかなので、精算に使う前に人が気づけるようにする（要件定義 v1.0）。
// ここは判定だけ（DB には触らない）。

import type { RecordPayout, RecordRow } from './records';

/** 照合に使う、公式HTMLの結果（race_results と race_starts の中身） */
export interface HtmlResult {
  status: 'official' | 'cancelled';
  finish: number[][];
  refunded_boats: number[];
  payouts: { bet_type: string; combo: string; payout: number }[];
  start: { course: number; boat: number; st: string | null }[] | null;
}

/** 照合に使う、Kファイルの1レース分 */
export interface KRecord {
  rows: RecordRow[];
  payouts: RecordPayout[];
}

export type CheckField = 'status' | 'finish' | 'refunded' | 'payouts' | 'course' | 'st';

export interface Difference {
  field: CheckField;
  html: unknown;
  k: unknown;
}

/** 返還になる記号（欠場・フライング・出遅れ）。失格（S）は返還にしない（2026-11-05 運営AIの確認） */
const REFUND_PLACE = /^[FLK]/;

const sameJson = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

/** Kの着順を、HTMLと同じ形（着順の並び。同着は同じ要素に複数艇）にする */
export function kFinish(rows: readonly RecordRow[]): number[][] {
  const byPlace = new Map<number, number[]>();
  for (const r of rows) if (typeof r.place === 'number') byPlace.set(r.place, [...(byPlace.get(r.place) ?? []), r.boat]);
  return [...byPlace.entries()].sort((a, b) => a[0] - b[0]).map(([, boats]) => boats.sort((a, b) => a - b));
}

/** スタートタイミングの文字（".15"、"F.01"、"L"）を秒にする。読めなければ null */
function stSeconds(s: string | null): number | null {
  if (!s) return null;
  const m = /^[FL]?\s*(\d?\.\d{2})$/.exec(s.trim());
  return m ? Number(m[1]) : null;
}

const payKey = (p: { bet_type: string; combo: string; payout: number }) => `${p.bet_type}|${p.combo}|${p.payout}`;

/** 食い違いの一覧。空なら一致 */
export function crossCheck(html: HtmlResult, k: KRecord): Difference[] {
  const out: Difference[] = [];
  if (html.status !== 'official') {
    // Kに払戻金があるのに、HTMLが中止・不成立と言っている
    return [{ field: 'status', html: html.status, k: 'official' }];
  }
  const hf = html.finish.map((g) => [...g].sort((a, b) => a - b));
  const kf = kFinish(k.rows);
  // 着順は、HTMLに載っている分だけ照合する（完走しなかった艇は着順に出ない）
  if (!sameJson(hf, kf)) out.push({ field: 'finish', html: hf, k: kf });

  const kRefunded = k.rows.filter((r) => typeof r.place === 'string' && REFUND_PLACE.test(r.place)).map((r) => r.boat).sort((a, b) => a - b);
  const hRefunded = [...html.refunded_boats].sort((a, b) => a - b);
  if (!sameJson(hRefunded, kRefunded)) out.push({ field: 'refunded', html: hRefunded, k: kRefunded });

  const hp = html.payouts.map(payKey).sort();
  const kp = k.payouts.map(payKey).sort();
  if (!sameJson(hp, kp)) out.push({ field: 'payouts', html: hp.filter((x) => !kp.includes(x)), k: kp.filter((x) => !hp.includes(x)) });

  if (html.start && html.start.length) {
    const kCourse = new Map(k.rows.filter((r) => r.course !== null).map((r) => [r.boat, r]));
    const courseDiff: { boat: number; html: number; k: number }[] = [];
    const stDiff: { boat: number; html: number; k: number }[] = [];
    for (const s of html.start) {
      const row = kCourse.get(s.boat);
      if (!row) continue;
      if (row.course !== s.course) courseDiff.push({ boat: s.boat, html: s.course, k: row.course! });
      const hs = stSeconds(s.st);
      if (hs !== null && row.st !== null && Math.abs(hs - row.st) > 0.005) stDiff.push({ boat: s.boat, html: hs, k: row.st });
    }
    if (courseDiff.length) out.push({ field: 'course', html: courseDiff.map((x) => ({ boat: x.boat, course: x.html })), k: courseDiff.map((x) => ({ boat: x.boat, course: x.k })) });
    if (stDiff.length) out.push({ field: 'st', html: stDiff.map((x) => ({ boat: x.boat, st: x.html })), k: stDiff.map((x) => ({ boat: x.boat, st: x.k })) });
  }
  return out;
}

/** DB の保存形（race_results / race_starts の列）と、競走成績（race_boats・race_payouts から作った K の艇と払戻金）から照合する。どちらかが無ければ null（照合できない） */
export function checkStored(
  result: { status: string; finish_json: string; refunded_boats_json: string; payouts_json: string } | undefined,
  starts: { starts_json: string } | undefined,
  record: { rows: RecordRow[]; payouts: RecordPayout[] } | undefined,
): Difference[] | null {
  if (!result || !record) return null;
  return crossCheck(
    {
      status: result.status === 'cancelled' ? 'cancelled' : 'official',
      finish: JSON.parse(result.finish_json),
      refunded_boats: JSON.parse(result.refunded_boats_json),
      payouts: JSON.parse(result.payouts_json),
      start: starts ? JSON.parse(starts.starts_json) : null,
    },
    record,
  );
}
