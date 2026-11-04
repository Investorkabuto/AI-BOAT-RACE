// 出走表（締切時刻）と公式結果の取り込み（GitHub Actions から呼ぶ）。INGEST_TOKEN で認証する。
import { Hono } from 'hono';
import type { Env } from '../env';
import { BET_TYPES, normalizeCombo, SPECIAL_COMBO, type BetType, type Payout } from '../lib/bets';
import { ApiError, bearer, readJson, safeEqual } from '../lib/http';
import { sha256Hex } from '../lib/crypto';
import { isDate, jstIso, jstToMs, parseHm } from '../lib/time';
import { isJcd, raceId } from '../lib/venues';
import { normalizeEntrants } from '../lib/entrants';
import { fetchDispatchError, RESULT_WANTED_SQL, resultWantedArgs } from '../jobs/fetch-dispatch';
import { waiveFinesForCancelled } from '../jobs/settlement';

export const internalApi = new Hono<{ Bindings: Env }>();

internalApi.use('*', async (c, next) => {
  const t = bearer(c);
  if (!c.env.INGEST_TOKEN || !t || !safeEqual(t, c.env.INGEST_TOKEN)) throw new ApiError(401, 'unauthorized', 'invalid ingest token');
  await next();
});

interface RaceIn {
  jcd: string;
  rno: number;
  deadline: string; // 'HH:MM'
  race_name?: string;
}

/**
 * 出走表の取り込み（その日の場・レース・締切予定時刻）。何度送ってもよい。
 * 受付中（scheduled）のレースだけ締切を更新する。締切後のレースは変えない（公平のため）
 */
internalApi.put('/races', async (c) => {
  const b = await readJson(c);
  const date = b.race_date;
  if (!isDate(date)) throw new ApiError(400, 'bad_request', 'race_date must be YYYY-MM-DD');
  if (!Array.isArray(b.races)) throw new ApiError(400, 'bad_request', 'races must be an array');
  const now = Date.now();
  const stmts: D1PreparedStatement[] = [];
  for (const r of b.races as RaceIn[]) {
    const hm = typeof r.deadline === 'string' ? parseHm(r.deadline) : null;
    if (!isJcd(r.jcd) || !Number.isInteger(r.rno) || r.rno < 1 || r.rno > 12 || !hm) throw new ApiError(400, 'bad_request', `invalid race: ${JSON.stringify(r)}`);
    const ms = jstToMs(date, hm.hour, hm.minute);
    stmts.push(
      c.env.DB.prepare(
        `INSERT INTO races (id, race_date, jcd, rno, race_name, deadline_at, deadline_ms, status, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, 'scheduled', ?)
         ON CONFLICT (id) DO UPDATE SET race_name = excluded.race_name, deadline_at = excluded.deadline_at, deadline_ms = excluded.deadline_ms, updated_at = excluded.updated_at
         WHERE races.status = 'scheduled' AND races.deadline_ms > ?`,
      ).bind(raceId(date, r.jcd, r.rno), date, r.jcd, r.rno, typeof r.race_name === 'string' ? r.race_name.slice(0, 80) : null, jstIso(ms), ms, jstIso(now), now),
    );
  }
  if (stmts.length) await c.env.DB.batch(stmts);
  return c.json({ upserted: stmts.length });
});

/**
 * 出走表の選手の基本情報の取り込み（枠番・登録番号・氏名・級別・支部・年齢。要件定義 §6）。何度送ってもよい。
 * body: { race_date, races: [{ jcd, rno, entrants: [...] }] }。先に PUT /races で登録したレースだけ保存する
 */
internalApi.put('/entrants', async (c) => {
  const b = await readJson(c);
  const date = b.race_date;
  if (!isDate(date)) throw new ApiError(400, 'bad_request', 'race_date must be YYYY-MM-DD');
  if (!Array.isArray(b.races)) throw new ApiError(400, 'bad_request', 'races must be an array');
  const now = jstIso(Date.now());
  const stmts: D1PreparedStatement[] = [];
  const skipped: string[] = [];
  for (const r of b.races as { jcd: unknown; rno: unknown; entrants: unknown }[]) {
    if (!isJcd(r.jcd) || typeof r.rno !== 'number' || !Number.isInteger(r.rno) || r.rno < 1 || r.rno > 12) throw new ApiError(400, 'bad_request', `invalid race: ${JSON.stringify({ jcd: r.jcd, rno: r.rno })}`);
    const id = raceId(date, r.jcd, r.rno);
    const n = normalizeEntrants(r.entrants);
    if (!n.ok) {
      skipped.push(`${id}: ${n.reason}`);
      continue;
    }
    stmts.push(
      c.env.DB.prepare(
        `INSERT INTO race_entrants (race_id, entrants_json, updated_at) SELECT id, ?, ? FROM races WHERE id = ?
         ON CONFLICT (race_id) DO UPDATE SET entrants_json = excluded.entrants_json, updated_at = excluded.updated_at`,
      ).bind(JSON.stringify(n.entrants), now, id),
    );
  }
  const saved = stmts.length ? (await c.env.DB.batch(stmts)).reduce((s, r) => s + (r.meta.changes ?? 0), 0) : 0;
  return c.json({ saved, skipped });
});

/** 選手の基本情報がまだ無い、その日の受付中のレース（朝の2回目の取り込みで、取りこぼしだけを取り直すため） */
internalApi.get('/entrant-requests', async (c) => {
  const date = c.req.query('date');
  if (!isDate(date)) throw new ApiError(400, 'bad_request', 'date must be YYYY-MM-DD');
  const r = await c.env.DB.prepare(
    `SELECT r.id, r.jcd, r.rno FROM races r LEFT JOIN race_entrants e ON e.race_id = r.id
     WHERE r.race_date = ? AND r.status = 'scheduled' AND e.race_id IS NULL ORDER BY r.jcd, r.rno`,
  ).bind(date).all<{ id: string; jcd: string; rno: number }>();
  return c.json({ requests: r.results });
});

/**
 * 秘密情報の設定の確認（値そのものは返さない）。管理者トークンが合わないときの調査用。
 * 返すのは、設定の有無・文字数・前後の空白の有無・SHA-256 の先頭8文字だけ
 */
internalApi.get('/config-check', async (c) => {
  const describe = async (v: string | undefined) =>
    v === undefined
      ? { set: false }
      : { set: true, length: v.length, has_surrounding_whitespace: v !== v.trim(), sha256_prefix: (await sha256Hex(v.trim())).slice(0, 8) };
  const dispatched = (
    await c.env.DB.prepare("SELECT key, updated_at FROM app_state WHERE key LIKE 'fetch:%' AND key != 'fetch:dispatch_error' ORDER BY updated_at DESC LIMIT 5").all<{ key: string; updated_at: string }>()
  ).results;
  return c.json({
    ADMIN_TOKEN: await describe(c.env.ADMIN_TOKEN),
    GITHUB_TOKEN: { set: !!c.env.GITHUB_TOKEN },
    GITHUB_REPO: c.env.GITHUB_REPO ?? null,
    fetch_dispatch: { ref: c.env.FETCH_WORKFLOW_REF || 'main', last_error: await fetchDispatchError(c.env.DB), recent: dispatched },
  });
});

/** 公式結果が必要なレース（締切後で結果が未取得。舟券のあるレースと、当日の全レース） */
internalApi.get('/result-requests', async (c) => {
  // ?date=YYYY-MM-DD&all=1: その日の締切を過ぎた全レースのうち、結果が未保存のもの（毎朝の全レースの結果の保存用。要件定義 §6）
  const date = c.req.query('date');
  if (c.req.query('all') === '1') {
    if (!isDate(date)) throw new ApiError(400, 'bad_request', 'date must be YYYY-MM-DD');
    const r = await c.env.DB.prepare(
      'SELECT r.id, r.race_date, r.jcd, r.rno, r.deadline_at FROM races r WHERE r.race_date = ? AND r.deadline_ms <= ? AND r.id NOT IN (SELECT race_id FROM race_results) ORDER BY r.deadline_ms',
    ).bind(date, Date.now()).all();
    return c.json({ requests: r.results });
  }
  // 精算待ち（舟券あり）のレースと、当日の締切後のレース（舟券の有無を問わない。観戦画面で当日中に結果を出すため）
  const r = await c.env.DB.prepare(`SELECT id, race_date, jcd, rno, deadline_at FROM races WHERE ${RESULT_WANTED_SQL} ORDER BY deadline_ms`)
    .bind(...resultWantedArgs(Date.now()))
    .all();
  return c.json({ requests: r.results });
});

interface ResultIn {
  race_id: string;
  status: 'official' | 'cancelled';
  finish?: unknown;
  refunded_boats?: unknown;
  payouts?: { bet_type: string; combo: string; payout: number }[];
}

/**
 * 公式結果の書き込み。精算待ちのレースは上書きできる。精算済み（舟券がなく締切で精算済みになったレースを含む）は、
 * 結果が未保存のときだけ保存する（毎朝の全レースの結果の保存。精算には使わない）
 */
internalApi.post('/results', async (c) => {
  const b = await readJson(c);
  if (!Array.isArray(b.results)) throw new ApiError(400, 'bad_request', 'results must be an array');
  const now = jstIso(Date.now());
  const stmts: D1PreparedStatement[] = [];
  for (const r of b.results as ResultIn[]) {
    const bad = (why: string) => new ApiError(400, 'bad_request', `invalid result (${why}): ${JSON.stringify(r).slice(0, 300)}`);
    if (typeof r.race_id !== 'string' || (r.status !== 'official' && r.status !== 'cancelled')) throw bad('race_id/status');
    const finish = (Array.isArray(r.finish) ? r.finish : []).map((x) => (Array.isArray(x) ? x : [x]));
    const refunded = Array.isArray(r.refunded_boats) ? r.refunded_boats : [];
    if ([...finish.flat(), ...refunded].some((x) => !Number.isInteger(x) || (x as number) < 1 || (x as number) > 6)) throw bad('boat number');
    const payouts: Payout[] = [];
    for (const p of r.payouts ?? []) {
      if (!(BET_TYPES as readonly string[]).includes(p.bet_type) || !(typeof p.payout === 'number' && p.payout >= 0)) throw bad('payout');
      const combo = p.combo === SPECIAL_COMBO ? SPECIAL_COMBO : normalizeCombo(p.bet_type as BetType, p.combo);
      if (!combo) throw bad(`combo ${p.combo}`);
      payouts.push({ bet_type: p.bet_type as BetType, combo, payout: p.payout });
    }
    if (r.status === 'official' && (finish.length < 2 || payouts.length === 0)) throw bad('official result needs finish and payouts');
    stmts.push(
      c.env.DB.prepare(
        `INSERT INTO race_results (race_id, status, finish_json, refunded_boats_json, payouts_json, fetched_at)
         SELECT ?, ?, ?, ?, ?, ? WHERE EXISTS (SELECT 1 FROM races WHERE id = ?)
         ON CONFLICT (race_id) DO UPDATE SET status = excluded.status, finish_json = excluded.finish_json, refunded_boats_json = excluded.refunded_boats_json,
           payouts_json = excluded.payouts_json, fetched_at = excluded.fetched_at
         WHERE EXISTS (SELECT 1 FROM races WHERE id = excluded.race_id AND status IN ('scheduled', 'locked'))`,
      ).bind(r.race_id, r.status, JSON.stringify(finish), JSON.stringify(refunded), JSON.stringify(payouts), now, r.race_id),
    );
  }
  if (stmts.length) await c.env.DB.batch(stmts);
  const cancelled = (b.results as ResultIn[]).filter((r) => r.status === 'cancelled').map((r) => r.race_id);
  const waived = cancelled.length ? await waiveFinesForCancelled(c.env.DB, cancelled, Date.now()) : 0;
  return c.json({ upserted: stmts.length, fines_waived: waived });
});
