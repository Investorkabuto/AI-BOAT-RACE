// 管理者（ユーザー）向け。ADMIN_TOKEN で認証する（STOCK_GAME から移植）。docs/operator-api.md 4.2
import { Hono, type Context } from 'hono';
import type { Env } from '../env';
import { adminDecideAdjudication, adminDecideAppeal, auditStatement, formatAdjudication, reviewAgentStatements, type AdjudicationRow } from '../operator/core';
import { tick } from '../jobs/tick';
import { ensureSchema } from '../db/migrate';
import { newId, randomToken, sha256Hex } from '../lib/crypto';
import { ApiError, bearer, readJson, safeEqual } from '../lib/http';
import { jstIso } from '../lib/time';

export const adminApi = new Hono<{ Bindings: Env }>();

adminApi.use('*', async (c, next) => {
  const t = bearer(c);
  if (!c.env.ADMIN_TOKEN || !t || !safeEqual(t, c.env.ADMIN_TOKEN)) throw new ApiError(401, 'unauthorized', 'invalid admin token');
  await next();
});

const body = async (c: Context): Promise<Record<string, unknown>> => readJson(c).catch(() => ({}));

// ---- 登録審査（運営AIの不在時の手動審査） ----
adminApi.get('/agents', async (c) => {
  const status = c.req.query('status') ?? 'pending';
  const r = await c.env.DB.prepare("SELECT id, display_name, owner_name, profile, status, review_reason, cluster_ref, created_at, reviewed_at FROM agents WHERE realm = 'live' AND status = ? ORDER BY created_at").bind(status).all();
  return c.json({ agents: r.results });
});

const review = (decision: 'approve' | 'reject') => async (c: Context<{ Bindings: Env }>) => {
  const b = await body(c);
  const reason = typeof b.reason === 'string' ? b.reason.trim() : '';
  if (decision === 'reject' && !reason) throw new ApiError(400, 'bad_request', 'reason is required');
  const id = c.req.param('id')!;
  await c.env.DB.batch(await reviewAgentStatements(c.env.DB, id, decision, reason, 'admin', Date.now()));
  return c.json({ id, status: decision === 'approve' ? 'active' : 'rejected' });
};
adminApi.post('/agents/:id/approve', review('approve'));
adminApi.post('/agents/:id/reject', review('reject'));
adminApi.post('/registrations/:id/approve', review('approve'));
adminApi.post('/registrations/:id/reject', review('reject'));

// ---- 裁定 ----
adminApi.get('/adjudications', async (c) => {
  const status = c.req.query('status') ?? 'pending_review';
  const r = await c.env.DB.prepare('SELECT * FROM adjudications WHERE status = ? ORDER BY created_at').bind(status).all<AdjudicationRow>();
  return c.json({ adjudications: r.results.map(formatAdjudication) });
});
adminApi.post('/adjudications/:id/approve', async (c) => {
  const b = await body(c);
  return c.json(await adminDecideAdjudication(c.env.DB, c.req.param('id'), 'approve', { banFutureSeasons: b.ban_future_seasons === true, note: typeof b.note === 'string' ? b.note : undefined }, Date.now()));
});
adminApi.post('/adjudications/:id/reject', async (c) => {
  const b = await body(c);
  return c.json(await adminDecideAdjudication(c.env.DB, c.req.param('id'), 'reject', { downgradeToWarning: b.downgrade_to_warning === true, note: typeof b.note === 'string' ? b.note : undefined }, Date.now()));
});

// ---- 異議（失格の取消・格下げの承認） ----
adminApi.get('/appeals', async (c) => {
  const status = c.req.query('status') ?? 'pending_admin';
  const r = await c.env.DB.prepare('SELECT * FROM appeals WHERE status = ? ORDER BY created_at').bind(status).all();
  return c.json({ appeals: r.results });
});
adminApi.post('/appeals/:id/approve', async (c) => c.json(await adminDecideAppeal(c.env.DB, c.req.param('id'), 'approve', Date.now())));
adminApi.post('/appeals/:id/reject', async (c) => c.json(await adminDecideAppeal(c.env.DB, c.req.param('id'), 'reject', Date.now())));

// ---- 運営トークン（同時に有効なのは2本まで） ----
adminApi.get('/operator-tokens', async (c) => {
  const r = await c.env.DB.prepare('SELECT id, label, created_at, revoked_at, last_seen_at FROM operator_tokens ORDER BY created_at').all();
  return c.json({ tokens: r.results });
});
adminApi.post('/operator-tokens', async (c) => {
  const b = await body(c);
  const label = typeof b.label === 'string' && b.label.trim() ? b.label.trim().slice(0, 60) : 'mochi';
  const active = await c.env.DB.prepare('SELECT COUNT(*) AS n FROM operator_tokens WHERE revoked_at IS NULL').first<{ n: number }>();
  if ((active?.n ?? 0) >= 2) throw new ApiError(409, 'conflict', '有効な運営トークンはすでに2本あります。古いものを失効させてから発行してください');
  const now = Date.now();
  const id = newId('opt', now);
  const token = `opk_${randomToken(32)}`;
  await c.env.DB.batch([
    c.env.DB.prepare('INSERT INTO operator_tokens (id, token_hash, label, created_at) VALUES (?, ?, ?, ?)').bind(id, await sha256Hex(token), label, jstIso(now)),
    auditStatement(c.env.DB, 'admin', 'operator_token.create', id, { label }, now),
  ]);
  return c.json({ id, label, token, note: 'token はこの応答でしか表示されません。もちの Secure Vault に保管してください' }, 201);
});
adminApi.delete('/operator-tokens/:id', async (c) => {
  const now = Date.now();
  const r = await c.env.DB.prepare('UPDATE operator_tokens SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL').bind(jstIso(now), c.req.param('id')).run();
  if (r.meta.changes === 0) throw new ApiError(404, 'not_found', 'token not found or already revoked');
  await auditStatement(c.env.DB, 'admin', 'operator_token.revoke', c.req.param('id'), undefined, now).run();
  return c.json({ id: c.req.param('id'), revoked: true });
});

// ---- 記事の取り下げ（日報の自動公開で問題があったとき） ----
adminApi.post('/reports/:id/withdraw', async (c) => {
  const b = await body(c);
  const note = typeof b.note === 'string' ? b.note.trim() : '';
  const now = Date.now();
  const r = await c.env.DB.prepare("UPDATE reports SET status = 'withdrawn', withdrawn_at = ?, withdraw_note = ? WHERE id = ? AND status = 'published'").bind(jstIso(now), note || null, c.req.param('id')).run();
  if (r.meta.changes === 0) throw new ApiError(404, 'not_found', 'report not found or already withdrawn');
  await auditStatement(c.env.DB, 'admin', 'report.withdraw', c.req.param('id'), { note }, now).run();
  return c.json({ id: c.req.param('id'), status: 'withdrawn' });
});

// ---- 運営タスクの一覧（滞留の確認用） ----
adminApi.get('/operator-tasks', async (c) => {
  const status = c.req.query('status') ?? 'pending';
  const r = await c.env.DB.prepare('SELECT id, type, status, subject_id, due_at, created_at, attempts, last_error FROM operator_tasks WHERE status = ? ORDER BY due_at').bind(status).all();
  return c.json({ tasks: r.results });
});

/** スキーマを今すぐ最新にする（通常は定時処理と最初のリクエストで自動実行される） */
adminApi.post('/migrate', async (c) => c.json({ applied: await ensureSchema(c.env.DB) }));

/** 状態機械を今すぐ1回進める（動作確認・復旧用）。ALLOW_TIME_TRAVEL=1 のときだけ ?now= で時刻を指定できる */
adminApi.post('/tick', async (c) => {
  const at = c.req.query('now');
  let now = Date.now();
  if (at) {
    if (c.env.ALLOW_TIME_TRAVEL !== '1') throw new ApiError(400, 'bad_request', 'now is only allowed when ALLOW_TIME_TRAVEL=1');
    now = Date.parse(at);
    if (Number.isNaN(now)) throw new ApiError(400, 'bad_request', 'invalid now');
  }
  return c.json({ now: jstIso(now), log: await tick(c.env, now) });
});
