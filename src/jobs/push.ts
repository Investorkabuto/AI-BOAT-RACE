// 観戦画面（ホーム画面に追加したアプリ）への通知。的中が出たレースごとに1件（精算で push_outbox に積む）。
// 定時処理で、許可した端末へ送る。1回の定時処理で1台に送るのは1件まで（たまっていれば、まとめて1件にする）
import type { Env } from '../env';
import type { RaceRow } from '../db/repo';
import { BET_TYPE_JA, type BetType } from '../lib/bets';
import { raceLabel } from '../lib/venues';
import { sendPush } from '../lib/webpush';

/** 1回の定時処理で送る端末の数の上限（Workers の1回あたりの外部リクエスト数の上限に余裕を残す） */
export const PUSH_PER_TICK = 40;
/** これより古い通知は送らない（レースの結果は、時間がたつと通知の意味が薄い） */
export const PUSH_FRESH_MS = 60 * 60 * 1000;
/** 続けてこの回数失敗した端末は、登録を消す */
const DROP_AFTER_FAILURES = 20;

export interface PushPayload {
  title: string;
  body: string;
  url: string;
  tag: string;
}

const yen = (n: number) => `${String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ',')}円`;

/** 的中の通知を積む文（精算の batch に入れる） */
export async function hitPushStatement(
  db: D1Database,
  race: RaceRow,
  hits: { agentId: string; bets: { bet_type: string; combo: string; payout: number }[] }[],
  nowMs: number,
): Promise<D1PreparedStatement> {
  const ids = hits.map((h) => h.agentId);
  const names = new Map(
    (await db.prepare(`SELECT id, display_name FROM agents WHERE id IN (${ids.map(() => '?').join(',')})`).bind(...ids).all<{ id: string; display_name: string }>()).results.map((r) => [r.id, r.display_name]),
  );
  const label = raceLabel(race.jcd, race.rno);
  const lines = hits
    .map((h) => ({ name: names.get(h.agentId) ?? h.agentId, payout: h.bets.reduce((s, b) => s + b.payout, 0), bets: h.bets }))
    .sort((a, b) => b.payout - a.payout)
    .map((h) => `${h.name} 払戻 ${yen(h.payout)}（${h.bets.map((b) => `${BET_TYPE_JA[b.bet_type as BetType] ?? b.bet_type} ${b.combo}`).join('・')}）`);
  const payload: PushPayload = { title: `🎯 ${label} 的中`, body: lines.join('\n'), url: `/race/${race.id}`, tag: `hit-${race.id}` };
  return db.prepare('INSERT OR IGNORE INTO push_outbox (race_id, payload, created_ms) VALUES (?, ?, ?)').bind(race.id, JSON.stringify(payload), nowMs);
}

/** たまった通知を1件にまとめる */
export function combine(items: PushPayload[]): PushPayload {
  if (items.length === 1) return items[0]!;
  return {
    title: `🎯 ${items.length}レースで的中`,
    body: items.map((p) => `${p.title.replace(/^🎯 /, '')}：${p.body.split('\n')[0]}${p.body.includes('\n') ? ' ほか' : ''}`).join('\n'),
    url: '/',
    tag: 'hit-summary',
  };
}

export async function deliverPush(env: Env, nowMs: number): Promise<string[]> {
  const db = env.DB;
  if (!env.VAPID_PUBLIC_KEY || !env.VAPID_PRIVATE_KEY) return [];
  const keys = { publicKey: env.VAPID_PUBLIC_KEY, privateKey: env.VAPID_PRIVATE_KEY, subject: env.VAPID_SUBJECT || 'https://ai-boat-race.son-investment.workers.dev' };
  const latest = (await db.prepare('SELECT MAX(id) AS id FROM push_outbox').first<{ id: number | null }>())?.id ?? 0;
  if (!latest) return [];
  const subs = (
    await db
      .prepare('SELECT endpoint, p256dh, auth, last_push_id, failures FROM push_subscriptions WHERE last_push_id < ? ORDER BY last_push_id, updated_ms LIMIT ?')
      .bind(latest, PUSH_PER_TICK)
      .all<{ endpoint: string; p256dh: string; auth: string; last_push_id: number; failures: number }>()
  ).results;
  if (!subs.length) return [];
  const minCursor = Math.min(...subs.map((s) => s.last_push_id));
  const outbox = (
    await db.prepare('SELECT id, payload, created_ms FROM push_outbox WHERE id > ? ORDER BY id').bind(minCursor).all<{ id: number; payload: string; created_ms: number }>()
  ).results;
  let sent = 0;
  let dropped = 0;
  for (const s of subs) {
    const items = outbox.filter((o) => o.id > s.last_push_id && o.created_ms >= nowMs - PUSH_FRESH_MS).map((o) => JSON.parse(o.payload) as PushPayload);
    if (!items.length) {
      await db.prepare('UPDATE push_subscriptions SET last_push_id = ? WHERE endpoint = ?').bind(latest, s.endpoint).run();
      continue;
    }
    const status = await sendPush(s, JSON.stringify(combine(items)), keys, nowMs);
    if (status >= 200 && status < 300) {
      sent++;
      await db.prepare('UPDATE push_subscriptions SET last_push_id = ?, failures = 0, updated_ms = ? WHERE endpoint = ?').bind(latest, nowMs, s.endpoint).run();
    } else if (status === 404 || status === 410 || s.failures + 1 >= DROP_AFTER_FAILURES) {
      // 通知の許可が取り消された・アプリが消された
      dropped++;
      await db.prepare('DELETE FROM push_subscriptions WHERE endpoint = ?').bind(s.endpoint).run();
    } else {
      await db.prepare('UPDATE push_subscriptions SET failures = failures + 1, updated_ms = ? WHERE endpoint = ?').bind(nowMs, s.endpoint).run();
    }
  }
  // 古い通知は消す（送り終えた分は要らない）
  await db.prepare('DELETE FROM push_outbox WHERE created_ms < ? AND id < ?').bind(nowMs - 24 * PUSH_FRESH_MS, latest).run();
  return sent || dropped ? [`push: sent ${sent}, dropped ${dropped}`] : [];
}
