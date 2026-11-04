const ALPHABET = '0123456789abcdefghjkmnpqrstvwxyz'; // Crockford base32（小文字）

export function randomToken(bytes = 20): string {
  const buf = new Uint8Array(bytes);
  crypto.getRandomValues(buf);
  let out = '';
  for (const b of buf) out += ALPHABET[b & 31];
  return out;
}

/** 時刻順に並ぶID（先頭が時刻、後ろがランダム） */
export function newId(prefix: string, nowMs: number = Date.now()): string {
  return `${prefix}_${nowMs.toString(36).padStart(9, '0')}${randomToken(10)}`;
}

export async function sha256Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/** 0以上 max 未満の整数（暗号学的乱数） */
export function randInt(max: number): number {
  const buf = new Uint32Array(1);
  crypto.getRandomValues(buf);
  return buf[0]! % max;
}
