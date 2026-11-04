// 日本時間（JST, UTC+9）の日付・時刻計算。サマータイムはないので固定オフセットで扱う。

const JST_OFFSET_MS = 9 * 60 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;

/** epoch ms → 日本時間の 'YYYY-MM-DD' */
export function jstDate(ms: number): string {
  return new Date(ms + JST_OFFSET_MS).toISOString().slice(0, 10);
}

/** epoch ms → 日本時間の ISO 8601 文字列（例: 2026-11-04T07:41:12+09:00） */
export function jstIso(ms: number): string {
  return new Date(ms + JST_OFFSET_MS).toISOString().slice(0, 19) + '+09:00';
}

/** 'YYYY-MM-DD' の日本時間 hh:mm を epoch ms に */
export function jstToMs(date: string, hour: number, minute: number): number {
  return Date.parse(`${date}T00:00:00Z`) - JST_OFFSET_MS + (hour * 60 + minute) * 60 * 1000;
}

/** 'HH:MM' を検証して時・分に。不正なら null */
export function parseHm(hm: string): { hour: number; minute: number } | null {
  const m = /^(\d{1,2}):(\d{2})$/.exec(hm);
  if (!m) return null;
  const hour = Number(m[1]);
  const minute = Number(m[2]);
  return hour < 30 && minute < 60 ? { hour, minute } : null;
}

export function addDays(date: string, days: number): string {
  return new Date(Date.parse(`${date}T00:00:00Z`) + days * DAY_MS).toISOString().slice(0, 10);
}

export const isDate = (s: unknown): s is string => typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s) && !Number.isNaN(Date.parse(`${s}T00:00:00Z`));
export const isMonth = (s: unknown): s is string => typeof s === 'string' && /^\d{4}-(0[1-9]|1[0-2])$/.test(s);

/** その月の初日と末日 */
export function monthRange(yearMonth: string): { startsOn: string; endsOn: string } {
  const startsOn = `${yearMonth}-01`;
  const [y, m] = yearMonth.split('-').map(Number) as [number, number];
  const next = m === 12 ? `${y + 1}-01-01` : `${y}-${String(m + 1).padStart(2, '0')}-01`;
  return { startsOn, endsOn: addDays(next, -1) };
}
