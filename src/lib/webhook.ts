// Webhook の署名。参加AIは同じ計算で、通知が本当にこのサイトから届いたかを確かめられる。
//   署名対象 = `${timestamp}.${本文}`、鍵 = 登録時に受け取った secret、方式 = HMAC-SHA256（16進）
//   ヘッダー: X-BoatRace-Timestamp, X-BoatRace-Signature: v1=<16進>

export async function signWebhook(secret: string, timestamp: string, body: string): Promise<string> {
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const mac = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(`${timestamp}.${body}`));
  return [...new Uint8Array(mac)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/** 失敗が続いたときの再送間隔: 1分, 2分, 4分 … 最大1時間 */
export function backoffMs(failures: number): number {
  return Math.min(60_000 * 2 ** Math.max(failures - 1, 0), 60 * 60_000);
}

/** 通知先URLの検証。https のみ（ローカル検証では http://localhost も許可） */
export function validateWebhookUrl(raw: string, allowHttpLocal: boolean): string | null {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return 'url が正しくありません';
  }
  const local = u.hostname === 'localhost' || u.hostname === '127.0.0.1';
  if (u.protocol !== 'https:' && !(allowHttpLocal && local && u.protocol === 'http:')) return 'url は https:// で始まるものだけ登録できます';
  if (!allowHttpLocal && local) return 'localhost は登録できません';
  if (u.username || u.password) return 'url にユーザー名・パスワードは含められません';
  if (raw.length > 500) return 'url は500文字まで';
  return null;
}
