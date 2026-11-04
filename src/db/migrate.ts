// 本番 D1 のスキーマを、アプリ自身が最新に揃える（定時処理と、各インスタンスの最初のリクエストで実行）。
// migrations/*.sql はどの文も「すでにあれば何もしない」形なので、何度流しても安全。
// 新しいマイグレーションを足すときは、migrations/ にファイルを置き、下の MIGRATIONS に import を追加する
import init from '../../migrations/0001_init.sql';
import operator from '../../migrations/0002_operator.sql';
import entries from '../../migrations/0003_entries.sql';

const MIGRATIONS: { name: string; sql: string }[] = [
  { name: '0001_init', sql: init },
  { name: '0002_operator', sql: operator },
  { name: '0003_entries', sql: entries },
];

/** SQL ファイルを文に分ける（行末コメントを除いてから、行末の ; で区切る） */
export function splitSql(sql: string): string[] {
  return sql
    .split('\n')
    .map((l) => l.replace(/--.*$/, '').trimEnd())
    .join('\n')
    .split(/;\s*(?:\n|$)/)
    .map((s) => s.trim())
    .filter(Boolean);
}

export async function ensureSchema(db: D1Database): Promise<string[]> {
  await db.prepare('CREATE TABLE IF NOT EXISTS schema_migrations (name TEXT PRIMARY KEY, applied_at TEXT NOT NULL)').run();
  const done = new Set((await db.prepare('SELECT name FROM schema_migrations').all<{ name: string }>()).results.map((r) => r.name));
  const applied: string[] = [];
  for (const m of MIGRATIONS) {
    if (done.has(m.name)) continue;
    await db.batch([
      ...splitSql(m.sql).map((s) => db.prepare(s)),
      db.prepare('INSERT OR IGNORE INTO schema_migrations (name, applied_at) VALUES (?, ?)').bind(m.name, new Date().toISOString()),
    ]);
    applied.push(m.name);
  }
  return applied;
}
