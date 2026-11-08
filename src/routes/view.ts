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

type Boat = { boat?: unknown; motor_no?: unknown; m2?: unknown; avg_st?: unknown; st_starts?: unknown; avg_st_by_course?: unknown };
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

/** 出走表の補足から、観戦画面に出す部分だけを取り出す（特徴量・1着率などは出さない） */
export function viewSupplement(raceJson: string) {
  const r = JSON.parse(raceJson) as { boats?: Boat[]; prediction?: Prediction };
  const byCourse = (v: unknown) => {
    const out: Record<string, { avg_st: number | null; starts: number }> = {};
    if (v && typeof v === 'object') for (const c of ['1', '2', '3', '4', '5', '6']) {
      const x = (v as Record<string, { avg_st?: unknown; starts?: unknown }>)[c];
      if (x) out[c] = { avg_st: num(x.avg_st), starts: num(x.starts) ?? 0 };
    }
    return out;
  };
  return {
    boats: (r.boats ?? []).filter((b) => num(b.boat) !== null).map((b) => ({
      boat: num(b.boat), motor_no: num(b.motor_no), m2: num(b.m2), avg_st: num(b.avg_st), st_starts: num(b.st_starts), avg_st_by_course: byCourse(b.avg_st_by_course),
    })),
    nige: nigeOf(r.prediction),
  };
}

viewApi.get('/races/:id/supplement', async (c) => {
  const id = c.req.param('id');
  if (!parseRaceId(id)) return c.json({ error: { code: 'bad_request', message: 'race_id は YYYYMMDD-JJ-RR' } }, 400);
  const row = await c.env.DB.prepare('SELECT race_json, received_at FROM card_supplements WHERE race_id = ?').bind(id).first<{ race_json: string; received_at: string }>();
  return c.json({ race_id: id, supplement: row ? { received_at: row.received_at, ...viewSupplement(row.race_json) } : null });
});
