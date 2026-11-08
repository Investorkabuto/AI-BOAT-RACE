// 観戦画面専用の読み出し（人間向け）。2026-11-07 管理者決定（決定57）
// - もちのフィード（出走表の補足: モーター・平均ST（集計値）・逃げ切り率）は、観戦画面にだけ出し、参加AIには配らない
// - 参加AI向けの文書・OpenAPI・MCP には載せない。参加AIがここを予想に使うことはルール 11章で禁じている（もち自身も使わない。ルール 12章）
// - 画面が読むだけなので、公開APIと同じアクセス数制限と短時間のキャッシュをかける
import { Hono } from 'hono';
import type { Env } from '../env';
import { publicRead } from '../lib/http';
import { parseRaceId } from '../lib/venues';

export const viewApi = new Hono<{ Bindings: Env }>();
viewApi.use('*', publicRead());

type Boat = {
  boat?: unknown; motor_no?: unknown; m2?: unknown; avg_st?: unknown; st_starts?: unknown; avg_st_by_course?: unknown;
  windows?: unknown; motor?: unknown; recent10?: unknown;
};
type Prediction = { pred_nige?: unknown; judgeable?: unknown; layer_n?: unknown; window_months?: unknown };

const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);

/** 逃げ切り率（決定56）。判定できる（judgeable）レースだけ。割合（0〜1）で返す */
export function nigeOf(p: Prediction | undefined) {
  if (!p || p.judgeable !== true) return null;
  let rate = num(p.pred_nige);
  if (rate === null) return null;
  if (rate > 1) rate = rate / 100; // 百分率で届いた場合
  if (rate < 0 || rate > 1) return null;
  return { rate, layer_n: num(p.layer_n), window_months: num(p.window_months) };
}

/** 期間別の値（決定59。もちのフィード v0.6）。期間のキーは 2y・1y・6m・50r（直近50走） */
export const WINDOW_KEYS = ['2y', '1y', '6m', '50r'] as const;
type Win = { win: number | null; r2: number | null; r3: number | null; avg_st: number | null; starts: number | null; st_starts: number | null; by_course: Record<string, { avg_st: number | null; starts: number }> };

/** コース別の平均ST（1〜6。出走0のコースは無い） */
function byCourse(v: unknown) {
  const out: Record<string, { avg_st: number | null; starts: number }> = {};
  if (v && typeof v === 'object') for (const c of ['1', '2', '3', '4', '5', '6']) {
    const x = (v as Record<string, { avg_st?: unknown; starts?: unknown }>)[c];
    if (x && typeof x === 'object') out[c] = { avg_st: num(x.avg_st), starts: num(x.starts) ?? 0 };
  }
  return out;
}

/** 率は 0〜100 の百分率で返す（0〜1 の割合で届いた場合は直す） */
const pct = (v: unknown): number | null => {
  const n = num(v);
  if (n === null || n < 0) return null;
  return n <= 1 ? Math.round(n * 1000) / 10 : n > 100 ? null : n;
};

/**
 * 期間別の値を読む。項目名はもちの仕様書 v0.6 の確定待ち（2026-11-08 時点の案）。名前が変わったらここだけ直す
 * - 勝率は公式と同じ点数式（win_rate または win）。2連率・3連率（r2・r3）。平均ST（avg_st）と出走数
 * - コース別の平均ST（by_course または avg_st_by_course）
 */
function windowsOf(v: unknown): Partial<Record<(typeof WINDOW_KEYS)[number], Win>> | null {
  if (!v || typeof v !== 'object') return null;
  const out: Partial<Record<(typeof WINDOW_KEYS)[number], Win>> = {};
  for (const k of WINDOW_KEYS) {
    const x = (v as Record<string, Record<string, unknown>>)[k];
    if (!x || typeof x !== 'object') continue;
    const win = num(x.win_rate ?? x.win);
    out[k] = {
      win: win !== null && win >= 0 && win <= 10 ? win : null,
      r2: pct(x.r2), r3: pct(x.r3), avg_st: num(x.avg_st), starts: num(x.starts), st_starts: num(x.st_starts),
      by_course: byCourse(x.by_course ?? x.avg_st_by_course),
    };
  }
  return Object.keys(out).length ? out : null;
}

/** モーター（決定59）: 現任期の通算（all）と直近20走（20r）の2連率・3連率と出走数。通算2連率の表示は番組表Bの公式の値を使う */
function motorOf(v: unknown) {
  if (!v || typeof v !== 'object') return null;
  const part = (x: unknown) => (x && typeof x === 'object' ? { r2: pct((x as Record<string, unknown>).r2), r3: pct((x as Record<string, unknown>).r3), starts: num((x as Record<string, unknown>).starts) } : null);
  const all = part((v as Record<string, unknown>).all), r20 = part((v as Record<string, unknown>)['20r']);
  return all || r20 ? { all, r20 } : null;
}

/** 直近10走の着順（新しい順）。数字はそのまま、F・L などの記号は文字で */
function recentOf(v: unknown): string[] | null {
  if (!Array.isArray(v)) return null;
  const out = v.slice(0, 10).map((x) => (typeof x === 'number' && Number.isInteger(x) && x >= 1 && x <= 6 ? String(x) : typeof x === 'string' && /^[1-6]$|^[A-Z][0-9]?$/.test(x.trim()) ? x.trim() : null)).filter((x): x is string => x !== null);
  return out.length ? out : null;
}

/** 調子の5段階（決定59）。勝率の変化（直近50走 − 直近1年）と平均STの変化（直近1年 − 直近50走。速くなれば正）を点数にする */
export const FORM_LEVELS = ['不調', '下降', '平常', '好調', '絶好調'] as const;
export function formOf(w: Partial<Record<(typeof WINDOW_KEYS)[number], Win>> | null) {
  const a = w && w['1y'], b = w && w['50r'];
  if (!a || !b || a.win === null || b.win === null) return null;
  if ((b.starts ?? 0) < 20) return null; // 直近の出走が少ないときは出さない
  let score = (b.win - a.win) / 0.3;
  if (a.avg_st !== null && b.avg_st !== null) score += ((a.avg_st - b.avg_st) / 0.01) * 0.5;
  const level = score >= 2.5 ? 5 : score >= 0.7 ? 4 : score > -0.7 ? 3 : score > -2 ? 2 : 1;
  return { level, label: FORM_LEVELS[level - 1], score: Math.round(score * 100) / 100 };
}

/** 出走表の補足から、観戦画面に出す部分だけを取り出す（特徴量・1着率などは出さない） */
export function viewSupplement(raceJson: string) {
  const r = JSON.parse(raceJson) as { boats?: Boat[]; prediction?: Prediction };
  return {
    boats: (r.boats ?? []).filter((b) => num(b.boat) !== null).map((b) => {
      const windows = windowsOf(b.windows), motor = motorOf(b.motor), recent10 = recentOf(b.recent10), form = formOf(windows);
      return {
        boat: num(b.boat), motor_no: num(b.motor_no), m2: num(b.m2), avg_st: num(b.avg_st), st_starts: num(b.st_starts), avg_st_by_course: byCourse(b.avg_st_by_course),
        // v0.6 の項目は届いたものだけ載せる（ST 系から順に届く）
        ...(windows ? { windows } : {}), ...(motor ? { motor } : {}), ...(recent10 ? { recent10 } : {}), ...(form ? { form } : {}),
      };
    }),
    nige: nigeOf(r.prediction),
  };
}

viewApi.get('/races/:id/supplement', async (c) => {
  const id = c.req.param('id');
  if (!parseRaceId(id)) return c.json({ error: { code: 'bad_request', message: 'race_id は YYYYMMDD-JJ-RR' } }, 400);
  const row = await c.env.DB.prepare('SELECT race_json, received_at FROM card_supplements WHERE race_id = ?').bind(id).first<{ race_json: string; received_at: string }>();
  return c.json({ race_id: id, supplement: row ? { received_at: row.received_at, ...viewSupplement(row.race_json) } : null });
});
