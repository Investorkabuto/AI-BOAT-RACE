// 出走表・結果の取得（GitHub Actions の Fetch boatrace）を、アプリの定時処理（5分ごと）から起動する。
// GitHub の schedule（cron）は起動が遅れたり来なかったりするため、確実に動くこちらを正とする。
//  - 出走表: 毎朝 7:30 と 9:30（日本時間）に1回ずつ。朝の申告期限（8:30）までに出走表がそろうように
//  - 結果: 締切後で結果待ちのレース（舟券があるレースだけ）があるときに、最短10分おき
// 取り込みは何度実行しても安全なので、GitHub 側の schedule が動いて二重になっても問題ない。
import type { Env } from '../env';
import { jstDate, jstIso, jstToMs } from '../lib/time';

export const FETCH_WORKFLOW = 'boatrace.yml';
/** 出走表を取る時刻（日本時間 HH:MM） */
export const SCHEDULE_SLOTS = ['07:30', '09:30'] as const;
/** 出走表の起動は、その時刻からこの時間内だけ行う（デプロイ直後などに夜になってから起動しないように） */
export const SLOT_WINDOW_MS = 2 * 60 * 60 * 1000;
/** 結果の取得の最短間隔 */
export const RESULTS_INTERVAL_MS = 10 * 60 * 1000;

export interface Dispatch {
  /** 起動済みの記録に使うキー（app_state.key） */
  key: string;
  command: 'schedule' | 'results';
  date?: string;
}

/** 今起動すべき取得の一覧（DB にも GitHub にも触らない。テスト用に分けてある） */
export function dueDispatches(p: { nowMs: number; done: ReadonlySet<string>; lastResultsMs: number; pendingResults: number }): Dispatch[] {
  const out: Dispatch[] = [];
  const today = jstDate(p.nowMs);
  for (const slot of SCHEDULE_SLOTS) {
    const [h, m] = slot.split(':').map(Number) as [number, number];
    const at = jstToMs(today, h, m);
    const key = `fetch:schedule:${today}:${slot}`;
    if (p.nowMs >= at && p.nowMs < at + SLOT_WINDOW_MS && !p.done.has(key)) out.push({ key, command: 'schedule', date: today });
  }
  if (p.pendingResults > 0 && p.nowMs - p.lastResultsMs >= RESULTS_INTERVAL_MS) out.push({ key: 'fetch:results', command: 'results' });
  return out;
}

const ERROR_KEY = 'fetch:dispatch_error';

async function setState(db: D1Database, key: string, value: string, nowMs: number) {
  await db
    .prepare('INSERT INTO app_state (key, value, updated_at) VALUES (?, ?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at')
    .bind(key, value, jstIso(nowMs))
    .run();
}

/** GitHub の workflow_dispatch を呼ぶ。成功なら null、失敗なら理由 */
async function runWorkflow(env: Env, d: Dispatch): Promise<string | null> {
  const inputs: Record<string, string> = { command: d.command };
  if (d.date) inputs.date = d.date;
  const r = await fetch(`https://api.github.com/repos/${env.GITHUB_REPO}/actions/workflows/${FETCH_WORKFLOW}/dispatches`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${env.GITHUB_TOKEN}`, Accept: 'application/vnd.github+json', 'User-Agent': 'ai-boat-race-worker', 'Content-Type': 'application/json' },
    body: JSON.stringify({ ref: env.FETCH_WORKFLOW_REF || 'main', inputs }),
  });
  return r.ok ? null : `${r.status} ${(await r.text()).slice(0, 300)}`;
}

export async function dispatchFetches(env: Env, nowMs: number): Promise<string[]> {
  const db = env.DB;
  const log: string[] = [];
  if (!env.GITHUB_TOKEN || !env.GITHUB_REPO) return log;
  const state = new Map(
    (await db.prepare("SELECT key, value FROM app_state WHERE key LIKE 'fetch:%'").all<{ key: string; value: string }>()).results.map((r) => [r.key, r.value]),
  );
  // 結果が必要なのは、締切後で結果が未取得のレース（舟券のないレースは締切で精算済みになるので含まれない）
  const pending = await db
    .prepare("SELECT COUNT(*) AS n FROM races WHERE status = 'locked' AND id NOT IN (SELECT race_id FROM race_results)")
    .first<{ n: number }>();
  const due = dueDispatches({ nowMs, done: new Set(state.keys()), lastResultsMs: Number(state.get('fetch:results') ?? 0), pendingResults: pending?.n ?? 0 });
  for (const d of due) {
    const err = await runWorkflow(env, d);
    if (err) {
      await setState(db, ERROR_KEY, `${jstIso(nowMs)} ${d.command}: ${err}`, nowMs);
      log.push(`fetch dispatch failed (${d.command}): ${err}`);
      continue;
    }
    await setState(db, d.key, String(nowMs), nowMs);
    if (state.has(ERROR_KEY)) {
      await db.prepare('DELETE FROM app_state WHERE key = ?').bind(ERROR_KEY).run();
      state.delete(ERROR_KEY);
    }
    log.push(`fetch dispatched: ${d.command}${d.date ? ` ${d.date}` : ''}`);
  }
  // 古い出走表の起動記録を消す（3日より前）
  await db.prepare("DELETE FROM app_state WHERE key LIKE 'fetch:schedule:%' AND updated_at < ?").bind(jstIso(nowMs - 3 * 24 * 60 * 60 * 1000)).run();
  return log;
}

/** 取得の起動が失敗し続けているか（滞留通知・設定確認に使う）。失敗していなければ null */
export async function fetchDispatchError(db: D1Database): Promise<{ message: string; since: string } | null> {
  const r = await db.prepare('SELECT value, updated_at FROM app_state WHERE key = ?').bind(ERROR_KEY).first<{ value: string; updated_at: string }>();
  return r ? { message: r.value, since: r.updated_at } : null;
}
