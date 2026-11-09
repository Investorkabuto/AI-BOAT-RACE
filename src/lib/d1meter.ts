// D1 の読み書きの行数の計測（2026-11-09 管理者決定。無料プラン（読み取り1日500万行）に戻せるかの判断材料）。
// 各クエリの応答の meta.rows_read・rows_written を、経路（API のパターン・定時処理の段階）ごとに数え、
// インスタンスの中で1時間ごとに貯めて、1分に1回 d1_usage にまとめて書く（1リクエストごとに書くと、書き込みの上限を使うため）。
// インスタンスが消えると、まだ書いていない分（最大1分ほど）は失われる。数字は目安として扱う
import { jstIso } from './time';

export interface Tally {
  q: number; // クエリ数
  r: number; // 読み取り行数
  w: number; // 書き込み行数
}

/** 1回のリクエスト（または定時処理）の計測。label を切り替えると、以後のクエリはその経路に数える */
export class Meter {
  label: string;
  readonly by = new Map<string, Tally>();
  constructor(label = 'other') {
    this.label = label;
  }
  add(meta: unknown) {
    const m = (meta ?? {}) as { rows_read?: number; rows_written?: number };
    const t = this.by.get(this.label) ?? { q: 0, r: 0, w: 0 };
    t.q += 1;
    t.r += m.rows_read ?? 0;
    t.w += m.rows_written ?? 0;
    this.by.set(this.label, t);
  }
  /** リクエストは経路が最後に分かるので、数えた分をすべて1つの経路にまとめる */
  relabel(label: string) {
    const t: Tally = { q: 0, r: 0, w: 0 };
    for (const x of this.by.values()) (t.q += x.q), (t.r += x.r), (t.w += x.w);
    this.by.clear();
    if (t.q) this.by.set(label, t);
    this.label = label;
  }
}

const ORIGINAL = Symbol('d1meter.original');
type Wrapped = D1PreparedStatement & { [ORIGINAL]: D1PreparedStatement };

function wrapStatement(stmt: D1PreparedStatement, meter: Meter): D1PreparedStatement {
  const w = {
    [ORIGINAL]: stmt,
    bind: (...values: unknown[]) => wrapStatement(stmt.bind(...values), meter),
    async run() {
      const r = await stmt.run();
      meter.add(r.meta);
      return r;
    },
    async all() {
      const r = await stmt.all();
      meter.add(r.meta);
      return r;
    },
    // first() は meta を返さないので all() で読む（結果は first() と同じ）
    async first(col?: string) {
      const r = await stmt.all<Record<string, unknown>>();
      meter.add(r.meta);
      const row = r.results[0] ?? null;
      return col === undefined ? row : row ? (row[col] ?? null) : null;
    },
    raw: (opts?: { columnNames?: boolean }) => stmt.raw(opts as never),
  };
  return w as unknown as D1PreparedStatement;
}

/** 計測つきの D1。prepare・batch の行数を meter に数える。ほかの操作はそのまま通す */
export function meterD1(db: D1Database, meter: Meter): D1Database {
  return new Proxy(db, {
    get(target, prop, receiver) {
      if (prop === 'prepare') return (sql: string) => wrapStatement(target.prepare(sql), meter);
      if (prop === 'batch')
        return async (stmts: D1PreparedStatement[]) => {
          const res = await target.batch(stmts.map((s) => (s as Wrapped)[ORIGINAL] ?? s));
          for (const r of res) meter.add(r.meta);
          return res;
        };
      const v = Reflect.get(target, prop, receiver);
      return typeof v === 'function' ? v.bind(target) : v;
    },
  });
}

// ---------- インスタンスの中の貯め置きと書き出し ----------

const FLUSH_EVERY_MS = 60_000;
const buffer = new Map<string, Tally & { n: number }>();
let lastFlush = Date.now();

/** 1時間の区切り（日本時間 "YYYY-MM-DDTHH"） */
export const hourOf = (nowMs: number) => jstIso(nowMs).slice(0, 13);

/** 1回分の計測を貯める（n は回数。リクエストなら1、定時処理なら段階ごとに1） */
export function record(meter: Meter, nowMs: number) {
  const hour = hourOf(nowMs);
  for (const [label, t] of meter.by) {
    const key = `${hour}|${label}`;
    const b = buffer.get(key) ?? { n: 0, q: 0, r: 0, w: 0 };
    b.n += 1;
    b.q += t.q;
    b.r += t.r;
    b.w += t.w;
    buffer.set(key, b);
  }
}

/** 前回から1分以上たっていれば（force なら必ず）、貯めた分を d1_usage に足し込む。書けなければ捨てる（計測で本処理を止めない） */
export async function flushUsage(db: D1Database, nowMs: number, force = false): Promise<void> {
  if (!buffer.size || (!force && nowMs - lastFlush < FLUSH_EVERY_MS)) return;
  lastFlush = nowMs;
  const rows = [...buffer];
  buffer.clear();
  try {
    await db.batch(
      rows.map(([key, b]) => {
        const [hour, label] = key.split('|') as [string, string];
        return db
          .prepare(
            `INSERT INTO d1_usage (hour, label, n, queries, rows_read, rows_written) VALUES (?, ?, ?, ?, ?, ?)
             ON CONFLICT (hour, label) DO UPDATE SET n = n + excluded.n, queries = queries + excluded.queries,
               rows_read = rows_read + excluded.rows_read, rows_written = rows_written + excluded.rows_written`,
          )
          .bind(hour, label, b.n, b.q, b.r, b.w);
      }),
    );
  } catch (e) {
    console.error('d1 usage flush failed', e);
  }
}

/** テスト用: 貯め置きを空にする */
export function resetUsageBuffer() {
  buffer.clear();
  lastFlush = 0;
}

// ---------- 読み出し（管理者API GET /admin/d1-usage・運営API GET /operator/v1/d1-usage） ----------
/** その日（日本時間）の経路ごとの合計と、1時間ごとの合計。管理者APIと運営APIで同じものを返す */
export async function d1UsageReport(db: D1Database, date: string) {
  const [byLabel, byHour] = await db.batch([
    db
      .prepare(
        `SELECT label, SUM(n) AS n, SUM(queries) AS queries, SUM(rows_read) AS rows_read, SUM(rows_written) AS rows_written
         FROM d1_usage WHERE hour BETWEEN ? AND ? GROUP BY label ORDER BY rows_read DESC`,
      )
      .bind(`${date}T00`, `${date}T23`),
    db
      .prepare('SELECT hour, SUM(n) AS n, SUM(rows_read) AS rows_read, SUM(rows_written) AS rows_written FROM d1_usage WHERE hour BETWEEN ? AND ? GROUP BY hour ORDER BY hour')
      .bind(`${date}T00`, `${date}T23`),
  ]);
  const labels = byLabel!.results as { label: string; n: number; queries: number; rows_read: number; rows_written: number }[];
  const total = labels.reduce((s, x) => s + x.rows_read, 0);
  return {
    date,
    total_rows_read: total,
    total_rows_written: labels.reduce((s, x) => s + x.rows_written, 0),
    by_label: labels.map((x) => ({ ...x, share_pct: total ? Math.round((x.rows_read / total) * 1000) / 10 : 0, rows_read_per_call: x.n ? Math.round(x.rows_read / x.n) : 0 })),
    by_hour: byHour!.results,
    note: '経路は API のルートのパターン（"GET /races/:race_id" など）と定時処理の段階（"tick:settle" など）。n はリクエスト数（定時処理は段階の実行回数）。各インスタンスが1分ごとにまとめて書くので、インスタンスが消えた分（最大1分ほど）は数えられないことがある。計測の書き込み自体も "d1_usage" には数えない。Cloudflare のメトリクスとは一致しない目安として扱う',
  };
}

