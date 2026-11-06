// src のすべての SQL（prepare('…')）が、大きくなる表を全部読まないこと（EXPLAIN QUERY PLAN）。
// 2026-11-06 の全体点検で、舟券の提出（bets を submission_id で引く）や運営AIの API の毎分の上限（audit_log）が、
// 毎回その表の全体を読んでいたのが見つかった。D1 は読んだ行数で課金されるので、索引で範囲を絞る
import { describe, expect, it } from 'vitest';
import { memoryD1 } from './helpers/d1';
import { ensureSchema } from '../src/db/migrate';

/** 行数が増え続ける表 */
const BIG = ['races', 'race_results', 'race_starts', 'race_entrants', 'race_boats', 'race_payouts', 'race_cards', 'race_records', 'race_card_history', 'race_record_history',
  'bets', 'submissions', 'entries', 'entry_plans', 'fines', 'events', 'app_state', 'audit_log', 'chat_messages', 'chat_likes', 'daily_tactics', 'operator_tasks', 'balance_days'];

/** 条件を組み立てて渡す SQL（WHERE ${...}）。ここでは中身が分からないので対象外（呼び出し側で索引のある列を使っている） */
const DYNAMIC = /WHERE \?|FROM \(\?\)/;

/** src の .ts の中身（vite の import.meta.glob で読む） */
const SOURCES = (import.meta as unknown as { glob: (p: string, o: object) => Record<string, string> }).glob('../src/**/*.ts', { query: '?raw', import: 'default', eager: true });

describe('SQL の読み方', () => {
  it('大きくなる表を全部読む SQL がない', async () => {
    const db = memoryD1();
    await ensureSchema(db);
    const bad: string[] = [];
    let checked = 0;
    for (const [file, src] of Object.entries(SOURCES)) {
      for (const m of src.matchAll(/prepare\(\s*(['"`])([\s\S]*?)\1/g)) {
        const sql = m[2]!.replace(/\$\{[^}]*\}/g, '?');
        if (!/^\s*(SELECT|UPDATE|DELETE|INSERT|WITH)/i.test(sql) || DYNAMIC.test(sql)) continue;
        let plan: { detail: string }[];
        try {
          plan = db.raw.prepare(`EXPLAIN QUERY PLAN ${sql}`).all() as { detail: string }[];
        } catch {
          continue; // 組み立て途中の断片など
        }
        checked++;
        const scans = plan.map((p) => /^SCAN (\w+)/.exec(p.detail)?.[1]).filter((t): t is string => !!t && BIG.includes(t));
        if (scans.length) bad.push(`${file}:${src.slice(0, m.index).split('\n').length} [${[...new Set(scans)]}] ${sql.replace(/\s+/g, ' ').slice(0, 120)}`);
      }
    }
    expect(checked).toBeGreaterThan(200);
    expect(bad).toEqual([]);
  });
});
