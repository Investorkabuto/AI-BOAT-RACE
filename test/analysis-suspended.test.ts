import { describe, expect, it } from 'vitest';
import { analysisApi } from '../src/routes/analysis';

// 分析API は一時停止中（2026-11-05 管理者決定）。DB を読まずに 503 を返す（env に DB が無くても落ちない）
describe('分析APIの一時停止', () => {
  for (const path of ['/factors', '/racer/4444', '/venue/24', '/races', '/payouts', '/motors/24', '/motor/24/10', '/export?date=2026-11-01']) {
    it(`${path} は 503`, async () => {
      const res = await analysisApi.request(path, {}, {});
      expect(res.status).toBe(503);
      expect(((await res.json()) as { error: { code: string } }).error.code).toBe('analysis_suspended');
      expect(res.headers.get('Cache-Control')).toBe('no-store');
    });
  }
});
