// 出走表の選手の基本情報（要件定義 §6）。枠番・登録番号・氏名・級別・支部・年齢だけを扱う。
// モーター・ボート・展示・直前情報・成績などは扱わない（参加AIが各自で取得する）

export const GRADES = ['A1', 'A2', 'B1', 'B2'] as const;
export type Grade = (typeof GRADES)[number];

export interface Entrant {
  boat: number; // 枠番 1〜6（進入コースは当日の展示・本番で決まり、枠番どおりとは限らない）
  toban: string; // 登録番号（4桁）
  name: string;
  grade: Grade | null;
  branch: string | null; // 支部
  age: number | null;
}

const str = (v: unknown, max: number): string | null => {
  if (typeof v !== 'string') return null;
  const s = v.normalize('NFKC').replace(/\s+/g, ' ').trim();
  return s ? s.slice(0, max) : null;
};

/** 取り込んだ選手一覧を検証して正規化する。形が正しくなければ理由を返す */
export function normalizeEntrants(input: unknown): { ok: true; entrants: Entrant[] } | { ok: false; reason: string } {
  if (!Array.isArray(input) || input.length < 1 || input.length > 6) return { ok: false, reason: 'entrants は1〜6人の配列' };
  const out: Entrant[] = [];
  const seen = new Set<number>();
  for (const raw of input) {
    if (!raw || typeof raw !== 'object') return { ok: false, reason: '選手はオブジェクト' };
    const e = raw as Record<string, unknown>;
    const boat = e.boat;
    if (typeof boat !== 'number' || !Number.isInteger(boat) || boat < 1 || boat > 6 || seen.has(boat)) return { ok: false, reason: `枠番が不正: ${JSON.stringify(boat)}` };
    seen.add(boat);
    const toban = str(e.toban, 4);
    if (!toban || !/^\d{4}$/.test(toban)) return { ok: false, reason: `登録番号が不正: ${JSON.stringify(e.toban)}` };
    const name = str(e.name, 40);
    if (!name) return { ok: false, reason: '氏名がない' };
    const grade = str(e.grade, 2);
    const age = typeof e.age === 'number' && Number.isInteger(e.age) && e.age >= 15 && e.age <= 80 ? e.age : null;
    out.push({ boat, toban, name, grade: GRADES.includes(grade as Grade) ? (grade as Grade) : null, branch: str(e.branch, 10), age });
  }
  if (new Set(out.map((e) => e.toban)).size !== out.length) return { ok: false, reason: '同じ選手が複数の枠にいる（解析の誤り）' };
  return { ok: true, entrants: out.sort((a, b) => a.boat - b.boat) };
}

export interface Start {
  course: number; // 進入コース 1〜6
  boat: number; // 枠番
  st: string | null; // スタートタイミング（"0.15"、フライングは "F0.01"、出遅れは "L"）
}

/** 結果ページのスタート情報を検証して正規化する。形が正しくなければ null（結果の取り込み自体は止めない） */
export function normalizeStarts(input: unknown): Start[] | null {
  if (!Array.isArray(input) || input.length < 1 || input.length > 6) return null;
  const out: Start[] = [];
  const boats = new Set<number>();
  const courses = new Set<number>();
  for (const raw of input) {
    if (!raw || typeof raw !== 'object') return null;
    const { course, boat, st } = raw as Record<string, unknown>;
    if (typeof course !== 'number' || !Number.isInteger(course) || course < 1 || course > 6 || courses.has(course)) return null;
    if (typeof boat !== 'number' || !Number.isInteger(boat) || boat < 1 || boat > 6 || boats.has(boat)) return null;
    courses.add(course);
    boats.add(boat);
    const s = typeof st === 'string' ? st.normalize('NFKC').replace(/\s+/g, '').toUpperCase() : '';
    out.push({ course, boat, st: /^(?:[FL]?\d?\.\d{2}|L|K)$/.test(s) ? (s.startsWith('.') ? `0${s}` : s.replace(/^([FL])\./, '$10.')) : null });
  }
  return out.sort((a, b) => a.course - b.course);
}
