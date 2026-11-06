// 定時処理（5分ごと、1日288回）のクエリが、大きくなる表を全部読まないこと。
// 2026-11-06: 過去分の取り込みで races・race_results が数万行になり、日次の締めと結果の取得の要否のクエリが
// 毎回その全体を読んで、D1 の1日の読み取り上限（500万行）を使い切ってアプリ全体が止まった。その再発防止
import { describe, expect, it, vi } from 'vitest';
import { memoryD1 } from './helpers/d1';
import { ensureSchema } from '../src/db/migrate';
import { tick } from '../src/jobs/tick';
import type { Env } from '../src/env';

/** 行数が増え続ける表（定時処理で全体を読んではいけない） */
const BIG = ['races', 'race_results', 'race_starts', 'race_entrants', 'race_boats', 'race_payouts', 'race_cards', 'race_records', 'race_card_history', 'race_record_history',
  'bets', 'submissions', 'entries', 'entry_plans', 'fines', 'events', 'app_state', 'audit_log', 'chat_messages', 'daily_tactics'];

/** SQL を記録する D1 */
function recording() {
  const db = memoryD1();
  const seen = new Set<string>();
  const prepare = db.prepare.bind(db);
  (db as { prepare: (sql: string) => unknown }).prepare = (sql: string) => {
    seen.add(sql);
    return prepare(sql);
  };
  return { db, seen };
}

/** その SQL が大きな表を全部読む（SCAN）なら、表の名前を返す */
function fullScans(db: ReturnType<typeof memoryD1>, sql: string): string[] {
  let plan: { detail: string }[];
  try {
    plan = db.raw.prepare(`EXPLAIN QUERY PLAN ${sql}`).all() as { detail: string }[];
  } catch {
    return []; // DDL など
  }
  return plan.map((p) => /^SCAN (\w+)/.exec(p.detail)?.[1]).filter((t): t is string => !!t && BIG.includes(t));
}

describe('定時処理のクエリ', () => {
  it('大きくなる表を全部読まない（索引で範囲を絞る）', async () => {
    const { db, seen } = recording();
    await ensureSchema(db);
    // 過去分（締めた日）と、当日の締切前・締切後・精算待ちのレース
    const now = Date.parse('2026-11-06T12:00:00+09:00');
    db.raw.exec(`
      INSERT INTO races (id, race_date, jcd, rno, deadline_at, deadline_ms, status, updated_at) VALUES
        ('20251106-01-01', '2025-11-06', '01', 1, 'x', ${now - 365 * 86400e3}, 'settled', 'x'),
        ('20261106-01-01', '2026-11-06', '01', 1, 'x', ${now - 3600e3}, 'locked', 'x'),
        ('20261106-01-02', '2026-11-06', '01', 2, 'x', ${now - 600e3}, 'scheduled', 'x'),
        ('20261106-01-03', '2026-11-06', '01', 3, 'x', ${now + 3600e3}, 'scheduled', 'x');
      INSERT INTO day_closings (race_date, closed_at) VALUES ('2025-11-06', 'x');`);
    vi.spyOn(globalThis, 'fetch').mockImplementation(async () => new Response(null, { status: 204 }));
    await tick({ DB: db, GITHUB_TOKEN: 't', GITHUB_REPO: 'o/r' } as unknown as Env, now);
    vi.restoreAllMocks();

    const bad = [...seen].map((sql) => ({ sql: sql.replace(/\s+/g, ' ').slice(0, 160), scans: fullScans(db, sql) })).filter((x) => x.scans.length);
    expect(seen.size).toBeGreaterThan(20); // 定時処理のクエリを一通り流している
    expect(bad).toEqual([]);
  });
});
