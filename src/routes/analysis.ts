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

/** 場の所在地の支部（地元の選手かどうかを見る） */
const VENUE_BRANCH: Record<string, string> = {
  '01': '群馬', '02': '埼玉', '03': '東京', '04': '東京', '05': '東京', '06': '静岡', '07': '愛知', '08': '愛知', '09': '三重', '10': '福井', '11': '滋賀', '12': '大阪',
  '13': '兵庫', '14': '徳島', '15': '香川', '16': '岡山', '17': '広島', '18': '山口', '19': '山口', '20': '福岡', '21': '福岡', '22': '福岡', '23': '佐賀', '24': '長崎',
};
/** レース名からレースの種類（優勝戦・準優勝戦・予選・一般・選抜など） */
const RACE_TYPE_SQL = `CASE WHEN r.race_name IS NULL THEN NULL WHEN r.race_name LIKE '%準優%' THEN '準優勝戦' WHEN r.race_name LIKE '%優勝戦%' THEN '優勝戦'
  WHEN r.race_name LIKE '%予選%' THEN '予選' WHEN r.race_name LIKE '%一般%' THEN '一般' WHEN r.race_name LIKE '%選抜%' THEN '選抜' WHEN r.race_name LIKE '%特選%' OR r.race_name LIKE '%特賞%' THEN '特選・特賞'
  WHEN r.race_name LIKE '%ドリーム%' THEN 'ドリーム' ELSE 'その他' END`;

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
    db.prepare('SELECT name, grade, branch, age, weight, nat_win, nat_2r, loc_win, loc_2r, jcd, race_date FROM race_boats WHERE toban = ? AND name IS NOT NULL ORDER BY race_date DESC LIMIT 1').bind(toban),
    db.prepare(`SELECT ${AGG} FROM race_boats b WHERE ${where}`).bind(toban, p.from, p.to),
    db.prepare(`SELECT b.course, ${AGG} FROM race_boats b WHERE ${where} AND b.course IS NOT NULL GROUP BY b.course ORDER BY b.course`).bind(toban, p.from, p.to),
    db.prepare(
      `SELECT b.race_id, b.race_date, b.jcd, b.rno, b.boat, b.course, b.place, b.place_mark, b.st, b.tenji, b.motor_2r, k.kimarite
       FROM race_boats b LEFT JOIN race_records k ON k.race_id = b.race_id WHERE b.toban = ? AND b.race_date BETWEEN ? AND ? AND (b.place IS NOT NULL OR b.place_mark IS NOT NULL)
       ORDER BY b.race_date DESC, b.rno DESC LIMIT 20`,
    ).bind(toban, p.from, p.to),
  ]);
  const prof = profile!.results[0] as Record<string, unknown> | undefined;
  return c.json({
    toban, ...p, profile: prof ?? null,
    total: shape(total!.results[0] as unknown as Agg),
    by_course: (byCourse!.results as unknown as (Agg & { course: number })[]).map((a) => ({ course: a.course, ...shape(a) })),
    recent: recent!.results,
    note: 'profile は最新の番組表（B）の値（勝率・2連率は全国 nat_ と、その日の場の当地 loc_）。分母は欠場を除く出走。平均STは F・L を除く。期間の既定は直近1年（昨日まで）。元データは公式の競走成績（K）と番組表（B）',
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
  const rt = q('race_type');
  if (rt) {
    where.push(`(${RACE_TYPE_SQL}) = ?`);
    args.push(rt.slice(0, 10));
  }
  const day = num('day', 1, 12);
  if (day === null) return c.json(bad('day は 1〜12'), 400);
  if (day !== undefined) {
    where.push('c.day = ?');
    args.push(day);
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
      `SELECT r.id AS race_id, r.race_date, r.jcd, r.rno, r.race_name, (${RACE_TYPE_SQL}) AS race_type, c.day, c.series_title, c.distance, k.weather, k.wind_dir, k.wind_m, k.wave_cm, k.kimarite, IFNULL(c.fixed_course, 0) AS fixed_course,
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
    note: '条件: jcd・rno・race_type（優勝戦・準優勝戦・予選・一般・選抜・特選・特賞・ドリーム・その他）・day（節の第何日）・wind_min/wind_max（m）・wave_min/wave_max（cm）・weather・wind_dir・kimarite・fixed_course（1/0）・winner_course・winner_boat・from/to・limit/offset。sanrentan_pop は3連単の的中の人気順',
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
  const ranked = (col: string, dir: 'ASC' | 'DESC' = 'ASC') =>
    `WITH t AS (SELECT b.place, b.course, RANK() OVER (PARTITION BY b.race_id ORDER BY b.${col} ${dir}) AS rk FROM race_boats b WHERE ${base} AND b.${col} IS NOT NULL)
     SELECT rk AS k, COUNT(*) AS n, SUM(place = 1) AS w1, SUM(place <= 3) AS w3 FROM t${outer} GROUP BY rk ORDER BY rk`;
  // 区分（式 k）ごとの出走・1着・3着内。join で番組表（race_cards）とレース（races）の値も使える
  const grouped = (expr: string) =>
    `SELECT ${expr} AS k, COUNT(*) AS n, SUM(b.place = 1) AS w1, SUM(b.place <= 3) AS w3
     FROM race_boats b LEFT JOIN race_cards c ON c.race_id = b.race_id LEFT JOIN races r ON r.id = b.race_id
     WHERE ${base}${course ? ' AND b.course = ?' : ''} GROUP BY k ORDER BY k`;
  const bucket = (col: string, edges: number[]) => `CASE WHEN ${col} IS NULL THEN NULL ${[...edges].reverse().map((e) => `WHEN ${col} >= ${e} THEN ${e}`).join(' ')} ELSE -1 END`;
  const local = `CASE b.jcd ${Object.entries(VENUE_BRANCH).map(([j, br]) => `WHEN '${j}' THEN '${br}'`).join(' ')} END`;
  const db = c.env.DB;
  const qs = {
    tenji_rank: ranked('tenji'),
    st_rank: ranked('st'),
    nat_win_rank: ranked('nat_win', 'DESC'),
    motor_2r_rank: ranked('motor_2r', 'DESC'),
    motor_2r: grouped(bucket('b.motor_2r', [30, 40, 50])),
    boat_2r: grouped(bucket('b.boat_2r', [30, 40, 50])),
    grade: grouped('b.grade'),
    nat_win: grouped(bucket('b.nat_win', [4, 5, 6, 7, 8])),
    loc_win: grouped(`CASE WHEN b.loc_win = 0 THEN 0 ELSE ${bucket('b.loc_win', [4, 5, 6, 7, 8])} END`),
    age: grouped(bucket('b.age', [25, 35, 45, 55])),
    weight: grouped(bucket('b.weight', [51, 53, 55])),
    local_racer: grouped(`CASE WHEN b.branch IS NULL THEN NULL WHEN b.branch = ${local} THEN 1 ELSE 0 END`),
    races_today: grouped('CASE WHEN b.name IS NULL THEN NULL WHEN b.next_rno IS NULL THEN 0 ELSE 1 END'),
    last_place: grouped("CASE WHEN b.series IS NULL OR replace(b.series, ',', '') = '' THEN NULL ELSE substr(replace(b.series, ',', ''), -1) END"),
    series_day: grouped('c.day'),
    race_type: grouped(RACE_TYPE_SQL),
    fixed_course: grouped('c.fixed_course'),
  };
  const res = await db.batch(Object.values(qs).map((sql) => db.prepare(sql).bind(...args, ...oargs)));
  const keys = Object.keys(qs) as (keyof typeof qs)[];
  const labels: Record<keyof typeof qs, (k: unknown) => string> = {
    tenji_rank: (k) => `展示${k}位`,
    st_rank: (k) => `ST${k}位`,
    nat_win_rank: (k) => `全国勝率${k}位`,
    motor_2r_rank: (k) => `モーター2連率${k}位`,
    motor_2r: (k) => (k === null ? '不明' : k === -1 ? '30%未満' : `${k}%以上`),
    boat_2r: (k) => (k === null ? '不明' : k === -1 ? '30%未満' : `${k}%以上`),
    grade: (k) => (k === null ? '不明' : String(k)),
    nat_win: (k) => (k === null ? '不明' : k === -1 ? '4.00未満' : `${k}.00以上`),
    loc_win: (k) => (k === null ? '不明' : k === 0 ? '当地の実績なし' : k === -1 ? '4.00未満' : `${k}.00以上`),
    age: (k) => (k === null ? '不明' : k === -1 ? '25歳未満' : `${k}歳以上`),
    weight: (k) => (k === null ? '不明' : k === -1 ? '51kg未満' : `${k}kg以上`),
    local_racer: (k) => (k === null ? '不明' : k === 1 ? '地元（支部が同じ）' : '地元以外'),
    races_today: (k) => (k === null ? '不明' : k === 1 ? 'その日2走' : 'その日1走'),
    last_place: (k) => (k === null ? '今節の前走なし' : /^\d$/.test(String(k)) ? `前走${k}着` : `前走${k}`),
    series_day: (k) => (k === null ? '不明' : `第${k}日`),
    race_type: (k) => String(k ?? '不明'),
    fixed_course: (k) => (k === null ? '不明' : k === 1 ? '進入固定' : '固定なし'),
  };
  const out: Record<string, unknown> = {};
  keys.forEach((k, i) => {
    out[k] = (res[i]!.results as { k: unknown; n: number; w1: number | null; w3: number | null }[]).map((x) => ({ group: labels[k](x.k), starts: x.n, win_pct: rate(x.w1 ?? 0, x.n), top3_pct: rate(x.w3 ?? 0, x.n) }));
  });
  return c.json({
    ...p, jcd: jcd ?? null, course: course ? Number(course) : null, ...out,
    note: '1着率・3連率は欠場を除く出走が分母。_rank は同じレースの中での順位（展示・STは速い順、勝率・2連率は高い順。同値は同順位）。番組表（B）の値（勝率・2連率・級別・年齢・体重・支部・今節成績・第何日・進入固定）は前日時点。local_racer は選手の支部が場の所在地と同じか。last_place は今節の前走の着順。course を付けると、その進入コースの艇だけで集計する',
  });
});

/**
 * 6. 全項目の書き出し（参加AI向け。1日分）: その日の全レースの、番組表（B）・競走成績（K）・払戻金のすべての項目を、加工せずに返す。
 * 自分で特徴量を作って学習するAIのため。jcd で場を絞れる。締切前のレースは、締切前に分かる値（番組表）だけを返す
 */
analysisApi.get('/export', async (c) => {
  const date = c.req.query('date');
  if (!isDate(date)) return c.json(bad('date は YYYY-MM-DD'), 400);
  const jcd = c.req.query('jcd');
  if (jcd && !isJcd(jcd)) return c.json(bad('jcd は 01〜24'), 400);
  const w = `r.race_date = ?${jcd ? ' AND r.jcd = ?' : ''}`;
  const args = [date, ...(jcd ? [jcd] : [])];
  const db = c.env.DB;
  const [races, boats, pays] = await db.batch([
    db.prepare(
      `SELECT r.id AS race_id, r.race_date, r.jcd, r.rno, r.race_name, (${RACE_TYPE_SQL}) AS race_type, r.deadline_at, r.deadline_ms, r.status,
         c.day, c.series_title, c.fixed_course, c.distance, k.weather, k.wind_dir, k.wind_m, k.wave_cm, k.kimarite, k.unsold
       FROM races r LEFT JOIN race_cards c ON c.race_id = r.id LEFT JOIN race_records k ON k.race_id = r.id WHERE ${w} ORDER BY r.jcd, r.rno`,
    ).bind(...args),
    db.prepare(`SELECT b.* FROM race_boats b JOIN races r ON r.id = b.race_id WHERE ${w} ORDER BY b.race_id, b.boat`).bind(...args),
    db.prepare(`SELECT p.race_id, p.bet_type, p.combo, p.payout, p.pop FROM race_payouts p JOIN races r ON r.id = p.race_id WHERE ${w} ORDER BY p.race_id, p.bet_type, p.payout`).bind(...args),
  ]);
  const now = Date.now();
  const POST = ['place', 'place_mark', 'course', 'st', 'tenji', 'race_time'];
  const byRace = new Map<string, { boats: Record<string, unknown>[]; payouts: Record<string, unknown>[] }>();
  const slot = (id: string) => byRace.get(id) ?? (byRace.set(id, { boats: [], payouts: [] }), byRace.get(id)!);
  const closed = new Set((races!.results as { race_id: string; deadline_ms: number }[]).filter((r) => r.deadline_ms <= now).map((r) => r.race_id));
  for (const b of boats!.results as Record<string, unknown>[]) {
    const id = b.race_id as string;
    const { race_id: _r, race_date: _d, jcd: _j, rno: _n, ...rest } = b;
    // 締切前のレースに、レース後の値が入ることはないが、念のため落とす
    if (!closed.has(id)) for (const k of POST) delete rest[k];
    slot(id).boats.push(rest);
  }
  for (const p of pays!.results as Record<string, unknown>[]) {
    const id = p.race_id as string;
    if (!closed.has(id)) continue;
    const { race_id: _r, ...rest } = p;
    slot(id).payouts.push(rest);
  }
  return c.json({
    date, jcd: jcd ?? null,
    races: (races!.results as Record<string, unknown>[]).map(({ deadline_ms: _m, unsold, fixed_course, ...r }) => ({
      ...r, fixed_course: fixed_course === null ? null : fixed_course === 1,
      unsold: typeof unsold === 'string' && unsold ? unsold.split(',').map((i) => BET_TYPES[Number(i)]) : [],
      boats: byRace.get(r.race_id as string)?.boats ?? [], payouts: byRace.get(r.race_id as string)?.payouts ?? [],
    })),
    note: '1日分の全項目（加工なし）。boats の B の列（name・grade・branch・age・weight・nat_win・nat_2r・loc_win・loc_2r・motor_no・motor_2r・boat_no・boat_2r・series・next_rno）は前日の番組表、K の列（place・place_mark・course・st・tenji・race_time）はレース後の競走成績。series は今節の日ごとの着順を "," でつないだもの。place_mark は F・L・K（欠場）・S（失格）。payouts は100円あたり、pop は人気順、combo "*" は特払い、unsold は不成立の券種。締切前のレースには K の列と払戻金を入れない',
  });
});
