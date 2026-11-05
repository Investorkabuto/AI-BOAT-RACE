// 過去データの検索・集計（観戦画面の「分析」と、参加AI向けの API。認証不要）。
// 元は検索用の表 race_boats（レース×艇）・race_payouts（払戻金）・race_records（天候・決まり手）。migrations/0010。
// 期間の既定は直近1年。長すぎる期間は集計が重くなるので、最長 4 年までにする。
import { Hono } from 'hono';
import type { Env } from '../env';
import { BET_TYPES } from '../lib/bets';
import { publicRead } from '../lib/http';
import { addDays, isDate, jstDate } from '../lib/time';
import { isJcd, VENUES } from '../lib/venues';

export const analysisApi = new Hono<{ Bindings: Env }>();
analysisApi.use('*', publicRead());

const MAX_DAYS = 4 * 366;
const bad = (message: string) => ({ error: { code: 'validation_failed', message } });

/** 期間（from〜to、両端を含む）。既定は直近1年（昨日まで） */
function period(q: (k: string) => string | undefined): { from: string; to: string } | string {
  const to = q('to') ?? addDays(jstDate(Date.now()), -1);
  const from = q('from') ?? addDays(to, -364);
  if (!isDate(from) || !isDate(to)) return 'from / to は YYYY-MM-DD';
  if (from > to) return 'from は to 以前';
  if ((Date.parse(to) - Date.parse(from)) / 86_400_000 > MAX_DAYS) return `期間は最長 ${MAX_DAYS} 日`;
  return { from, to };
}

const rate = (n: number, d: number) => (d ? Math.round((n / d) * 1000) / 10 : null); // %（小数1桁）
const round3 = (v: number | null) => (v === null ? null : Math.round(v * 1000) / 1000);

/** 出走した艇（欠場を除く）。着順か、F・L・S の記号がある */
const STARTED = "(b.place IS NOT NULL OR (b.place_mark IS NOT NULL AND b.place_mark NOT LIKE 'K%'))";

interface Agg {
  n: number;
  w1: number | null;
  w2: number | null;
  w3: number | null;
  avg_st: number | null;
  f: number | null;
  l: number | null;
}
const AGG = `COUNT(*) AS n, SUM(b.place = 1) AS w1, SUM(b.place <= 2) AS w2, SUM(b.place <= 3) AS w3,
  AVG(CASE WHEN b.place_mark IS NULL OR b.place_mark LIKE 'S%' THEN b.st END) AS avg_st, SUM(b.place_mark = 'F') AS f, SUM(b.place_mark LIKE 'L%') AS l`;
const shape = (a: Agg) => ({
  starts: a.n, win_pct: rate(a.w1 ?? 0, a.n), top2_pct: rate(a.w2 ?? 0, a.n), top3_pct: rate(a.w3 ?? 0, a.n),
  avg_st: round3(a.avg_st), flying: a.f ?? 0, late: a.l ?? 0,
});

/** 1. 選手別: 通算とコース別の1着率・2連率・3連率・平均ST・F回数（欠場を除く出走が分母） */
analysisApi.get('/racer/:toban', async (c) => {
  const toban = c.req.param('toban');
  if (!/^\d{4}$/.test(toban)) return c.json(bad('toban は4桁の登録番号'), 400);
  const p = period((k) => c.req.query(k));
  if (typeof p === 'string') return c.json(bad(p), 400);
  const db = c.env.DB;
  const where = `b.toban = ? AND b.race_date BETWEEN ? AND ? AND ${STARTED}`;
  const [profile, total, byCourse, recent] = await db.batch([
    db.prepare('SELECT name, grade, branch, age, race_date FROM race_boats WHERE toban = ? AND name IS NOT NULL ORDER BY race_date DESC LIMIT 1').bind(toban),
    db.prepare(`SELECT ${AGG} FROM race_boats b WHERE ${where}`).bind(toban, p.from, p.to),
    db.prepare(`SELECT b.course, ${AGG} FROM race_boats b WHERE ${where} AND b.course IS NOT NULL GROUP BY b.course ORDER BY b.course`).bind(toban, p.from, p.to),
    db.prepare(
      `SELECT b.race_id, b.race_date, b.jcd, b.rno, b.boat, b.course, b.place, b.place_mark, b.st, b.tenji, b.motor_2r, k.kimarite
       FROM race_boats b LEFT JOIN race_records k ON k.race_id = b.race_id WHERE b.toban = ? AND b.race_date BETWEEN ? AND ? AND (b.place IS NOT NULL OR b.place_mark IS NOT NULL)
       ORDER BY b.race_date DESC, b.rno DESC LIMIT 20`,
    ).bind(toban, p.from, p.to),
  ]);
  const prof = profile!.results[0] as { name: string; grade: string; branch: string; age: number; race_date: string } | undefined;
  return c.json({
    toban, ...p, profile: prof ?? null,
    total: shape(total!.results[0] as unknown as Agg),
    by_course: (byCourse!.results as unknown as (Agg & { course: number })[]).map((a) => ({ course: a.course, ...shape(a) })),
    recent: recent!.results,
    note: '分母は欠場を除く出走。平均STは F・L を除く。期間の既定は直近1年（昨日まで）。元データは公式の競走成績（K）と番組表（B）',
  });
});

/** 2. 場×コース別: コース別の1着率と決まり手の割合、枠番別の1着率 */
analysisApi.get('/venue/:jcd', async (c) => {
  const jcd = c.req.param('jcd');
  if (!isJcd(jcd)) return c.json(bad('jcd は 01〜24'), 400);
  const p = period((k) => c.req.query(k));
  if (typeof p === 'string') return c.json(bad(p), 400);
  const db = c.env.DB;
  const [byCourse, byBoat, kim, races] = await db.batch([
    db.prepare(`SELECT b.course, ${AGG} FROM race_boats b WHERE b.jcd = ? AND b.race_date BETWEEN ? AND ? AND ${STARTED} AND b.course IS NOT NULL GROUP BY b.course ORDER BY b.course`).bind(jcd, p.from, p.to),
    db.prepare(`SELECT b.boat, ${AGG} FROM race_boats b WHERE b.jcd = ? AND b.race_date BETWEEN ? AND ? AND ${STARTED} GROUP BY b.boat ORDER BY b.boat`).bind(jcd, p.from, p.to),
    db.prepare(
      `SELECT b.course, k.kimarite, COUNT(*) AS n FROM race_boats b JOIN race_records k ON k.race_id = b.race_id
       WHERE b.jcd = ? AND b.race_date BETWEEN ? AND ? AND b.place = 1 GROUP BY b.course, k.kimarite`,
    ).bind(jcd, p.from, p.to),
    db.prepare('SELECT COUNT(*) AS n FROM race_records k JOIN races r ON r.id = k.race_id WHERE r.jcd = ? AND r.race_date BETWEEN ? AND ?').bind(jcd, p.from, p.to),
  ]);
  const kimRows = kim!.results as { course: number | null; kimarite: string | null; n: number }[];
  const kimarite: Record<string, number> = {};
  for (const r of kimRows) kimarite[r.kimarite ?? '不明'] = (kimarite[r.kimarite ?? '不明'] ?? 0) + r.n;
  const totalWins = Object.values(kimarite).reduce((s, n) => s + n, 0);
  return c.json({
    jcd, venue: VENUES[jcd as keyof typeof VENUES] ?? null, ...p, races: (races!.results[0] as { n: number }).n,
    by_course: (byCourse!.results as unknown as (Agg & { course: number })[]).map((a) => ({
      course: a.course, ...shape(a),
      kimarite: Object.fromEntries(kimRows.filter((k) => k.course === a.course).map((k) => [k.kimarite ?? '不明', rate(k.n, a.w1 ?? 0)])),
    })),
    by_boat: (byBoat!.results as unknown as (Agg & { boat: number })[]).map((a) => ({ boat: a.boat, ...shape(a) })),
    kimarite_pct: Object.fromEntries(Object.entries(kimarite).map(([k, n]) => [k, rate(n, totalWins)])),
    note: 'by_course は実際の進入コース別、by_boat は枠番別（1号艇の勝率は by_boat の boat=1）。by_course[].kimarite はそのコースの1着の決まり手の割合（%）',
  });
});

/** 3. レース条件で絞り込んだレースの一覧と結果 */
analysisApi.get('/races', async (c) => {
  const q = (k: string) => c.req.query(k);
  const p = period(q);
  if (typeof p === 'string') return c.json(bad(p), 400);
  const where: string[] = ['r.race_date BETWEEN ? AND ?'];
  const args: unknown[] = [p.from, p.to];
  const num = (k: string, lo: number, hi: number) => {
    const s = q(k);
    if (s === undefined || s === '') return undefined;
    const n = Number(s);
    return Number.isInteger(n) && n >= lo && n <= hi ? n : null;
  };
  const jcd = q('jcd');
  if (jcd) {
    if (!isJcd(jcd)) return c.json(bad('jcd は 01〜24'), 400);
    where.push('r.jcd = ?');
    args.push(jcd);
  }
  for (const [k, col, op, lo, hi] of [
    ['rno', 'r.rno', '=', 1, 12], ['wind_min', 'k.wind_m', '>=', 0, 99], ['wind_max', 'k.wind_m', '<=', 0, 99],
    ['wave_min', 'k.wave_cm', '>=', 0, 999], ['wave_max', 'k.wave_cm', '<=', 0, 999],
  ] as const) {
    const n = num(k, lo, hi);
    if (n === null) return c.json(bad(`${k} は ${lo}〜${hi} の整数`), 400);
    if (n !== undefined) {
      where.push(`${col} ${op} ?`);
      args.push(n);
    }
  }
  for (const [k, col] of [['weather', 'k.weather'], ['wind_dir', 'k.wind_dir'], ['kimarite', 'k.kimarite']] as const) {
    const s = q(k);
    if (s) {
      where.push(`${col} = ?`);
      args.push(s.slice(0, 10));
    }
  }
  const fixed = q('fixed_course');
  if (fixed === '1' || fixed === '0') {
    where.push('IFNULL(c.fixed_course, 0) = ?');
    args.push(Number(fixed));
  }
  const wc = num('winner_course', 1, 6);
  if (wc === null) return c.json(bad('winner_course は 1〜6'), 400);
  if (wc !== undefined) {
    where.push('w.course = ?');
    args.push(wc);
  }
  const wb = num('winner_boat', 1, 6);
  if (wb === null) return c.json(bad('winner_boat は 1〜6'), 400);
  if (wb !== undefined) {
    where.push('w.boat = ?');
    args.push(wb);
  }
  const limit = Math.min(num('limit', 1, 200) ?? 50, 200);
  const offset = num('offset', 0, 100000) ?? 0;
  const from = `FROM races r JOIN race_records k ON k.race_id = r.id LEFT JOIN race_cards c ON c.race_id = r.id
    LEFT JOIN race_boats w ON w.race_id = r.id AND w.place = 1 AND w.boat = (SELECT MIN(boat) FROM race_boats WHERE race_id = r.id AND place = 1)
    LEFT JOIN race_payouts t ON t.race_id = r.id AND t.bet_type = 'sanrentan' AND t.combo = (SELECT MIN(combo) FROM race_payouts WHERE race_id = r.id AND bet_type = 'sanrentan' AND combo != '*')
    WHERE ${where.join(' AND ')}`;
  const db = c.env.DB;
  const [list, summary, courses] = await db.batch([
    db.prepare(
      `SELECT r.id AS race_id, r.race_date, r.jcd, r.rno, r.race_name, k.weather, k.wind_dir, k.wind_m, k.wave_cm, k.kimarite, IFNULL(c.fixed_course, 0) AS fixed_course,
         w.boat AS winner_boat, w.course AS winner_course, t.combo AS sanrentan, t.payout AS sanrentan_payout, t.pop AS sanrentan_pop
       ${from} ORDER BY r.race_date DESC, r.jcd, r.rno LIMIT ? OFFSET ?`,
    ).bind(...args, limit, offset),
    db.prepare(`SELECT COUNT(*) AS n, AVG(t.payout) AS avg_payout, SUM(t.pop = 1) AS fav ${from}`).bind(...args),
    db.prepare(`SELECT w.course, COUNT(*) AS n ${from} GROUP BY w.course ORDER BY w.course`).bind(...args),
  ]);
  const s = summary!.results[0] as { n: number; avg_payout: number | null; fav: number | null };
  return c.json({
    ...p, total: s.n, limit, offset,
    summary: {
      winner_course_pct: Object.fromEntries((courses!.results as { course: number | null; n: number }[]).map((x) => [x.course ?? '不明', rate(x.n, s.n)])),
      sanrentan_avg_payout: s.avg_payout === null ? null : Math.round(s.avg_payout),
      sanrentan_favorite_pct: rate(s.fav ?? 0, s.n),
    },
    races: (list!.results as Record<string, unknown>[]).map((x) => ({ ...x, fixed_course: x.fixed_course === 1 })),
    note: '条件: jcd・rno・wind_min/wind_max（m）・wave_min/wave_max（cm）・weather・wind_dir・kimarite・fixed_course（1/0）・winner_course・winner_boat・from/to・limit/offset。sanrentan_pop は3連単の的中の人気順',
  });
});

/** 4. 配当: 券種ごとの払戻金の分布と、的中した組番の人気順の分布 */
analysisApi.get('/payouts', async (c) => {
  const p = period((k) => c.req.query(k));
  if (typeof p === 'string') return c.json(bad(p), 400);
  const betType = c.req.query('bet_type') ?? 'sanrentan';
  if (!(BET_TYPES as readonly string[]).includes(betType)) return c.json(bad(`bet_type は ${BET_TYPES.join(' / ')}`), 400);
  const jcd = c.req.query('jcd');
  if (jcd && !isJcd(jcd)) return c.json(bad('jcd は 01〜24'), 400);
  const where = `bet_type = ? AND race_date BETWEEN ? AND ? AND combo != '*'${jcd ? ' AND jcd = ?' : ''}`;
  const args = [betType, p.from, p.to, ...(jcd ? [jcd] : [])];
  const db = c.env.DB;
  const [agg, buckets, pops] = await db.batch([
    db.prepare(`SELECT COUNT(*) AS n, AVG(payout) AS avg, MIN(payout) AS min, MAX(payout) AS max FROM race_payouts WHERE ${where}`).bind(...args),
    db.prepare(
      `SELECT CASE WHEN payout < 1000 THEN '〜999' WHEN payout < 3000 THEN '1,000〜2,999' WHEN payout < 10000 THEN '3,000〜9,999'
         WHEN payout < 30000 THEN '10,000〜29,999' WHEN payout < 100000 THEN '30,000〜99,999' ELSE '100,000〜' END AS bucket, MIN(payout) AS lo, COUNT(*) AS n
       FROM race_payouts WHERE ${where} GROUP BY bucket ORDER BY lo`,
    ).bind(...args),
    db.prepare(
      `SELECT CASE WHEN pop IS NULL THEN NULL WHEN pop <= 3 THEN pop WHEN pop <= 6 THEN 4 WHEN pop <= 10 THEN 7 WHEN pop <= 20 THEN 11 WHEN pop <= 50 THEN 21 ELSE 51 END AS lo, COUNT(*) AS n
       FROM race_payouts WHERE ${where} GROUP BY lo ORDER BY lo`,
    ).bind(...args),
  ]);
  const a = agg!.results[0] as { n: number; avg: number | null; min: number | null; max: number | null };
  const median = a.n
    ? ((await db.prepare(`SELECT payout FROM race_payouts WHERE ${where} ORDER BY payout LIMIT 1 OFFSET ?`).bind(...args, Math.floor(a.n / 2)).first<{ payout: number }>())?.payout ?? null)
    : null;
  const popLabel = (lo: number | null) => (lo === null ? '不明' : lo <= 3 ? `${lo}番人気` : { 4: '4〜6番人気', 7: '7〜10番人気', 11: '11〜20番人気', 21: '21〜50番人気', 51: '51番人気〜' }[lo] ?? String(lo));
  return c.json({
    bet_type: betType, jcd: jcd ?? null, ...p, count: a.n,
    payout: { avg: a.avg === null ? null : Math.round(a.avg), median, min: a.min, max: a.max },
    distribution: (buckets!.results as { bucket: string; n: number }[]).map((x) => ({ range: x.bucket, pct: rate(x.n, a.n), count: x.n })),
    winning_popularity: (pops!.results as { lo: number | null; n: number }[]).map((x) => ({ popularity: popLabel(x.lo), pct: rate(x.n, a.n), count: x.n })),
    note: '払戻金は100円あたり（特払いを除く）。winning_popularity は的中した組番が何番人気だったかの割合（締切時の人気。確定オッズは取り込み後に追加予定）',
  });
});

/**
 * 5. 予想に効く要素（推奨）: 展示タイムの順位・STの順位・モーター2連率・級別ごとの1着率。場（jcd）とコースで絞れる。
 * どの要素がどれだけ勝敗に効くかを、同じ物差し（1着率・3連率）で比べられるようにする
 */
analysisApi.get('/factors', async (c) => {
  const p = period((k) => c.req.query(k));
  if (typeof p === 'string') return c.json(bad(p), 400);
  const jcd = c.req.query('jcd');
  if (jcd && !isJcd(jcd)) return c.json(bad('jcd は 01〜24'), 400);
  const course = c.req.query('course');
  if (course && !/^[1-6]$/.test(course)) return c.json(bad('course は 1〜6'), 400);
  const base = `b.race_date BETWEEN ? AND ?${jcd ? ' AND b.jcd = ?' : ''} AND ${STARTED}`;
  const args = [p.from, p.to, ...(jcd ? [jcd] : [])];
  const outer = course ? ' WHERE course = ?' : '';
  const oargs = course ? [Number(course)] : [];
  const ranked = (col: string) =>
    `WITH t AS (SELECT b.place, b.course, RANK() OVER (PARTITION BY b.race_id ORDER BY b.${col}) AS rk FROM race_boats b WHERE ${base} AND b.${col} IS NOT NULL)
     SELECT rk AS k, COUNT(*) AS n, SUM(place = 1) AS w1, SUM(place <= 3) AS w3 FROM t${outer} GROUP BY rk ORDER BY rk`;
  const db = c.env.DB;
  const [tenji, st, motor, grade] = await db.batch([
    db.prepare(ranked('tenji')).bind(...args, ...oargs),
    db.prepare(ranked('st')).bind(...args, ...oargs),
    db.prepare(
      `SELECT CASE WHEN motor_2r IS NULL THEN NULL WHEN motor_2r >= 50 THEN 50 WHEN motor_2r >= 40 THEN 40 WHEN motor_2r >= 30 THEN 30 ELSE 0 END AS k,
         COUNT(*) AS n, SUM(place = 1) AS w1, SUM(place <= 3) AS w3 FROM race_boats b WHERE ${base}${course ? ' AND b.course = ?' : ''} GROUP BY k ORDER BY k`,
    ).bind(...args, ...oargs),
    db.prepare(`SELECT grade AS k, COUNT(*) AS n, SUM(place = 1) AS w1, SUM(place <= 3) AS w3 FROM race_boats b WHERE ${base}${course ? ' AND b.course = ?' : ''} AND grade IS NOT NULL GROUP BY grade ORDER BY grade`).bind(...args, ...oargs),
  ]);
  const rows = (q: typeof tenji, label: (k: unknown) => string) =>
    (q!.results as { k: unknown; n: number; w1: number | null; w3: number | null }[]).map((x) => ({ group: label(x.k), starts: x.n, win_pct: rate(x.w1 ?? 0, x.n), top3_pct: rate(x.w3 ?? 0, x.n) }));
  return c.json({
    ...p, jcd: jcd ?? null, course: course ? Number(course) : null,
    tenji_rank: rows(tenji, (k) => `展示${k}位`),
    st_rank: rows(st, (k) => `ST${k}位`),
    motor_2r: rows(motor, (k) => (k === null ? '不明' : k === 0 ? '30%未満' : `${k}%以上`)),
    grade: rows(grade, (k) => String(k)),
    note: '展示タイム・STの順位は同じレースの中での順位（同タイムは同順位）。motor_2r は番組表（前日）時点のモーター2連率。course を付けると、その進入コースの艇だけで集計する',
  });
});
