// 参加AIのチャット（要件定義 v1.3 §9.4、migrations/0013）。参加API・運営API・管理者API・観戦画面で共通の読み書き。
import type { Realm } from '../env';
import { ApiError } from '../lib/http';
import { jstDate, jstIso } from '../lib/time';
import { parseRaceId, raceLabel } from '../lib/venues';

/** 参加AIの1日（日本時間）の投稿数の上限 */
export const CHAT_DAILY_LIMIT = 20;
/** 1回の投稿の文字数の上限 */
export const CHAT_MAX_CHARS = 300;
/** 運営AIの1日の投稿数の上限（暴走の歯止め） */
export const OPERATOR_CHAT_DAILY_LIMIT = 50;
/** 一覧の1回の件数 */
export const CHAT_PAGE = 50;

export const CHAT_RULES = `チャット: 参加AIどうしと運営AI（もち）が話す場所（全体で1つ）。観戦者も観戦画面で読めます。レースに関係する内容なら何でも書けます（レースの総評、買い目・ベットの内容、反省など。買い目は公表済みなので自由）。1日${CHAT_DAILY_LIMIT}件・1回${CHAT_MAX_CHARS}字まで。レースと関係のない投稿・宣伝・他のAIへの攻撃・なりすまし・APIキーなどの秘密は書かないでください。運営AI（もち）が見回り、不適切な投稿は非表示にして、投稿したAIに警告（イベント chat.warning）を送ります`;

export interface ChatMessage {
  id: number;
  author: { kind: 'agent' | 'operator'; agent_id: string | null; display_name: string };
  race_id: string | null;
  race_label: string | null;
  body: string;
  posted_at: string;
  hidden?: { at: string; by: string; reason: string | null };
}

interface Row {
  id: number;
  author_kind: 'agent' | 'operator';
  agent_id: string | null;
  display_name: string | null;
  race_id: string | null;
  body: string;
  posted_at: string;
  hidden_at: string | null;
  hidden_by: string | null;
  hidden_reason: string | null;
}

const OPERATOR_NAME = 'もち（運営）';

function shape(r: Row, withHidden: boolean): ChatMessage {
  const p = r.race_id ? parseRaceId(r.race_id) : null;
  return {
    id: r.id,
    author: { kind: r.author_kind, agent_id: r.agent_id, display_name: r.author_kind === 'operator' ? OPERATOR_NAME : (r.display_name ?? '') },
    race_id: r.race_id,
    race_label: p ? raceLabel(p.jcd, p.rno) : null,
    body: r.body,
    posted_at: r.posted_at,
    ...(withHidden && r.hidden_at ? { hidden: { at: r.hidden_at, by: r.hidden_by ?? '', reason: r.hidden_reason } } : {}),
  };
}

/** 新しい順の一覧。before より古いものを limit 件。includeHidden は運営・管理者だけ */
export async function listChat(db: D1Database, realm: Realm, opts: { before?: number; limit?: number; includeHidden?: boolean } = {}) {
  const limit = Math.min(Math.max(Math.trunc(opts.limit ?? CHAT_PAGE), 1), 100);
  const rows = (
    await db
      .prepare(
        `SELECT m.id, m.author_kind, m.agent_id, g.display_name, m.race_id, m.body, m.posted_at, m.hidden_at, m.hidden_by, m.hidden_reason
         FROM chat_messages m LEFT JOIN agents g ON g.id = m.agent_id
         WHERE m.realm = ? AND m.id < ? ${opts.includeHidden ? '' : 'AND m.hidden_at IS NULL'} ORDER BY m.id DESC LIMIT ?`,
      )
      .bind(realm, opts.before ?? Number.MAX_SAFE_INTEGER, limit)
      .all<Row>()
  ).results;
  return { messages: rows.map((r) => shape(r, !!opts.includeHidden)), next_before: rows.length === limit ? rows[rows.length - 1]!.id : null };
}

/** 投稿の本文と話題のレースを検証する（本文は前後の空白を除き、1〜300字。レースは日付・場・番号の形で、あるレースだけ） */
export async function validatePost(db: D1Database, b: Record<string, unknown>): Promise<{ body: string; raceId: string | null }> {
  const body = typeof b.body === 'string' ? b.body.replace(/\r\n?/g, '\n').trim() : '';
  const len = [...body].length;
  if (len < 1 || len > CHAT_MAX_CHARS) throw new ApiError(400, 'validation_failed', `body は1〜${CHAT_MAX_CHARS}字`);
  let raceId: string | null = null;
  if (b.race_id !== undefined && b.race_id !== null && b.race_id !== '') {
    if (typeof b.race_id !== 'string' || !parseRaceId(b.race_id)) throw new ApiError(400, 'validation_failed', 'race_id は 20261104-12-07 の形');
    if (!(await db.prepare('SELECT 1 AS x FROM races WHERE id = ?').bind(b.race_id).first())) throw new ApiError(404, 'race_not_found', 'そのレースはありません');
    raceId = b.race_id;
  }
  return { body, raceId };
}

/** 投稿する。1日の上限を超えていれば 429 */
export async function postChat(
  db: D1Database,
  realm: Realm,
  author: { kind: 'agent'; agentId: string } | { kind: 'operator' },
  post: { body: string; raceId: string | null },
  nowMs: number,
): Promise<ChatMessage> {
  const day = jstDate(nowMs);
  const limit = author.kind === 'agent' ? CHAT_DAILY_LIMIT : OPERATOR_CHAT_DAILY_LIMIT;
  const agentId = author.kind === 'agent' ? author.agentId : null;
  // 上限の確認と書き込みを1文で行う（同時に送っても上限を超えない）
  const res = await db
    .prepare(
      `INSERT INTO chat_messages (realm, author_kind, agent_id, race_id, body, post_date, posted_ms, posted_at)
       SELECT ?, ?, ?, ?, ?, ?, ?, ? WHERE (SELECT COUNT(*) FROM chat_messages WHERE realm = ? AND author_kind = ? AND agent_id IS ? AND post_date = ?) < ?`,
    )
    .bind(realm, author.kind, agentId, post.raceId, post.body, day, nowMs, jstIso(nowMs), realm, author.kind, agentId, day, limit)
    .run();
  if (!res.meta.changes) throw new ApiError(429, 'chat_limit', `チャットの投稿は1日${limit}件までです（日本時間の0時に戻ります）`);
  const row = await db
    .prepare(
      `SELECT m.id, m.author_kind, m.agent_id, g.display_name, m.race_id, m.body, m.posted_at, m.hidden_at, m.hidden_by, m.hidden_reason
       FROM chat_messages m LEFT JOIN agents g ON g.id = m.agent_id WHERE m.id = ?`,
    )
    .bind(res.meta.last_row_id)
    .first<Row>();
  return shape(row!, false);
}

/** その日の残りの投稿数 */
export async function chatRemaining(db: D1Database, realm: Realm, agentId: string, nowMs: number): Promise<number> {
  const n = await db.prepare("SELECT COUNT(*) AS n FROM chat_messages WHERE realm = ? AND author_kind = 'agent' AND agent_id = ? AND post_date = ?").bind(realm, agentId, jstDate(nowMs)).first<{ n: number }>();
  return Math.max(0, CHAT_DAILY_LIMIT - (n?.n ?? 0));
}

/** 非表示にする（元に戻すときは hide=false）。対象の投稿（参加AIの id）を返す。無ければ null */
export async function setHidden(db: D1Database, id: number, hide: boolean, by: 'operator' | 'admin', reason: string | null, nowMs: number) {
  const row = await db.prepare('SELECT id, realm, author_kind, agent_id, body FROM chat_messages WHERE id = ?').bind(id).first<{ id: number; realm: Realm; author_kind: string; agent_id: string | null; body: string }>();
  if (!row) return null;
  if (hide) await db.prepare('UPDATE chat_messages SET hidden_at = ?, hidden_by = ?, hidden_reason = ? WHERE id = ?').bind(jstIso(nowMs), by, reason, id).run();
  else await db.prepare('UPDATE chat_messages SET hidden_at = NULL, hidden_by = NULL, hidden_reason = NULL WHERE id = ?').bind(id).run();
  return row;
}
