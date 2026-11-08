// 締切前の直前情報とオッズ（要件定義 決定64）。取り込み（PUT /internal/live）の検証と、公開する形への変換。DB に依存しない
import { normalizeCombo, type BetType } from './bets';

/** オッズを取る時刻（締切の何分前か）。slot の名前 → 分 */
export const ODDS_SLOTS = { t10: 10, t7: 7 } as const;
export type OddsSlot = keyof typeof ODDS_SLOTS;
/** 直前情報を取りはじめる時刻（締切の何分前か） */
export const BEFOREINFO_MIN = 15;
/** 取り込むオッズの券種と、組の数（3連単だけ。2026-11-09 管理者決定。広げるときはここに足す） */
export const ODDS_TYPES: Partial<Record<BetType, number>> = { sanrentan: 120 };

const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
const numOrNull = (v: unknown, lo: number, hi: number) => (isNum(v) && v >= lo && v <= hi ? v : null);
const text = (v: unknown, max: number) => (typeof v === 'string' && v.trim() ? v.trim().slice(0, max) : null);

export interface BeforeInfo {
  boats: { boat: number; weight: number | null; adjust_weight: number | null; exhibit_time: number | null; tilt: number | null; propeller: string | null; parts: string[] }[];
  start_exhibition: { course: number; boat: number; st: string | null }[];
  weather: { as_of: string | null; weather: string | null; temperature: number | null; wind_m: number | null; wind_dir: number | null; water_temperature: number | null; wave_cm: number | null } | null;
}

/** 直前情報を検証して正規化する。形が違えば null */
export function normalizeBeforeInfo(raw: unknown): BeforeInfo | null {
  const x = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  if (!Array.isArray(x.boats) || x.boats.length !== 6) return null;
  const boats: BeforeInfo['boats'] = [];
  for (const b of x.boats as Record<string, unknown>[]) {
    if (!b || !Number.isInteger(b.boat) || (b.boat as number) < 1 || (b.boat as number) > 6) return null;
    boats.push({
      boat: b.boat as number,
      weight: numOrNull(b.weight, 30, 90),
      adjust_weight: numOrNull(b.adjust_weight, 0, 20),
      exhibit_time: numOrNull(b.exhibit_time, 5, 9),
      tilt: numOrNull(b.tilt, -1, 4),
      propeller: text(b.propeller, 10),
      parts: Array.isArray(b.parts) ? (b.parts as unknown[]).map((p) => text(p, 20)).filter((p): p is string => !!p).slice(0, 10) : [],
    });
  }
  if (new Set(boats.map((b) => b.boat)).size !== 6) return null;
  const start = Array.isArray(x.start_exhibition)
    ? (x.start_exhibition as Record<string, unknown>[])
        .filter((s) => s && Number.isInteger(s.course) && Number.isInteger(s.boat) && (s.boat as number) >= 1 && (s.boat as number) <= 6)
        .slice(0, 6)
        .map((s) => ({ course: s.course as number, boat: s.boat as number, st: text(s.st, 8) }))
    : [];
  const w = x.weather && typeof x.weather === 'object' ? (x.weather as Record<string, unknown>) : null;
  return {
    boats: boats.sort((a, b) => a.boat - b.boat),
    start_exhibition: start,
    weather: w
      ? {
          as_of: text(w.as_of, 20), weather: text(w.weather, 10), temperature: numOrNull(w.temperature, -20, 50), wind_m: numOrNull(w.wind_m, 0, 50),
          wind_dir: Number.isInteger(w.wind_dir) && (w.wind_dir as number) >= 0 && (w.wind_dir as number) <= 17 ? (w.wind_dir as number) : null,
          water_temperature: numOrNull(w.water_temperature, -5, 50), wave_cm: numOrNull(w.wave_cm, 0, 200),
        }
      : null,
  };
}

export type OddsData = Partial<Record<BetType, Record<string, number | null>>>;

/** オッズを検証して正規化する（組番は正規化し、券種ごとに組の数が合うものだけ残す）。1つも残らなければ null */
export function normalizeOdds(raw: unknown): OddsData | null {
  const x = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  const out: OddsData = {};
  for (const [type, count] of Object.entries(ODDS_TYPES) as [BetType, number][]) {
    const m = x[type];
    if (!m || typeof m !== 'object') continue;
    const o: Record<string, number | null> = {};
    for (const [k, v] of Object.entries(m as Record<string, unknown>)) {
      const c = normalizeCombo(type, k);
      if (!c) continue;
      o[c] = numOrNull(v, 1, 100_000);
    }
    if (Object.keys(o).length === count) out[type] = o;
  }
  return Object.keys(out).length ? out : null;
}

/** 人気順（オッズの低い順）の上位 n 組。発売なし（null）は除く */
export function topOdds(m: Record<string, number | null> | undefined, n: number): { combo: string; odds: number }[] {
  return Object.entries(m ?? {})
    .filter((e): e is [string, number] => e[1] !== null)
    .sort((a, b) => a[1] - b[1])
    .slice(0, n)
    .map(([combo, odds]) => ({ combo, odds }));
}
