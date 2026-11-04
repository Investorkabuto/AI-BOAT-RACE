// Webhook の配送。定時処理の最後に、未配送のイベントを参加AIごとにまとめて送る。
// Cloudflare 無料プランは1回の実行で外部への通信が50回までなので、1回あたりの送信先を絞る。
// 届かなくても参加AIに不利はない（同じイベントは受信箱 GET /events に残る）。
import type { Env } from '../env';
import { eventStatement } from '../db/repo';
import { jstIso } from '../lib/time';
import { backoffMs, signWebhook } from '../lib/webhook';

const MAX_ENDPOINTS_PER_RUN = 30;
const MAX_EVENTS_PER_POST = 50;
const DISABLE_AFTER_FAILURES = 30; // 1時間間隔に達してからおよそ1日
const TIMEOUT_MS = 5000;

interface Endpoint {
  agent_id: string;
  url: string;
  secret: string;
  last_event_id: number;
  failures: number;
}

export interface EventOut {
  id: number;
  type: string;
  created_at: string;
  data: unknown;
}

/** 1回分の送信。成功なら null、失敗なら理由 */
export async function postWebhook(url: string, secret: string, agentId: string, events: EventOut[], nowMs: number): Promise<string | null> {
  const body = JSON.stringify({ agent_id: agentId, events });
  const ts = String(Math.floor(nowMs / 1000));
  try {
    const r = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'User-Agent': 'ai-boat-race-webhook/1.0',
        'X-BoatRace-Timestamp': ts,
        'X-BoatRace-Signature': `v1=${await signWebhook(secret, ts, body)}`,
      },
      body,
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    return r.ok ? null : `HTTP ${r.status}`;
  } catch (e) {
    return e instanceof Error ? e.name === 'TimeoutError' ? 'timeout' : e.message.slice(0, 200) : 'error';
  }
}

export async function deliverWebhooks(env: Env, nowMs: number): Promise<string[]> {
  const db = env.DB;
  const endpoints = (
    await db
      .prepare(
        `SELECT w.agent_id, w.url, w.secret, w.last_event_id, w.failures FROM webhook_endpoints w
         WHERE w.disabled_at IS NULL AND w.next_attempt_ms <= ?
           AND EXISTS (SELECT 1 FROM events e WHERE e.agent_id = w.agent_id AND e.id > w.last_event_id)
         ORDER BY w.next_attempt_ms LIMIT ?`,
      )
      .bind(nowMs, MAX_ENDPOINTS_PER_RUN)
      .all<Endpoint>()
  ).results;
  const log: string[] = [];
  for (const ep of endpoints) {
    const rows = (
      await db
        .prepare('SELECT id, type, payload, created_at FROM events WHERE agent_id = ? AND id > ? ORDER BY id LIMIT ?')
        .bind(ep.agent_id, ep.last_event_id, MAX_EVENTS_PER_POST)
        .all<{ id: number; type: string; payload: string; created_at: string }>()
    ).results;
    if (rows.length === 0) continue;
    const events = rows.map((e) => ({ id: e.id, type: e.type, created_at: e.created_at, data: JSON.parse(e.payload) as unknown }));
    const err = await postWebhook(ep.url, ep.secret, ep.agent_id, events, nowMs);
    const now = jstIso(nowMs);
    if (err === null) {
      await db
        .prepare("UPDATE webhook_endpoints SET last_event_id = ?, failures = 0, next_attempt_ms = 0, last_status = 'ok', last_attempt_at = ? WHERE agent_id = ?")
        .bind(events.at(-1)!.id, now, ep.agent_id)
        .run();
      log.push(`webhook ok: ${ep.agent_id} (${events.length})`);
      continue;
    }
    const failures = ep.failures + 1;
    if (failures >= DISABLE_AFTER_FAILURES) {
      await db.batch([
        db.prepare('UPDATE webhook_endpoints SET failures = ?, last_status = ?, last_attempt_at = ?, disabled_at = ? WHERE agent_id = ?').bind(failures, err, now, now, ep.agent_id),
        eventStatement(db, ep.agent_id, 'webhook.disabled', { reason: err, failures, note: 'PUT /webhook で登録し直すと再開します。イベントは GET /events で受け取れます' }, nowMs),
      ]);
      log.push(`webhook disabled: ${ep.agent_id}`);
    } else {
      await db
        .prepare('UPDATE webhook_endpoints SET failures = ?, next_attempt_ms = ?, last_status = ?, last_attempt_at = ? WHERE agent_id = ?')
        .bind(failures, nowMs + backoffMs(failures), err, now, ep.agent_id)
        .run();
      log.push(`webhook failed: ${ep.agent_id} (${err})`);
    }
  }
  return log;
}
