// 番組表（Bファイル）の出走表と基礎数値（要件定義 v1.0 系統1）。取り込みの検証、保存用の詰めた形、配布用の形。
// 取得と桁位置の解析は scripts/boatrace_text.py。ここは受け取った JSON を検証して保存・配布する側。
//
// いつ分かる値か: すべて前日の夕方（Bファイルの公開）から分かる。レース前日の時点の値で、後から上書きしない
// （版が変わったら旧版を race_card_history に残す）。展示タイム・オッズ・チルトなど締切直前の情報は含まない。

export const GRADES = ['A1', 'A2', 'B1', 'B2'] as const;
export type CardGrade = (typeof GRADES)[number];

/** 今節成績の1走分。着順 1〜6、または記号（S, F など。意味は公式の凡例に従う） */
export type SeriesMark = number | string;

export interface CardRacer {
  boat: number; // 枠番
  toban: string; // 登録番号
  name: string;
  age: number | null;
  branch: string | null; // 支部
  weight: number | null; // 体重
  grade: CardGrade;
  nat_win: number | null; // 全国勝率（0.00 は実績なし）
  nat_2r: number | null; // 全国2連率（%）
  loc_win: number | null; // 当地勝率
  loc_2r: number | null; // 当地2連率（%）
  motor_no: number | null;
  motor_2r: number | null; // モーター2連率（%）
  boat_no: number | null;
  boat_2r: number | null; // ボート2連率（%）
  series: SeriesMark[][]; // 今節成績: 前日までの日ごとの着順の並び（出走のない日は空）
  next_rno: number | null; // 公式の項目「早見」: 同じ日にもう1レース出走する場合のそのレース番号（空欄は1走だけ。null）
}

export interface Card {
  fixed_course: boolean; // 進入固定のレース
  distance: number | null; // 距離（m）
  racers: CardRacer[];
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

/** 今節成績を検証する。日ごとの配列（最大6日）で、各日は最大2走。着順は 1〜6、記号は英大文字1字 */
function normalizeSeries(v: unknown): SeriesMark[][] | undefined {
  if (!Array.isArray(v) || v.length > 6) return undefined;
  const out: SeriesMark[][] = [];
  for (const day of v) {
    if (!Array.isArray(day) || day.length > 2) return undefined;
    const marks: SeriesMark[] = [];
    for (const m of day) {
      if (typeof m === 'number' && Number.isInteger(m) && m >= 1 && m <= 6) marks.push(m);
      else if (typeof m === 'string' && /^[A-Z]$/.test(m)) marks.push(m);
      else return undefined;
    }
    out.push(marks);
  }
  return out;
}

/** 取り込む1レース分（選手の配列と、進入固定・距離）を検証して正規化する。形が正しくなければ理由を返す */
export function normalizeCard(input: { racers: unknown; fixed_course?: unknown; distance?: unknown }): { ok: true; card: Card } | { ok: false; reason: string } {
  const raw = input.racers;
  if (!Array.isArray(raw) || raw.length < 5 || raw.length > 6) return { ok: false, reason: 'racers は5〜6人の配列' };
  const out: CardRacer[] = [];
  for (const r of raw) {
    if (!r || typeof r !== 'object') return { ok: false, reason: '選手はオブジェクト' };
    const x = r as Record<string, unknown>;
    const boat = x.boat;
    if (typeof boat !== 'number' || !Number.isInteger(boat) || boat < 1 || boat > 6) return { ok: false, reason: `枠番が不正: ${JSON.stringify(boat)}` };
    const toban = typeof x.toban === 'string' && /^\d{4}$/.test(x.toban) ? x.toban : null;
    if (!toban) return { ok: false, reason: `登録番号が不正: ${JSON.stringify(x.toban)}` };
    const name = text(x.name, 40);
    if (!name) return { ok: false, reason: '氏名がない' };
    if (typeof x.grade !== 'string' || !(GRADES as readonly string[]).includes(x.grade)) return { ok: false, reason: `級別が不正: ${JSON.stringify(x.grade)}` };
    const series = normalizeSeries(x.series);
    if (!series) return { ok: false, reason: `今節成績が不正: ${JSON.stringify(x.series)}` };
    const f = {
      age: int(x.age, 15, 90), weight: int(x.weight, 30, 100),
      nat_win: num(x.nat_win, 0, 10), nat_2r: num(x.nat_2r, 0, 100), loc_win: num(x.loc_win, 0, 10), loc_2r: num(x.loc_2r, 0, 100),
      motor_no: int(x.motor_no, 1, 999), motor_2r: num(x.motor_2r, 0, 100), boat_no: int(x.boat_no, 1, 999), boat_2r: num(x.boat_2r, 0, 100),
      next_rno: int(x.next_rno, 1, 12),
    };
    const bad = Object.entries(f).find(([, v]) => v === undefined);
    if (bad) return { ok: false, reason: `${bad[0]} が不正: ${JSON.stringify(x[bad[0]])}` };
    const nums = f as Record<keyof typeof f, number | null>; // 上で undefined（不正）は弾いてある
    out.push({ boat, toban, name, branch: text(x.branch, 10), grade: x.grade as CardGrade, series, ...nums });
  }
  if (new Set(out.map((r) => r.boat)).size !== out.length) return { ok: false, reason: '枠番が重複している' };
  if (new Set(out.map((r) => r.toban)).size !== out.length) return { ok: false, reason: '同じ選手が複数の枠にいる（解析の誤り）' };
  const distance = int(input.distance, 100, 5000);
  if (distance === undefined) return { ok: false, reason: `distance が不正: ${JSON.stringify(input.distance)}` };
  return { ok: true, card: { fixed_course: input.fixed_course === true, distance, racers: out.sort((a, b) => a.boat - b.boat) } };
}

// ---- 保存用の詰めた形 ----
// 1艇 = [枠番, 登録番号, 氏名, 年齢, 支部, 体重, 級別, 全国勝率, 全国2連率, 当地勝率, 当地2連率, モーター番号, モーター2連率, ボート番号, ボート2連率, 今節成績, 同日の次のレース番号]
// 勝率・2連率は ×100 の整数。今節成績は日ごとの並びを "," でつないだ文字列（例 "32,1,24,12"。出走のない日は空）

const x100 = (v: number | null): number | null => (v === null ? null : Math.round(v * 100));
const div100 = (v: number | null): number | null => (v === null ? null : v / 100);

export const encodeSeries = (s: SeriesMark[][]): string => s.map((d) => d.join('')).join(',');
export const decodeSeries = (s: string): SeriesMark[][] => (s === '' ? [] : s.split(',').map((d) => [...d].map((c) => (/[1-6]/.test(c) ? Number(c) : c))));

export type CardRow = [
  number, string, string, number | null, string | null, number | null, string,
  number | null, number | null, number | null, number | null, number | null, number | null, number | null, number | null,
  string, number | null,
];

export function packRacers(racers: readonly CardRacer[]): string {
  return JSON.stringify(
    racers.map((r): CardRow => [
      r.boat, r.toban, r.name, r.age, r.branch, r.weight, r.grade,
      x100(r.nat_win), x100(r.nat_2r), x100(r.loc_win), x100(r.loc_2r), r.motor_no, x100(r.motor_2r), r.boat_no, x100(r.boat_2r),
      encodeSeries(r.series), r.next_rno,
    ]),
  );
}

export function unpackRacers(json: string): CardRacer[] {
  return (JSON.parse(json) as CardRow[]).map((r) => ({
    boat: r[0], toban: r[1], name: r[2], age: r[3], branch: r[4], weight: r[5], grade: r[6] as CardGrade,
    nat_win: div100(r[7]), nat_2r: div100(r[8]), loc_win: div100(r[9]), loc_2r: div100(r[10]),
    motor_no: r[11], motor_2r: div100(r[12]), boat_no: r[13], boat_2r: div100(r[14]),
    series: decodeSeries(r[15]), next_rno: r[16],
  }));
}

/** 出走表の選手の基本情報（枠番・登録番号・氏名・級別・支部・年齢）。公式HTMLの出走表がまだ無いときの代わりに使う */
export function entrantsOf(racers: readonly CardRacer[]) {
  return racers.map((r) => ({ boat: r.boat, toban: r.toban, name: r.name, grade: r.grade, branch: r.branch, age: r.age }));
}
