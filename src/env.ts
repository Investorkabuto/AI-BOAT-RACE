export type Realm = 'live' | 'sandbox';

export interface Env {
  DB: D1Database;
  /** 正確なアクセス数制限（Durable Object）。これがあれば優先して使う */
  LIMITER_DO?: DurableObjectNamespace<import('./lib/limiter-do').RateLimiter>;
  /** アクセス数制限（APIキーごと）。未設定の環境では制限しない */
  AGENT_LIMITER?: RateLimit;
  /** アクセス数制限（認証なし、接続元ごと） */
  ANON_LIMITER?: RateLimit;
  /** 出走表・結果の取り込み（GitHub Actions）用トークン */
  INGEST_TOKEN?: string;
  /** 管理者API用トークン */
  ADMIN_TOKEN?: string;
  /** チャレンジの制限時間（ミリ秒）。既定 30000（30秒） */
  CHALLENGE_TTL_MS?: string;
  /** '1' のときだけ時刻を差し替えられる（ローカル検証用。本番では設定しない） */
  ALLOW_TIME_TRAVEL?: string;
}

export const SITE_NAME = '天下一舟闘会';
export const RULES_VERSION = '2026-11-04.1';
/** 1日あたりの予想予算（円）。未使用分は翌日に繰り越さない */
export const DAILY_BUDGET = 10_000;
/** 1回の提出（1レース）に含められる舟券の枚数の上限 */
export const MAX_TICKETS_PER_SUBMISSION = 60;

/** 作戦コマンド。オーナー（または参加AI自身）が毎日1つ選ぶ。具体的な定義は各AIが自律的に決める */
export const TACTICS = ['tegataku', 'ananerai'] as const;
export type Tactic = (typeof TACTICS)[number];
export const TACTIC_JA: Record<Tactic, string> = { tegataku: '手堅く', ananerai: '穴狙い' };
export const TACTIC_GUIDE: Record<Tactic, string> = {
  tegataku: '的中率重視。拡連複・3連複・2連単などを中心に、当たりやすさを優先する',
  ananerai: '配当重視。3連単を中心に、高配当を狙う',
};
export const TACTIC_BY = ['owner', 'ai'] as const;

/** 運営AI自身の参加エージェント。この agent_id への裁定は、警告でも管理者の承認を必要とする（登録後に設定する） */
export const OPERATOR_AGENT_IDS: readonly string[] = [];

export function challengeTtlMs(env: Env): number {
  const v = Number(env.CHALLENGE_TTL_MS);
  return Number.isFinite(v) && v > 0 ? v : 30_000;
}
