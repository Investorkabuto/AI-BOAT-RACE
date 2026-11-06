// テスト用の D1 の代わり（node:sqlite のメモリ上のデータベース）。SQL を本物の SQLite で流して確かめるために使う。
// prepare / bind / all / first / run / batch だけ。meta.rows_written は変わった行数（本物は索引の分も数える）
import { DatabaseSync } from 'node:sqlite';

type Arg = null | number | bigint | string | Uint8Array;

class Stmt {
  constructor(
    private readonly db: DatabaseSync,
    readonly sql: string,
    private readonly args: Arg[] = [],
  ) {}
  bind(...args: unknown[]): Stmt {
    return new Stmt(this.db, this.sql, args.map((a) => (a === undefined ? null : typeof a === 'boolean' ? Number(a) : (a as Arg))));
  }
  exec(): D1Result {
    const s = this.db.prepare(this.sql);
    if (/^\s*(SELECT|WITH|PRAGMA)\b/i.test(this.sql)) {
      const results = s.all(...this.args) as Record<string, unknown>[];
      return { success: true, results, meta: { rows_read: results.length, rows_written: 0, changes: 0 } } as unknown as D1Result;
    }
    const r = s.run(...this.args);
    const n = Number(r.changes);
    return { success: true, results: [], meta: { rows_read: 0, rows_written: n, changes: n } } as unknown as D1Result;
  }
  async all<T>() {
    return this.exec() as D1Result<T>;
  }
  async run() {
    return this.exec();
  }
  async first<T>(col?: string): Promise<T | null> {
    const row = (this.exec().results[0] as Record<string, unknown> | undefined) ?? null;
    return (row && col ? row[col] : row) as T | null;
  }
}

export function memoryD1(): D1Database & { raw: DatabaseSync } {
  const raw = new DatabaseSync(':memory:');
  const db = {
    raw,
    prepare: (sql: string) => new Stmt(raw, sql),
    async batch(stmts: Stmt[]) {
      raw.exec('BEGIN');
      try {
        const out = stmts.map((s) => s.exec());
        raw.exec('COMMIT');
        return out;
      } catch (e) {
        raw.exec('ROLLBACK');
        throw e;
      }
    },
    async exec(sql: string) {
      raw.exec(sql);
      return { count: 0, duration: 0 };
    },
  };
  return db as unknown as D1Database & { raw: DatabaseSync };
}
