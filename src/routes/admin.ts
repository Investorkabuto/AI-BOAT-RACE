// 管理者API（ユーザー用）。運営API（もちの接続）ができるまでは、登録審査もここで行う
import { Hono } from 'hono';
import type { Env } from '../env';
import { auditStatement, eventStatement } from '../db/repo';
import { ApiError, bearer, readJson, safeEqual } from '../lib/http';
import { jstIso } from '../lib/time';
import { tick } from '../jobs/tick';

export const adminApi = new Hono<{ Bindings: Env }>();

adminApi.use('*', async (c, next) => {
  const t = bearer(c);
  if (!c.env.ADMIN_TOKEN || !t || !safeEqual(t, c.env.ADMIN_TOKEN)) throw new ApiError(401, 'unauthorized', 'invalid admin token');
  await next();
});

adminApi.get('/agents', async (c) => {
  const status = c.req.query('status');
  const r = await c.env.DB.prepare(
    `SELECT id, display_name, owner_name, profile, status, review_reason, cluster_ref, created_at, reviewed_at FROM agents WHERE realm = 'live'${status ? ' AND status = ?' : ''} ORDER BY created_at`,
  ).bind(...(status ? [status] : [])).all();
  return c.json({ agents: r.results });
});

for (const decision of ['approve', 'reject'] as const) {
  adminApi.post(`/agents/:id/${decision}`, async (c) => {
    const id = c.req.param('id');
    const b = await readJson(c).catch(() => ({}) as Record<string, unknown>);
    const reason = typeof b.reason === 'string' ? b.reason : '';
    const now = Date.now();
    const a = await c.env.DB.prepare("SELECT status FROM agents WHERE id = ? AND realm = 'live'").bind(id).first<{ status: string }>();
    if (!a) throw new ApiError(404, 'not_found', 'agent not found');
    if (a.status !== 'pending') throw new ApiError(409, 'conflict', `agent is already ${a.status}`);
    await c.env.DB.batch([
      c.env.DB.prepare('UPDATE agents SET status = ?, review_reason = ?, reviewed_at = ? WHERE id = ?').bind(decision === 'approve' ? 'active' : 'rejected', reason || null, jstIso(now), id),
      eventStatement(c.env.DB, id, 'agent.reviewed', { decision, reason }, now),
      auditStatement(c.env.DB, 'admin', `registration.${decision}`, id, { reason }, now),
    ]);
    return c.json({ id, status: decision === 'approve' ? 'active' : 'rejected' });
  });
}

/** 状態機械を今すぐ1回進める。ALLOW_TIME_TRAVEL=1 のときだけ ?now= で時刻を指定できる */
adminApi.post('/tick', async (c) => {
  const q = c.req.query('now');
  const now = c.env.ALLOW_TIME_TRAVEL === '1' && q ? Date.parse(q) : Date.now();
  if (!Number.isFinite(now)) throw new ApiError(400, 'bad_request', 'now must be ISO 8601');
  return c.json({ now: jstIso(now), log: await tick(c.env, now) });
});
