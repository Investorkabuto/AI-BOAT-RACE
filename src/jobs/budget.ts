// 定時処理の裏方の作業（事前集計・詰めた形の片付け）が1日に使ってよい D1 の読み書きの量（v1.3 §9.2・§9.3）。
// D1 の無料プランは1日に読み出し500万行・書き込み10万行まで（日付は UTC で切り替わる = 日本時間の9:00）。
// 精算や観戦画面の分を残すため、裏方の作業はこの量を超えたらその日はやめる。使った量は app_state の bg:usage:{UTCの日付} に記録する
import { jstIso } from '../lib/time';

export const BG_READ_BUDGET = 1_500_000;
export const BG_WRITE_BUDGET = 40_000;

export interface Usage {
  key: string;
  r: number;
  w: number;
}

export async function loadUsage(db: D1Database, nowMs: number): Promise<Usage> {
  const key = `bg:usage:${new Date(nowMs).toISOString().slice(0, 10)}`;
  const row = await db.prepare('SELECT value FROM app_state WHERE key = ?').bind(key).first<{ value: string }>();
  const v = row ? (JSON.parse(row.value) as { r: number; w: number }) : { r: 0, w: 0 };
  return { key, r: v.r, w: v.w };
}

/** まだ使える量が残っているか（1回の作業の見込み readNeed・writeNeed を足しても上限以内か） */
export const hasRoom = (u: Usage, readNeed: number, writeNeed: number) => u.r + readNeed <= BG_READ_BUDGET && u.w + writeNeed <= BG_WRITE_BUDGET;

/** D1 の結果の meta から、読んだ行・書いた行を足す */
export function addMeta(u: Usage, results: readonly D1Result[]): void {
  for (const x of results) {
    const m = x.meta as { rows_read?: number; rows_written?: number; changes?: number };
    u.r += m.rows_read ?? 0;
    u.w += m.rows_written ?? m.changes ?? 0;
  }
}

export async function saveUsage(db: D1Database, u: Usage, nowMs: number): Promise<void> {
  await db.batch([
    db.prepare('INSERT INTO app_state (key, value, updated_at) VALUES (?, ?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at')
      .bind(u.key, JSON.stringify({ r: u.r, w: u.w }), jstIso(nowMs)),
    db.prepare("DELETE FROM app_state WHERE key LIKE 'bg:usage:%' AND key < ?").bind(u.key),
  ]);
}
