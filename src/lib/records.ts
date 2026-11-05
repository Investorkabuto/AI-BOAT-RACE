// 競走成績（Kファイル）の1レース分（要件定義 v1.0 系統3）。取り込みの検証、保存用の詰めた形、配布用の形。
// 取得と桁位置の解析は scripts/boatrace_text.py。ここは受け取った JSON を検証して保存・配布する側。
//
// いつ分かる値か: レースが終わった後（Kファイルはその日の夜に出る）。レース前の公開データには含めない。

import { BET_TYPES, normalizeCombo, SPECIAL_COMBO, type BetType } from './bets';

/** 着順の欄。1〜6=着順、F=フライング、L=出遅れ、K=欠場、S=失格（数字は事由の区分で、公式の凡例に従う） */
export type Place = number | string;

export interface RecordRow {
  place: Place;
  boat: number; // 枠番
  toban: string;
  motor_no: number | null;
  boat_no: number | null;
  tenji: number | null; // 展示タイム（秒）
  course: number | null; // 進入コース
  st: number | null; // スタートタイミング（秒。F・L の艇もタイミングは正の値で、F・L は place に出る）
  time: number | null; // レースタイム（秒）
}

export interface RecordPayout {
  bet_type: BetType;
  combo: string; // 特払いは "*"
  payout: number;
  pop: number | null; // 人気順（単勝・複勝には無い）
}

export interface RaceRecord {
  weather: string | null;
  wind_dir: string | null;
  wind_m: number | null;
  wave_cm: number | null;
  kimarite: string | null;
  rows: RecordRow[]; // 着順の並び
  payouts: RecordPayout[];
  unsold: BetType[]; // 不成立の券種（その券種の舟券は全額返還）
}

const num = (v: unknown, lo: number, hi: number): number | null | undefined => {
  if (v === null || v === undefined) return null;
  return typeof v === 'number' && Number.isFinite(v) && v >= lo && v <= hi ? v : undefined; // undefined は不正
};
const int = (v: unknown, lo: number, hi: number): number | null | undefined => {
  const n = num(v, lo, hi);
  return n === undefined || n === null || Number.isInteger(n) ? n : undefined;
};
const text = (v: unknown, max: number): string | null => {
  if (typeof v !== 'string') return null;
  const s = v.normalize('NFKC').replace(/\s+/g, ' ').trim();
  return s ? s.slice(0, max) : null;
};

/** 取り込む1レース分を検証して正規化する。形が正しくなければ理由を返す */
export function normalizeRecord(input: Record<string, unknown>): { ok: true; record: RaceRecord } | { ok: false; reason: string } {
  const rawRows = input.rows;
  if (!Array.isArray(rawRows) || rawRows.length < 4 || rawRows.length > 6) return { ok: false, reason: 'rows は4〜6艇の配列' };
  const rows: RecordRow[] = [];
  for (const r of rawRows) {
    if (!r || typeof r !== 'object') return { ok: false, reason: '艇はオブジェクト' };
    const x = r as Record<string, unknown>;
    const place = typeof x.rank === 'string' ? x.rank : x.place;
    const p: Place | null =
      typeof place === 'number' && Number.isInteger(place) && place >= 1 && place <= 6 ? place
      : typeof place === 'string' && /^[1-6]$/.test(place) ? Number(place)
      : typeof place === 'string' && /^[SFKL]\d?$/.test(place) ? place
      : null;
    if (p === null) return { ok: false, reason: `着順の欄が不正: ${JSON.stringify(place)}` };
    if (typeof x.boat !== 'number' || !Number.isInteger(x.boat) || x.boat < 1 || x.boat > 6) return { ok: false, reason: `枠番が不正: ${JSON.stringify(x.boat)}` };
    if (typeof x.toban !== 'string' || !/^\d{4}$/.test(x.toban)) return { ok: false, reason: `登録番号が不正: ${JSON.stringify(x.toban)}` };
    const f = {
      motor_no: int(x.motor_no, 1, 999), boat_no: int(x.boat_no, 1, 999), tenji: num(x.tenji, 5, 9.99), course: int(x.course, 1, 6),
      st: num(x.st, 0, 9.99), time: num(x.time, 30, 600),
    };
    const bad = Object.entries(f).find(([, v]) => v === undefined);
    if (bad) return { ok: false, reason: `${bad[0]} が不正: ${JSON.stringify(x[bad[0]])}` };
    rows.push({ place: p, boat: x.boat, toban: x.toban, ...(f as Record<keyof typeof f, number | null>) });
  }
  if (new Set(rows.map((r) => r.boat)).size !== rows.length) return { ok: false, reason: '枠番が重複している' };
  if (!rows.some((r) => r.place === 1)) return { ok: false, reason: '1着の艇がいない' };

  if (!Array.isArray(input.payouts) || input.payouts.length === 0) return { ok: false, reason: 'payouts は1件以上の配列' };
  const payouts: RecordPayout[] = [];
  for (const raw of input.payouts) {
    const p = (raw ?? {}) as Record<string, unknown>;
    if (!(BET_TYPES as readonly string[]).includes(p.bet_type as string)) return { ok: false, reason: `券種が不正: ${JSON.stringify(p.bet_type)}` };
    const t = p.bet_type as BetType;
    const combo = p.combo === SPECIAL_COMBO ? SPECIAL_COMBO : normalizeCombo(t, p.combo);
    const payout = int(p.payout, 0, 100_000_000);
    const pop = int(p.pop, 1, 200);
    if (!combo || payout === undefined || payout === null || pop === undefined) return { ok: false, reason: `払戻金が不正: ${JSON.stringify(p)}` };
    payouts.push({ bet_type: t, combo, payout, pop });
  }
  const unsold: BetType[] = [];
  for (const u of Array.isArray(input.unsold) ? input.unsold : []) {
    if (!(BET_TYPES as readonly string[]).includes(u as string)) return { ok: false, reason: `不成立の券種が不正: ${JSON.stringify(u)}` };
    unsold.push(u as BetType);
  }
  const wind_m = int(input.wind_m, 0, 99);
  const wave_cm = int(input.wave_cm, 0, 999);
  if (wind_m === undefined || wave_cm === undefined) return { ok: false, reason: 'wind_m/wave_cm が不正' };
  return {
    ok: true,
    record: { weather: text(input.weather, 10), wind_dir: text(input.wind_dir, 10), wind_m, wave_cm, kimarite: text(input.kimarite, 10), rows, payouts, unsold },
  };
}

// ---- 保存用の詰めた形 ----
// 艇 = [着順, 枠番, 登録番号, モーター番号, ボート番号, 展示タイム×100, 進入コース, ST×100, レースタイム×10]（着順は 1〜6 の数か記号の文字）
// 払戻金 = [券種の番号, 組番, 払戻金, 人気]（券種の番号は BET_TYPES の添字）。不成立は券種の番号を "," でつなぐ

const x = (v: number | null, k: number): number | null => (v === null ? null : Math.round(v * k));
const d = (v: number | null, k: number): number | null => (v === null ? null : v / k);

export type RowTuple = [Place, number, string, number | null, number | null, number | null, number | null, number | null, number | null];
export type PayoutTuple = [number, string, number, number | null];

export const packRows = (rows: readonly RecordRow[]): string =>
  JSON.stringify(rows.map((r): RowTuple => [r.place, r.boat, r.toban, r.motor_no, r.boat_no, x(r.tenji, 100), r.course, x(r.st, 100), x(r.time, 10)]));

export const unpackRows = (json: string): RecordRow[] =>
  (JSON.parse(json) as RowTuple[]).map((t) => ({ place: t[0], boat: t[1], toban: t[2], motor_no: t[3], boat_no: t[4], tenji: d(t[5], 100), course: t[6], st: d(t[7], 100), time: d(t[8], 10) }));

export const packPayouts = (p: readonly RecordPayout[]): string => JSON.stringify(p.map((r): PayoutTuple => [BET_TYPES.indexOf(r.bet_type), r.combo, r.payout, r.pop]));

export const unpackPayouts = (json: string): RecordPayout[] =>
  (JSON.parse(json) as PayoutTuple[]).map((t) => ({ bet_type: BET_TYPES[t[0]]!, combo: t[1], payout: t[2], pop: t[3] }));

export const packUnsold = (u: readonly BetType[]): string => u.map((t) => BET_TYPES.indexOf(t)).join(',');
export const unpackUnsold = (s: string): BetType[] => (s === '' ? [] : s.split(',').map((i) => BET_TYPES[Number(i)]!));
