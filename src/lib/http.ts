import type { Context } from 'hono';
import type { ContentfulStatusCode } from 'hono/utils/http-status';

export class ApiError extends Error {
  constructor(
    public status: ContentfulStatusCode,
    public code: string,
    message: string,
    public details?: unknown,
  ) {
    super(message);
  }
}

export function errorResponse(c: Context, e: ApiError) {
  return c.json({ error: { code: e.code, message: e.message, ...(e.details === undefined ? {} : { details: e.details }) } }, e.status);
}

export async function readJson(c: Context): Promise<Record<string, unknown>> {
  try {
    const body = await c.req.json();
    if (body && typeof body === 'object' && !Array.isArray(body)) return body as Record<string, unknown>;
  } catch {
    // fallthrough
  }
  throw new ApiError(400, 'bad_request', 'リクエスト本文は JSON オブジェクトにしてください');
}

/** 定数時間比較（トークン照合用） */
export function safeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

export function bearer(c: Context): string | null {
  const h = c.req.header('Authorization') ?? '';
  const m = /^Bearer\s+(\S+)$/i.exec(h);
  return m ? m[1]! : null;
}

interface RateLimitContext {
  env: import('../env').Env;
  req: { header(name: string): string | undefined };
  header(name: string, value: string): void;
}

/**
 * アクセス数制限。確かめたAPIキー（opts.agentId）があればキーごと、なければ接続元ごとに数える。
 * Authorization ヘッダーの文字列そのものでは数えない（でたらめなキーを毎回変えて送ると、制限をすり抜けられてしまうため）。
 * Cloudflare の Rate Limiting は拠点ごとの概算なので、上限ちょうどで厳密に止まるわけではない。
 */
export async function enforceRateLimit(c: RateLimitContext, opts: { precise?: boolean; agentId?: string } = {}): Promise<void> {
  const token = /^Bearer\s+\S+$/i.test(c.req.header('Authorization') ?? '');
  const ip = `ip:${c.req.header('CF-Connecting-IP') ?? 'unknown'}`;
  // 公開情報の読み出し（precise: false）は、Durable Object への往復を省いて、拠点ごとの概算の制限で済ませる（観戦画面の表示を速くするため）。
  // キーを付けた読み出しは毎分120回の枠（接続元ごと）で数える
  const fast = opts.precise === false && (token ? c.env.AGENT_LIMITER : c.env.ANON_LIMITER);
  const perKey = !!opts.agentId || (!!fast && token);
  const limit = perKey ? 120 : 60;
  const key = opts.agentId ? `a:${opts.agentId}` : ip;
  let ok: boolean;
  let retryAfter = 60;
  if (c.env.LIMITER_DO && !fast) {
    // キーごとに Durable Object で正確に数える
    const stub = c.env.LIMITER_DO.get(c.env.LIMITER_DO.idFromName(key));
    const r = await stub.hit(limit, 60_000);
    ok = r.ok;
    retryAfter = r.retryAfterSec;
    c.header('X-RateLimit-Limit', `${limit};w=60`);
  } else {
    const limiter = token ? c.env.AGENT_LIMITER : c.env.ANON_LIMITER;
    if (!limiter) return;
    c.header('X-RateLimit-Limit', `${limit};w=60;approx`);
    ok = (await limiter.limit({ key })).success;
  }
  if (!ok) {
    c.header('Retry-After', String(retryAfter));
    throw new ApiError(429, 'rate_limited', perKey ?'APIキーごとの上限（毎分120回）を超えました。60秒ほど待ってください' : '接続元ごとの上限（認証なしで毎分60回）を超えました。60秒ほど待ってください');
  }
}

/**
 * 公開情報の読み出し用のミドルウェア: アクセス数制限（概算）と、短時間のキャッシュ。
 * 認証なしの GET の応答を、Cloudflare の拠点で ttl 秒だけ使い回す（同じページを多くの人が見ても DB を読むのは数秒に1回）。
 * キャッシュ（caches.default）が使えない環境（workers.dev、テスト）では制限だけ行う
 */
export function publicRead(ttl = 10) {
  return async (c: Context, next: () => Promise<void>): Promise<Response | void> => {
    await enforceRateLimit(c as unknown as RateLimitContext, { precise: false });
    const cache = (globalThis as { caches?: { default?: Cache } }).caches?.default;
    if (c.req.method !== 'GET' || c.req.header('Authorization') || !cache) {
      await next();
      return;
    }
    const key = new Request(c.req.url, { method: 'GET' });
    const hit = await cache.match(key);
    if (hit) return new Response(hit.body, hit);
    await next();
    if (c.res.status !== 200) return;
    c.res.headers.set('Cache-Control', `public, max-age=${ttl}`);
    try {
      c.executionCtx.waitUntil(cache.put(key, c.res.clone()));
    } catch {
      // executionCtx が無い環境ではキャッシュしない
    }
  };
}
