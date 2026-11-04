// ボートレース場。識別子は公式の場コード（jcd、2桁の文字列）をそのまま使う
export const VENUES: Record<string, string> = {
  '01': '桐生', '02': '戸田', '03': '江戸川', '04': '平和島', '05': '多摩川', '06': '浜名湖',
  '07': '蒲郡', '08': '常滑', '09': '津', '10': '三国', '11': 'びわこ', '12': '住之江',
  '13': '尼崎', '14': '鳴門', '15': '丸亀', '16': '児島', '17': '宮島', '18': '徳山',
  '19': '下関', '20': '若松', '21': '芦屋', '22': '福岡', '23': '唐津', '24': '大村',
};

export const isJcd = (s: unknown): s is string => typeof s === 'string' && s in VENUES;

/** レースID: 'YYYYMMDD-jcd-rno'（例: 20261104-12-07 = 2026-11-04 住之江 7R） */
export function raceId(date: string, jcd: string, rno: number): string {
  return `${date.replaceAll('-', '')}-${jcd}-${String(rno).padStart(2, '0')}`;
}

export function parseRaceId(id: string): { date: string; jcd: string; rno: number } | null {
  const m = /^(\d{4})(\d{2})(\d{2})-(\d{2})-(\d{2})$/.exec(id);
  if (!m || !isJcd(m[4])) return null;
  const rno = Number(m[5]);
  if (rno < 1 || rno > 12) return null;
  return { date: `${m[1]}-${m[2]}-${m[3]}`, jcd: m[4]!, rno };
}

export function raceLabel(jcd: string, rno: number): string {
  return `${VENUES[jcd] ?? jcd} ${rno}R`;
}
