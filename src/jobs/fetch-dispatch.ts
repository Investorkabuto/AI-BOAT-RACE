// 出走表・結果の取得（GitHub Actions の Fetch boatrace）を、アプリの定時処理（5分ごと）から起動する。
// GitHub の schedule（cron）は起動が遅れたり来なかったりするため、確実に動くこちらを正とする。
//  - 出走表: 毎朝 7:30 と 9:30（日本時間）に1回ずつ。朝の申告期限（8:30）までに出走表がそろうように
//  - 結果: 締切後で結果が未取得のレースがあるときに、最短10分おき。舟券のあるレース（精算用）に加えて、
//    当日の全レースを締切の5分後から3時間まで取りに行く（AIの参加に関係なく当日中に観戦画面で結果を出すため。2026-11-05 管理者決定）
//  - 全レースの結果: 毎朝 6:00 に前日分をまとめて保存する（公開・振り返り用。要件定義 §6）
//  - 過去分（B・K から過去のレースを作る）: 毎晩 2:00 に、直近から1年前まで（2026-11-05 管理者決定。容量を見て延ばす）、取り込み済みでない日を新しい順に（要件定義 v1.1・v1.2）
//  - 競走成績（K）: 当日の 21:30・23:20 と、翌朝 6:30 に前日分（展示タイム・進入・ST・天候・決まり手・払戻金。要件定義 v1.0 系統3）
// 取り込みは何度実行しても安全なので、GitHub 側の schedule が動いて二重になっても問題ない。
import type { Env } from '../env';
import { addDays, jstDate, jstIso, jstToMs } from '../lib/time';

export const FETCH_WORKFLOW = 'boatrace.yml';
/** 出走表を取る時刻（日本時間 HH:MM） */
export const SCHEDULE_SLOTS = ['07:30', '09:30'] as const;
/**
 * 番組表（公式テキストデータ B）を取る時刻。day=1 は翌日分、day=0 は当日分（日本時間 HH:MM）。
 * 前日の夕方に翌日分が出るが、正確な公開時刻は決まっていないため、夕方から夜に3回見に行く（未公開なら何もしない）。
 * 当日の朝にもう1回取って、差し替えがないか確かめる。ファイルが前回と同じなら取り込みは何もしないので、回数を増やしても負荷は小さい
 */
export const CARD_SLOTS = [
  { at: '18:00', day: 1 },
  { at: '19:30', day: 1 },
  { at: '22:00', day: 1 },
  { at: '07:00', day: 0 },
] as const;
/**
 * 競走成績（公式テキストデータ K）を取る時刻。day=0 は当日分、day=-1 は前日分（日本時間 HH:MM）。
 * 実測（2026-11）では、その日の分が 20:50 ごろに出て、22:55 ごろに更新されることがある。夜に2回見て、翌朝に取り残しがないか確かめる。
 * ファイルが前回と同じなら取り込みは何もしないので、回数を増やしても負荷は小さい
 */
export const RECORD_SLOTS = [
  { at: '21:30', day: 0 },
  { at: '23:20', day: 0 },
  { at: '06:30', day: -1 },
] as const;
// 過去分（B と K から過去のレースを作る）の毎晩の起動は 2026-11-07 にやめた（管理者決定。過去データと統計はもち側が持つ）。
// 取り込み済みの分は jobs/purge.ts が消す。スクリプトの history は手動の起動だけで使える
/** 出走表の起動は、その時刻からこの時間内だけ行う（デプロイ直後などに夜になってから起動しないように） */
export const SLOT_WINDOW_MS = 2 * 60 * 60 * 1000;
/** 結果の取得の最短間隔 */
export const RESULTS_INTERVAL_MS = 10 * 60 * 1000;

/** 前日の全レースの結果をまとめて取る時刻（日本時間） */
export const RESULTS_ALL_SLOT = '06:00';

/** 舟券のないレースの結果は、締切からこの時間がたってから取りに行く（レースが終わって結果が出るまでの目安） */
export const RESULT_WAIT_MS = 5 * 60 * 1000;
/** 舟券のないレースは、締切からこの時間を過ぎたら当日の取得をあきらめる（残りは翌朝 6:00 の全レースの取得で拾う） */
export const RESULT_GIVEUP_MS = 3 * 60 * 60 * 1000;

/** 結果を取りに行くレースを探す範囲（日数）。これより前の精算待ちは、結果が出ないまま残ったもので、取りに行っても無駄 */
export const RESULT_LOOKBACK_DAYS = 7;

/**
 * 結果を取りに行くレース（締切後で結果が未取得）。舟券のあるレース（locked、精算待ち）はすぐ、
 * それ以外は締切の RESULT_WAIT_MS 後から RESULT_GIVEUP_MS まで。bind には resultWantedArgs(nowMs) を渡す。
 * 定時処理が5分ごとに流すので、races・race_results の全体を読まないこと（過去分の取り込みで数万行あり、D1 の1日の読み取り上限を使い切る。
 * 2026-11-06 の停止）。日付の索引で直近だけを読み、結果の有無はレースごとに主キーで引く
 */
export const RESULT_WANTED_SQL =
  "race_date >= ? AND (status = 'locked' OR (deadline_ms <= ? AND deadline_ms > ? AND status != 'cancelled')) AND NOT EXISTS (SELECT 1 FROM race_results x WHERE x.race_id = races.id)";
export const resultWantedArgs = (nowMs: number) => [addDays(jstDate(nowMs), -RESULT_LOOKBACK_DAYS), nowMs - RESULT_WAIT_MS, nowMs - RESULT_GIVEUP_MS];

export interface Dispatch {
  /** 起動済みの記録に使うキー（app_state.key） */
  key: string;
  command: 'schedule' | 'cards' | 'records' | 'history' | 'results' | 'results-all';
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
  for (const slot of CARD_SLOTS) {
    const [h, m] = slot.at.split(':').map(Number) as [number, number];
    const at = jstToMs(today, h, m);
    const target = addDays(today, slot.day);
    const key = `fetch:cards:${target}:${slot.at}`;
    if (p.nowMs >= at && p.nowMs < at + SLOT_WINDOW_MS && !p.done.has(key)) out.push({ key, command: 'cards', date: target });
  }
  for (const slot of RECORD_SLOTS) {
    const [h, m] = slot.at.split(':').map(Number) as [number, number];
    const at = jstToMs(today, h, m);
    const target = addDays(today, slot.day);
    const key = `fetch:records:${target}:${slot.at}`;
    if (p.nowMs >= at && p.nowMs < at + SLOT_WINDOW_MS && !p.done.has(key)) out.push({ key, command: 'records', date: target });
  }
  {
    const [h, m] = RESULTS_ALL_SLOT.split(':').map(Number) as [number, number];
    const at = jstToMs(today, h, m);
    const key = `fetch:results-all:${today}`;
    if (p.nowMs >= at && p.nowMs < at + SLOT_WINDOW_MS && !p.done.has(key)) out.push({ key, command: 'results-all', date: addDays(today, -1) });
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
    // key LIKE 'fetch:%' は表の全体を読むので、主キーの範囲で引く（';' は ':' の次の文字）
    (await db.prepare("SELECT key, value FROM app_state WHERE key >= 'fetch:' AND key < 'fetch;'").all<{ key: string; value: string }>()).results.map((r) => [r.key, r.value]),
  );
  // 結果が必要なのは、締切後で結果が未取得のレース（舟券の有無を問わない。RESULT_WANTED_SQL）
  const pending = await db
    .prepare(`SELECT COUNT(*) AS n FROM races WHERE ${RESULT_WANTED_SQL}`)
    .bind(...resultWantedArgs(nowMs))
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
  // 古い出走表・番組表の起動記録を消す（3日より前）
  await db.prepare("DELETE FROM app_state WHERE key >= 'fetch:' AND key < 'fetch;' AND (key LIKE 'fetch:schedule:%' OR key LIKE 'fetch:cards:%' OR key LIKE 'fetch:records:%' OR key LIKE 'fetch:history:%' OR key LIKE 'fetch:results-all:%') AND updated_at < ?").bind(jstIso(nowMs - 3 * 24 * 60 * 60 * 1000)).run();
  return log;
}

/** 取得の起動が失敗し続けているか（滞留通知・設定確認に使う）。失敗していなければ null */
export async function fetchDispatchError(db: D1Database): Promise<{ message: string; since: string } | null> {
  const r = await db.prepare('SELECT value, updated_at FROM app_state WHERE key = ?').bind(ERROR_KEY).first<{ value: string; updated_at: string }>();
  return r ? { message: r.value, since: r.updated_at } : null;
}
