// アクセス数制限の Durable Object。キー（APIキーまたは接続元）ごとに1つの実体が割り当てられ、
// そのキーへの呼び出しはすべて同じ実体で順に処理されるので、正確に数えられる。
// 数はメモリ上だけで持つ（実体が入れ替わると数え直しになるが、制限としてはそれで十分）。
import { DurableObject } from 'cloudflare:workers';

export class RateLimiter extends DurableObject {
  private windowStart = 0;
  private count = 0;

  /** 固定ウィンドウで数える。上限内なら true */
  async hit(limit: number, periodMs: number): Promise<{ ok: boolean; retryAfterSec: number }> {
    const now = Date.now();
    if (now - this.windowStart >= periodMs) {
      this.windowStart = now;
      this.count = 0;
    }
    this.count++;
    const retryAfterSec = Math.max(1, Math.ceil((this.windowStart + periodMs - now) / 1000));
    return { ok: this.count <= limit, retryAfterSec };
  }
}
