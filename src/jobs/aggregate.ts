// 分析の事前集計（要件定義 v1.3 §9.2、決定50）。定時処理（5分ごと）が、作り直しの必要な「表×月」を1つずつ作り直す。
// - 集計は SQL の中で行う（INSERT … SELECT … GROUP BY）。Worker 側では重い処理をしない
// - 作り直しの印: 競走成績・過去分を取り込んだ月に markAggDirty で付ける（agg_months.dirty_at）。初回は取り込み済みの全ての月に付ける
// - 新しい月から順に作る（直近1年の分を先にそろえる）
// - 書き込みを減らすため、値が変わった行だけ書き換え、その月に無くなった行は消す
// - 1日に使う読み書きの量は src/jobs/budget.ts の上限まで
import { addDays, monthRange } from '../lib/time';
import { dayIdRange } from '../db/boats';
import { addMeta, hasRoom, loadUsage, saveUsage, type Usage } from './budget';

export const AGG_KINDS = ['racer_course', 'motor', 'venue_course', 'payout'] as const;
export type AggKind = (typeof AGG_KINDS)[number];

/** 1つの表×月を作り直すときの読み書きの見込み（1か月分のレース×艇は約5万行） */
const EST_READS = 250_000;
const EST_WRITES = 25_000;

/** 出走した艇（欠場を除く）。着順か、F・L・S の記号がある */
const STARTED = "(place IS NOT NULL OR (place_mark IS NOT NULL AND place_mark NOT LIKE 'K%'))";

/** その月のレースの id の範囲（主キーの範囲で引く） */
const monthIds = (ym: string): [string, string] => {
  const { startsOn, endsOn } = monthRange(ym);
  return [dayIdRange(startsOn)[0], dayIdRange(endsOn)[1]];
};

/** 値が変わったときだけ書き換える upsert の後半 */
const upsert = (table: string, key: string[], cols: string[]) =>
  `ON CONFLICT (${key.join(', ')}) DO UPDATE SET ${cols.map((c) => `${c} = excluded.${c}`).join(', ')}
   WHERE (${cols.map((c) => `${table}.${c}`).join(', ')}) IS NOT (${cols.map((c) => `excluded.${c}`).join(', ')})`;

/** 表×月を作り直す文（作り直し → その月に無くなった行を消す） */
export function rebuildStatements(db: D1Database, kind: AggKind, ym: string): D1PreparedStatement[] {
  const [lo, hi] = monthIds(ym);
  switch (kind) {
    case 'racer_course': {
      const cols = ['n', 'w1', 'w2', 'w3', 'st_sum', 'st_n', 'f_n', 'f_st_sum', 'l_n'];
      // 平均ST の元: 着順のある艇と失格（S）の艇の ST。F は別に持つ（F を含めるかは §9.1 で確定する）。L・欠場は除く
      const normal = "CASE WHEN place_mark IS NULL OR place_mark LIKE 'S%' THEN st END";
      return [
        db.prepare(
          `INSERT INTO agg_racer_course (toban, ym, course, ${cols.join(', ')})
           SELECT toban, ?, course, COUNT(*), COUNT(CASE WHEN place = 1 THEN 1 END), COUNT(CASE WHEN place <= 2 THEN 1 END), COUNT(CASE WHEN place <= 3 THEN 1 END),
             TOTAL(${normal}), COUNT(${normal}), COUNT(CASE WHEN place_mark = 'F' THEN 1 END), TOTAL(CASE WHEN place_mark = 'F' THEN st END), COUNT(CASE WHEN place_mark LIKE 'L%' THEN 1 END)
           FROM race_boats WHERE race_id BETWEEN ? AND ? AND course IS NOT NULL AND ${STARTED}
           GROUP BY toban, course
           ${upsert('agg_racer_course', ['toban', 'ym', 'course'], cols)}`,
        ).bind(ym, lo, hi),
        db.prepare(
          `DELETE FROM agg_racer_course WHERE ym = ? AND (toban, course) NOT IN
             (SELECT toban, course FROM race_boats WHERE race_id BETWEEN ? AND ? AND course IS NOT NULL AND ${STARTED})`,
        ).bind(ym, lo, hi),
      ];
    }
    case 'motor': {
      const cols = ['n', 'w1', 'w2', 'w3', 'tenji_rank_sum', 'tenji_n'];
      // 実際に乗ったモーター（K の番号が B と違えば K）。展示順位はレース内の展示タイムの順位（同タイムは同順位）
      const boats = `SELECT jcd, IFNULL(k_motor_no, motor_no) AS m, place, place_mark,
          CASE WHEN tenji IS NOT NULL THEN RANK() OVER (PARTITION BY race_id ORDER BY tenji IS NULL, tenji) END AS rk
        FROM race_boats WHERE race_id BETWEEN ? AND ?`;
      return [
        db.prepare(
          `INSERT INTO agg_motor (jcd, motor_no, ym, ${cols.join(', ')})
           SELECT jcd, m, ?, COUNT(*), COUNT(CASE WHEN place = 1 THEN 1 END), COUNT(CASE WHEN place <= 2 THEN 1 END), COUNT(CASE WHEN place <= 3 THEN 1 END),
             IFNULL(SUM(rk), 0), COUNT(rk)
           FROM (${boats}) WHERE m IS NOT NULL AND ${STARTED}
           GROUP BY jcd, m
           ${upsert('agg_motor', ['jcd', 'motor_no', 'ym'], cols)}`,
        ).bind(ym, lo, hi),
        db.prepare(
          `DELETE FROM agg_motor WHERE ym = ? AND (jcd, motor_no) NOT IN
             (SELECT jcd, IFNULL(k_motor_no, motor_no) FROM race_boats WHERE race_id BETWEEN ? AND ? AND IFNULL(k_motor_no, motor_no) IS NOT NULL AND ${STARTED})`,
        ).bind(ym, lo, hi),
      ];
    }
    case 'venue_course': {
      const cols = ['n', 'w1', 'w2', 'w3'];
      return [
        db.prepare(
          `INSERT INTO agg_venue_course (jcd, ym, course, ${cols.join(', ')})
           SELECT jcd, ?, course, COUNT(*), COUNT(CASE WHEN place = 1 THEN 1 END), COUNT(CASE WHEN place <= 2 THEN 1 END), COUNT(CASE WHEN place <= 3 THEN 1 END)
           FROM race_boats WHERE race_id BETWEEN ? AND ? AND course IS NOT NULL AND ${STARTED}
           GROUP BY jcd, course
           ${upsert('agg_venue_course', ['jcd', 'ym', 'course'], cols)}`,
        ).bind(ym, lo, hi),
        db.prepare(
          `DELETE FROM agg_venue_course WHERE ym = ? AND (jcd, course) NOT IN
             (SELECT jcd, course FROM race_boats WHERE race_id BETWEEN ? AND ? AND course IS NOT NULL AND ${STARTED})`,
        ).bind(ym, lo, hi),
        // 決まり手: 1着の艇の進入コースで数える
        db.prepare(
          `INSERT INTO agg_venue_kimarite (jcd, ym, course, kimarite, n)
           SELECT b.jcd, ?, b.course, IFNULL(k.kimarite, ''), COUNT(*)
           FROM race_boats b JOIN race_records k ON k.race_id = b.race_id
           WHERE b.race_id BETWEEN ? AND ? AND b.place = 1 AND b.course IS NOT NULL
           GROUP BY b.jcd, b.course, IFNULL(k.kimarite, '')
           ${upsert('agg_venue_kimarite', ['jcd', 'ym', 'course', 'kimarite'], ['n'])}`,
        ).bind(ym, lo, hi),
        db.prepare(
          `DELETE FROM agg_venue_kimarite WHERE ym = ? AND (jcd, course, kimarite) NOT IN
             (SELECT b.jcd, b.course, IFNULL(k.kimarite, '') FROM race_boats b JOIN race_records k ON k.race_id = b.race_id
              WHERE b.race_id BETWEEN ? AND ? AND b.place = 1 AND b.course IS NOT NULL)`,
        ).bind(ym, lo, hi),
      ];
    }
    case 'payout': {
      const cols = ['n', 'payout_sum'];
      const band = `CASE WHEN payout < 200 THEN 100 WHEN payout < 500 THEN 200 WHEN payout < 1000 THEN 500 WHEN payout < 2000 THEN 1000
        WHEN payout < 5000 THEN 2000 WHEN payout < 10000 THEN 5000 WHEN payout < 50000 THEN 10000 ELSE 50000 END`;
      const pop = 'CASE WHEN pop IS NULL THEN 0 WHEN pop > 11 THEN 11 ELSE pop END';
      const src = `SELECT bet_type, ${band} AS band, ${pop} AS pop, payout FROM race_payouts WHERE race_id BETWEEN ? AND ? AND combo != '*'`;
      return [
        db.prepare(
          `INSERT INTO agg_payout (bet_type, ym, band, pop, ${cols.join(', ')})
           SELECT bet_type, ?, band, pop, COUNT(*), SUM(payout) FROM (${src}) WHERE true
           GROUP BY bet_type, band, pop
           ${upsert('agg_payout', ['bet_type', 'ym', 'band', 'pop'], cols)}`,
        ).bind(ym, lo, hi),
        db.prepare(`DELETE FROM agg_payout WHERE ym = ? AND (bet_type, band, pop) NOT IN (SELECT bet_type, band, pop FROM (${src}))`).bind(ym, lo, hi),
      ];
    }
  }
}

/**
 * 取り込んだ日付の月に、作り直しの印を付ける（全ての表）。印はミリ秒までの時刻（UTC の ISO）で、作り直すときに読んだ印を built_at に写す。
 * 作り直しの途中で付いた印は built_at より新しいので、もう一度作り直す
 */
export async function markAggDirty(db: D1Database, dates: readonly string[], nowMs = Date.now()): Promise<void> {
  const now = new Date(nowMs).toISOString();
  const months = [...new Set(dates.map((d) => d.slice(0, 7)))];
  if (!months.length) return;
  await db.batch(
    months.flatMap((ym) =>
      AGG_KINDS.map((k) =>
        db.prepare('INSERT INTO agg_months (kind, ym, dirty_at) VALUES (?, ?, ?) ON CONFLICT (kind, ym) DO UPDATE SET dirty_at = excluded.dirty_at').bind(k, ym, now),
      ),
    ),
  );
}

/** 初回: 取り込み済みの全ての月に印を付ける */
async function seed(db: D1Database, nowMs: number): Promise<number> {
  const r = await db.prepare('SELECT MIN(race_date) AS lo, MAX(race_date) AS hi FROM race_boats').first<{ lo: string | null; hi: string | null }>();
  if (!r?.lo || !r.hi) return 0;
  const dates: string[] = [];
  for (let d = `${r.lo.slice(0, 7)}-01`; d.slice(0, 7) <= r.hi.slice(0, 7); d = addDays(monthRange(d.slice(0, 7)).endsOn, 1)) dates.push(d);
  await markAggDirty(db, dates, nowMs);
  return dates.length;
}

/** 作り直しの必要な表×月を、使える量の範囲で作り直す（1回の定時処理で最大 maxJobs 件） */
export async function aggregate(db: D1Database, nowMs: number, maxJobs = 1, usage?: Usage): Promise<string[]> {
  const log: string[] = [];
  const u = usage ?? (await loadUsage(db, nowMs));
  if (!(await db.prepare('SELECT 1 AS x FROM agg_months LIMIT 1').first())) {
    const n = await seed(db, nowMs);
    if (n) log.push(`aggregate: seeded ${n} months`);
  }
  for (let i = 0; i < maxJobs; i++) {
    if (!hasRoom(u, EST_READS, EST_WRITES)) {
      log.push('aggregate: daily budget reached');
      break;
    }
    const job = await db
      .prepare('SELECT kind, ym, dirty_at FROM agg_months WHERE built_at IS NULL OR dirty_at > built_at ORDER BY ym DESC, kind LIMIT 1')
      .first<{ kind: AggKind; ym: string; dirty_at: string }>();
    if (!job) break;
    const res = await db.batch([
      ...rebuildStatements(db, job.kind, job.ym),
      db.prepare('UPDATE agg_months SET built_at = ? WHERE kind = ? AND ym = ?').bind(job.dirty_at, job.kind, job.ym),
    ]);
    addMeta(u, res);
    log.push(`aggregate: ${job.kind} ${job.ym}`);
  }
  if (!usage) await saveUsage(db, u, nowMs);
  return log;
}
