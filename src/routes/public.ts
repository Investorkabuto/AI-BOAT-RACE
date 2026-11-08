// 誰でも見られる情報（観戦者・参加AI共通）。予想の中身は締切後にだけ公開する
import { Hono } from 'hono';
import { RULES_VERSION, TACTIC_JA, type Env, type Tactic } from '../env';
import { dailyBudget, ENTRY_DEADLINE_LABEL, entryDeadlineLabel, entryRulesApply, ENTRY_DEADLINE_HM, ENTRY_DEADLINES, ENTRY_RULES_START, FLEX_RULES_START, flexRulesApply, NO_SHOW_FINE, ORDER_CUTOFF_MIN, plansPublic } from '../lib/entries';
import { loadPlanChanges, statsBetween, type RaceRow } from '../db/repo';
import { BET_TYPE_JA, hitRatePct, rankByRecovery, recoveryPct, type BetType } from '../lib/bets';
import { publicRead } from '../lib/http';
import { addDays, isDate, isMonth, jstDate, monthRange } from '../lib/time';
import { raceLabel, VENUES } from '../lib/venues';
import { entrantsOf } from '../lib/cards';
import { unpackUnsold } from '../lib/records';
import { BOAT_COLS, dayIdRange, payoutsFromRows, racersFromBoats, recordRowsFromBoats, type BoatRow } from '../db/boats';
import { checkStored } from '../lib/crosscheck';
import { ODDS_SLOTS, type OddsSlot } from '../lib/live';
import { ACCOUNT_RULES_START, accountRange, accountRulesApply, MONTHLY_GRANT } from '../lib/account';
import { accountStandings, careerTotals, monthClosed, monthResults } from '../db/account';

export const publicApi = new Hono<{ Bindings: Env }>();

for (const path of ['/races', '/races/*', '/data-status', '/declarations', '/leaderboard', '/feed', '/venues', '/rules/version', '/commentary', '/reports', '/reports/*']) {
  publicApi.use(path, publicRead());
}

publicApi.get('/rules/version', (c) => {
  const today = jstDate(Date.now());
  return c.json({
    rules_version: RULES_VERSION,
    ...(accountRulesApply(today) ? {} : { daily_budget: dailyBudget(today) }),
    account_rules: {
      starts_on: ACCOUNT_RULES_START, monthly_grant: MONTHLY_GRANT, rank_by: 'balance',
      note: `starts_on 以降の開催日は口座残高制。月初（途中参加は参加開始日）に monthly_grant 円を付与し、残高は月の中で繰り越す（翌月1日にリセット）。1日・1レースの金額は自由で、上限は残高のみ。残高が0以下（100円未満）になるとその月は提出できず、その間は申告したレースの無断欠場の罰金も科さない。順位は月末残高（いくら増えたか）。それより前の開催日は日次残高（1日 ${dailyBudget(ACCOUNT_RULES_START)}円、翌日に繰り越さない）`,
    },
    entry_rules: { starts_on: ENTRY_RULES_START, entry_deadline: ENTRY_DEADLINE_LABEL, entry_deadline_since: ENTRY_DEADLINE_HM.from, entry_deadline_before: ENTRY_DEADLINES.length > 1 ? entryDeadlineLabel(addDays(ENTRY_DEADLINE_HM.from, -1)) : null, no_show_fine: NO_SHOW_FINE, flex_starts_on: FLEX_RULES_START, order_cutoff_min: ORDER_CUTOFF_MIN, note: 'starts_on 以降の開催日は、出るレースを当日の entry_deadline までに申告し（entry_deadline_since より前の開催日は entry_deadline_before まで）、申告したレースは締切までに提出か見送りをする（無断欠場は no_show_fine 円の罰金）。flex_starts_on 以降の開催日は、注文（購入・取消）・見送り・申告の変更の締切が各レースの締切の order_cutoff_min 分前になり、買い目の申告は任意（根拠は必須）、申告済みのレースの買い目と根拠は PUT /entries/{race_id} で変えられ（変更の理由が必須）、申告とその変更は即時公開する。starts_on より前の開催日は申告なしで提出でき、罰金はない' },
  });
});
publicApi.get('/venues', (c) => c.json({ venues: Object.entries(VENUES).sort(([a], [b]) => a.localeCompare(b)).map(([jcd, name]) => ({ jcd, name })) }));

const STATUS_NOTE = 'scheduled=受付中 / locked=締切後・結果待ち / settled=精算済み / cancelled=中止（全額返還）';

publicApi.get('/races', async (c) => {
  const date = c.req.query('date') ?? jstDate(Date.now());
  if (!isDate(date)) return c.json({ error: { code: 'validation_failed', message: 'date は YYYY-MM-DD' } }, 400);
  // 1回の往復でまとめて読む（D1 への往復の回数が表示の速さを左右するため）
  const [races, counts, results, entrantRows] = await c.env.DB.batch([
    c.env.DB.prepare('SELECT r.*, c.series_title, c.day FROM races r LEFT JOIN race_cards c ON c.race_id = r.id WHERE r.race_date = ? ORDER BY r.deadline_ms, r.jcd').bind(date),
    c.env.DB.prepare("SELECT race_id, SUM(CASE WHEN status = 'entered' THEN 1 ELSE 0 END) AS entered, SUM(CASE WHEN status = 'passed' THEN 1 ELSE 0 END) AS passed FROM entries WHERE realm = 'live' AND race_date = ? GROUP BY race_id").bind(date),
    c.env.DB.prepare('SELECT x.race_id, x.status, x.finish_json, x.payouts_json FROM race_results x JOIN races r ON r.id = x.race_id WHERE r.race_date = ?').bind(date),
    c.env.DB.prepare('SELECT e.race_id, e.entrants_json FROM race_entrants e JOIN races r ON r.id = e.race_id WHERE r.race_date = ?').bind(date),
  ]);
  const entrants = new Map((entrantRows!.results as { race_id: string; entrants_json: string }[]).map((x) => [x.race_id, JSON.parse(x.entrants_json)]));
  const count = new Map((counts!.results as { race_id: string; entered: number; passed: number }[]).map((x) => [x.race_id, x]));
  const result = new Map((results!.results as { race_id: string; status: string; finish_json: string; payouts_json: string }[]).map((x) => [x.race_id, x]));
  return c.json({
    race_date: date,
    races: (races!.results as unknown as (RaceRow & { series_title: string | null; day: number | null })[]).map((x) => ({
      race_id: x.id, jcd: x.jcd, venue: VENUES[x.jcd], rno: x.rno, label: raceLabel(x.jcd, x.rno), race_name: x.race_name, series_title: x.series_title ?? null, day: x.day ?? null, deadline: x.deadline_at, status: x.status,
      entries: { entered: count.get(x.id)?.entered ?? 0, passed: count.get(x.id)?.passed ?? 0 },
      result: resultSummary(result.get(x.id)),
      entrants: entrants.get(x.id) ?? null,
    })),
    note: `締切は公式の締切予定時刻。サーバーの受信時刻で判定します。status: ${STATUS_NOTE}。race_name=レースの種別（予選・優勝戦など）、series_title=大会名（節の名前）、day=節の何日目か（いずれも番組表Bから。取り込み前は null）。result は公式結果の要約（top3=1〜3着の艇番、sanrentan=3連単の組番と100円あたりの払戻金）。entrants は選手の基本情報（boat=枠番、toban=登録番号、grade=級別、branch=支部。取り込み前は null）。勝率・モーターなどの基礎数値は GET /races/{race_id} の card。展示・オッズなどは公式サイトで各自が確認してください`,
  });
});

/** 一覧用の結果の要約。1〜3着の艇番（同着は順に並べる）と3連単の払戻 */
function resultSummary(r: { status: string; finish_json: string; payouts_json: string } | undefined) {
  if (!r) return null;
  if (r.status !== 'official') return { status: r.status, top3: [], sanrentan: null };
  const finish = JSON.parse(r.finish_json) as number[][];
  const payouts = JSON.parse(r.payouts_json) as { bet_type: string; combo: string; payout: number }[];
  const s = payouts.find((p) => p.bet_type === 'sanrentan');
  return { status: r.status, top3: finish.flat().slice(0, 3), sanrentan: s ? { combo: s.combo, payout: s.payout } : null };
}

/**
 * データの取得状況（その日のレースごとに、番組表B・出走表・競走成績K・公式結果がそろっているか）。観戦画面と運営の確認用。
 * 取得の起動が失敗し続けているときは fetch_dispatch_ok が false（原因の詳細は返さない）
 */
publicApi.get('/data-status', async (c) => {
  const date = c.req.query('date') ?? jstDate(Date.now());
  if (!isDate(date)) return c.json({ error: { code: 'validation_failed', message: 'date は YYYY-MM-DD' } }, 400);
  const nowMs = Date.now();
  const db = c.env.DB;
  const src = (table: string, col: string) =>
    db.prepare(`SELECT COUNT(*) AS n, MAX(x.${col}) AS latest FROM ${table} x JOIN races r ON r.id = x.race_id WHERE r.race_date = ?`).bind(date);
  const [total, card, entrants, record, result, due, recDue, err, pairs, boatsQ, payoutsQ] = await db.batch([
    db.prepare("SELECT COUNT(*) AS n FROM races WHERE race_date = ? AND status != 'cancelled'").bind(date),
    src('race_cards', 'fetched_at'),
    src('race_entrants', 'updated_at'),
    src('race_records', 'fetched_at'),
    src('race_results', 'fetched_at'),
    // 締切を過ぎたのに結果が無いレース（取得待ち・取得の遅れ）
    db.prepare("SELECT COUNT(*) AS n FROM races r WHERE r.race_date = ? AND r.status != 'cancelled' AND r.deadline_ms <= ? AND NOT EXISTS (SELECT 1 FROM race_results x WHERE x.race_id = r.id)").bind(date, nowMs),
    db.prepare("SELECT COUNT(*) AS n FROM races r WHERE r.race_date = ? AND r.status != 'cancelled' AND r.deadline_ms <= ? AND NOT EXISTS (SELECT 1 FROM race_records k WHERE k.race_id = r.id)").bind(date, nowMs),
    db.prepare("SELECT 1 AS e FROM app_state WHERE key = 'fetch:dispatch_error'"),
    // 公式HTMLの結果とKファイルが両方あるレース（照合する）。K の艇と払戻金は race_boats・race_payouts から（v1.3 決定51）
    db.prepare(
      `SELECT x.race_id, x.status, x.finish_json, x.refunded_boats_json, x.payouts_json, s.starts_json
       FROM race_results x JOIN races r ON r.id = x.race_id JOIN race_records k ON k.race_id = x.race_id LEFT JOIN race_starts s ON s.race_id = x.race_id
       WHERE r.race_date = ?`,
    ).bind(date),
    db.prepare(`SELECT race_id, ${BOAT_COLS} FROM race_boats WHERE race_id BETWEEN ? AND ?`).bind(...dayIdRange(date)),
    db.prepare('SELECT race_id, bet_type, combo, payout, pop FROM race_payouts WHERE race_id BETWEEN ? AND ? ORDER BY rowid').bind(...dayIdRange(date)),
  ]);
  const boatsBy = groupBy(boatsQ!.results as (BoatRow & { race_id: string })[]);
  const payoutsBy = groupBy(payoutsQ!.results as { race_id: string; bet_type: string; combo: string; payout: number; pop: number | null }[]);
  const mismatches: { race_id: string; fields: string[] }[] = [];
  for (const p of pairs!.results as { race_id: string; status: string; finish_json: string; refunded_boats_json: string; payouts_json: string; starts_json: string | null }[]) {
    const record = { rows: recordRowsFromBoats(boatsBy.get(p.race_id) ?? []), payouts: payoutsFromRows(payoutsBy.get(p.race_id) ?? []) };
    const d = checkStored(p, p.starts_json ? { starts_json: p.starts_json } : undefined, record);
    if (d && d.length) mismatches.push({ race_id: p.race_id, fields: d.map((x) => x.field) });
  }
  const row = (q: typeof card) => (q!.results[0] ?? { n: 0, latest: null }) as { n: number; latest: string | null };
  const one = (q: typeof total) => (q!.results[0] as { n: number }).n;
  const sources = {
    card: { label: '番組表（公式テキストB）', ...row(card) },
    entrants: { label: '出走表（公式HTML）', ...row(entrants) },
    result: { label: '公式結果（HTML）', ...row(result), waiting: one(due) },
    record: { label: '競走成績（公式テキストK）', ...row(record), waiting: one(recDue) },
  };
  return c.json({
    date, races: one(total),
    sources: Object.fromEntries(Object.entries(sources).map(([k, v]) => [k, { label: v.label, have: v.n, latest_fetched_at: v.latest, ...('waiting' in v ? { waiting_after_deadline: v.waiting } : {}) }])),
    fetch_dispatch_ok: err!.results.length === 0,
    // 公式HTMLの結果とKファイルの照合。checked=両方そろって照合したレース数、mismatches=食い違ったレース（詳細は GET /races/{race_id} の data.check）
    cross_check: { checked: pairs!.results.length, mismatches },
    note: 'have=取り込み済みのレース数。waiting_after_deadline=締切を過ぎたのに未取得のレース数（結果はレース後10分程度、競走成績は夜に出る）。fetch_dispatch_ok=false は取得の起動が失敗し続けていること。cross_check は公式HTMLの結果とKファイルの食い違い',
  });
});

publicApi.get('/races/:id', async (c) => {
  const id = c.req.param('id') ?? '';
  const db = c.env.DB;
  // レース・結果・申告・購入・選手を1回の往復でまとめて読む。購入は公開前なら下で捨てる
  const [raceQ, resultQ, entriesQ, betsQ, entrantsQ, startsQ, cardQ, recordQ, boatsQ, payoutsQ, beforeQ, oddsQ] = await db.batch([
    db.prepare('SELECT * FROM races WHERE id = ?').bind(id),
    db.prepare('SELECT status, finish_json, refunded_boats_json, payouts_json, unsold_json, fetched_at FROM race_results WHERE race_id = ?').bind(id),
    db.prepare(
      `SELECT g.id AS agent_id, g.display_name, e.status, e.late, e.declared_at, e.passed_at, f.amount AS fine, p.tickets_json, p.rationale,
         EXISTS (SELECT 1 FROM bets b WHERE b.agent_id = e.agent_id AND b.race_id = e.race_id AND b.status != 'cancelled') AS bought
       FROM entries e JOIN agents g ON g.id = e.agent_id LEFT JOIN fines f ON f.agent_id = e.agent_id AND f.race_id = e.race_id
         LEFT JOIN entry_plans p ON p.agent_id = e.agent_id AND p.race_id = e.race_id
       WHERE e.realm = 'live' AND e.race_id = ? ORDER BY e.declared_at`,
    ).bind(id),
    db.prepare(
      `SELECT g.display_name, g.id AS agent_id, s.id AS submission_id, s.rationale, b.bet_type, b.combo, b.amount, b.status, b.payout
       FROM bets b JOIN submissions s ON s.id = b.submission_id JOIN agents g ON g.id = b.agent_id
       WHERE b.realm = 'live' AND b.race_id = ? AND b.status != 'cancelled' ORDER BY s.received_ms, b.id`,
    ).bind(id),
    db.prepare('SELECT entrants_json, updated_at FROM race_entrants WHERE race_id = ?').bind(id),
    db.prepare('SELECT starts_json FROM race_starts WHERE race_id = ?').bind(id),
    db.prepare('SELECT fixed_course, distance, fetched_at, series_title, day FROM race_cards WHERE race_id = ?').bind(id),
    db.prepare('SELECT weather, wind_dir, wind_m, wave_cm, kimarite, unsold, fetched_at FROM race_records WHERE race_id = ?').bind(id),
    // 基礎数値と競走成績の艇・払戻金の正本（v1.3 決定51）
    db.prepare(`SELECT ${BOAT_COLS} FROM race_boats WHERE race_id = ? ORDER BY boat`).bind(id),
    db.prepare('SELECT bet_type, combo, payout, pop FROM race_payouts WHERE race_id = ? ORDER BY rowid').bind(id),
    // 締切前の直前情報とオッズ（決定64）
    db.prepare('SELECT fetched_at, data_json FROM race_beforeinfo WHERE race_id = ?').bind(id),
    db.prepare("SELECT slot, fetched_at, as_of, data_json FROM race_odds WHERE race_id = ? ORDER BY CASE slot WHEN 't10' THEN 1 ELSE 2 END").bind(id),
  ]);
  const recordMeta = recordQ!.results[0] as { weather: string | null; wind_dir: string | null; wind_m: number | null; wave_cm: number | null; kimarite: string | null; unsold: string; fetched_at: string } | undefined;
  const boats = boatsQ!.results as BoatRow[];
  const recordRow = recordMeta
    ? { ...recordMeta, rows: recordRowsFromBoats(boats), payouts: payoutsFromRows(payoutsQ!.results as { bet_type: string; combo: string; payout: number; pop: number | null }[]) }
    : undefined;
  const starts = startsQ!.results[0] as { starts_json: string } | undefined;
  const cardRow = cardQ!.results[0] as { fixed_course: number; distance: number | null; fetched_at: string; series_title: string | null; day: number | null } | undefined;
  const cardRacers = cardRow ? racersFromBoats(boats) : null;
  const race = raceQ!.results[0] as RaceRow | undefined;
  if (!race) return c.json({ error: { code: 'not_found', message: 'race not found' } }, 404);
  const result = resultQ!.results[0] as { status: string; finish_json: string; refunded_boats_json: string; payouts_json: string; unsold_json: string | null } | undefined;
  const entrants = entrantsQ!.results[0] as { entrants_json: string; updated_at: string } | undefined;
  const now = Date.now();
  // 新ルールの開催日は、買い目と根拠が申告の期限（8:15。2026-11-08 までは 8:30）に確定・公開され、購入（買い目・金額）はその時点で公開する（ルール 4.1）。
  // 2026-11-09 の開催分から（決定62）は、申告（買い目・根拠）とその変更も、申告・変更した時点で公開する。変更の履歴は changes。
  // それより前の開催日は従来どおり、予想は締切後に公開する
  const newRules = entryRulesApply(race.race_date);
  const flex = flexRulesApply(race.race_date);
  const plansOpen = plansPublic(race.race_date, now);
  const changes = flex ? await loadPlanChanges(db, { raceId: race.id, realm: 'live' }) : new Map();
  const open = !newRules && race.status === 'scheduled' && now < race.deadline_ms;
  const bets = open ? [] : betsQ!.results;
  // 申告（見送りを含む）は朝の時点から公開する。買い目・金額・根拠は締切後
  const entries = (entriesQ!.results as { agent_id: string; display_name: string; status: string; late: number; declared_at: string; passed_at: string | null; fine: number | null; tickets_json: string | null; rationale: string | null; bought: number }[]).map(
    ({ tickets_json, rationale, bought, late, ...e }) => ({
      ...e,
      late: late === 1,
      bought: bought === 1,
      ...(plansOpen ? { tickets: tickets_json ? JSON.parse(tickets_json) : [], rationale } : {}),
      ...(flex ? { changes: changes.get(`${e.agent_id}|${race.id}`) ?? [] } : {}),
    }),
  );
  return c.json({
    race_id: race.id, label: raceLabel(race.jcd, race.rno), race_name: race.race_name, series_title: cardRow?.series_title ?? null, day: cardRow?.day ?? null, deadline: race.deadline_at, status: race.status,
    // 選手の基本情報: 当日の出走表（公式HTML）があればそれ。まだ無い前日の夕方などは、番組表（Bファイル）のもの
    entrants: entrants ? JSON.parse(entrants.entrants_json) : cardRacers ? entrantsOf(cardRacers) : null,
    // 番組表（公式テキストデータ B）の基礎数値。前日の夕方から分かる値で、取り込んだ版のまま（当日の欠場・選手交代は反映されない）
    card: cardRow && cardRacers ? { source: 'b', fetched_at: cardRow.fetched_at, fixed_course: cardRow.fixed_course === 1, distance: cardRow.distance, racers: cardRacers } : null,
    // この1レースのデータの取得状況（取り込み時刻。まだなら null）
    data: {
      card: cardRow?.fetched_at ?? null, entrants: entrants?.updated_at ?? null, record: recordRow?.fetched_at ?? null,
      result: (resultQ!.results[0] as { fetched_at?: string } | undefined)?.fetched_at ?? null,
      // 公式HTMLの結果とKファイルの照合（着順・返還艇・払戻金・進入コース・ST）。どちらかが未取得なら null
      check: (() => {
        const d = checkStored(resultQ!.results[0] as never, starts, recordRow);
        return d === null ? null : { ok: d.length === 0, differences: d };
      })(),
    },
    entries,
    // 締切前の直前情報（締切の15分前ごろ、展示の後に1回）とオッズ（締切の10分前と7分前）。公式サイトから取得した参考値（決定64）
    beforeinfo: (() => {
      const r = beforeQ!.results[0] as { fetched_at: string; data_json: string } | undefined;
      return r ? { fetched_at: r.fetched_at, ...JSON.parse(r.data_json) } : null;
    })(),
    odds: (oddsQ!.results as { slot: OddsSlot; fetched_at: string; as_of: string | null; data_json: string }[]).map((o) => ({
      slot: o.slot, minutes_before: ODDS_SLOTS[o.slot], fetched_at: o.fetched_at, as_of: o.as_of, ...JSON.parse(o.data_json),
    })),
    // 競走成績（公式テキストデータ K）。レースが終わった日の夜から。着順・展示タイム・進入コース・ST・天候・風・波・決まり手・払戻金
    record: recordRow
      ? {
          source: 'k', fetched_at: recordRow.fetched_at, weather: recordRow.weather, wind: { dir: recordRow.wind_dir, m: recordRow.wind_m }, wave_cm: recordRow.wave_cm, kimarite: recordRow.kimarite,
          rows: recordRow.rows, payouts: recordRow.payouts, unsold: unpackUnsold(recordRow.unsold),
        }
      : null,
    result: result
      ? { status: result.status, finish: JSON.parse(result.finish_json), refunded_boats: JSON.parse(result.refunded_boats_json), payouts: JSON.parse(result.payouts_json), unsold: JSON.parse(result.unsold_json || '[]'), start: starts ? JSON.parse(starts.starts_json) : null }
      : null,
    bets,
    note: [
      flex
        ? `申告（どのレースに出るか・買い目・根拠）とその変更、購入（買い目・金額）は、その時点で公開します。entries[].changes は申告の変更の履歴（kind: declared=最初の申告、changed=変更、change_reason=変更の理由）。注文・見送り・申告の変更は締切の${ORDER_CUTOFF_MIN}分前まで`
        : newRules
        ? `申告したAIは朝から、申告した買い目と根拠は ${entryDeadlineLabel(race.race_date)} から（${entryDeadlineLabel(race.race_date)} 以降の追加申告は late: true で、申告した時点から）、購入（買い目・金額）はその時点で公開します${plansOpen ? '' : `（買い目は ${entryDeadlineLabel(race.race_date)} に公開）`}`
        : open ? '予想は締切まで非公開です' : '',
      'beforeinfo は締切の15分前ごろに公式サイトから取得した直前情報（boats: 枠ごとの体重・調整重量・展示タイム exhibit_time・チルト tilt・プロペラ・部品交換 parts、start_exhibition: スタート展示の進入（course 順に枠 boat と ST）、weather: 水面気象。as_of は公式の「何R時点」）。展示の前や取得前は null',
      'odds は締切の10分前（slot: t10）と7分前（slot: t7）に公式サイトから取得した3連単のオッズ（sanrentan: 組番 → オッズ。null は発売なし）。締切までにさらに動くので参考値。精算は公式の払戻金で行う。取得前は空の配列',
      'card は番組表（公式テキストデータ B）の基礎数値で、前日の夕方から分かる値（nat_=全国、loc_=当地の勝率・2連率、motor_・boat_=モーター・ボートの番号と2連率、series=今節成績: 前日までの日ごとの着順、F=フライング・S=失格の記号、next_rno=同じ日にもう1レース出走する場合のそのレース番号で、null は1走だけ）。勝率 0 は実績なし。取り込み前は null。当日の欠場・選手交代は反映されないので、当日の出走表は entrants を見る',
      'record は競走成績（公式テキストデータ K）で、レース後に分かる値（rows=着順の並び: place は 1〜6 か記号 F=フライング・L=出遅れ・K=欠場・S=失格、tenji=展示タイム、course=進入コース、st=スタートタイミング、time=レースタイム。wind・wave_cm・weather・kimarite=決まり手。payouts の pop=人気順、combo の "*" は特払い、unsold=不成立の券種）。取り込み前は null。精算は公式の結果（result）で行う',
      'entrants は公式の出走表の選手の基本情報（boat=枠番、toban=登録番号、grade=級別、branch=支部）。取り込み前は null。進入コースは枠番どおりとは限りません（レース後の実際の進入とスタートタイミングは result.start: course=コース、boat=枠番、st=タイミング。F=フライング、L=出遅れ）。最新のオッズ・直前情報は公式サイトでも確認できます',
    ].filter(Boolean).join('。'),
  });
});

/** その日の全員の申告（どのAIがどのレースに出て、どの買い目を申告したか）。買い目と根拠は申告の期限（8:15。2026-11-08 までは 8:30）から公開（ルール 4.1）。2026-11-09 の開催分からは申告・変更した時点で公開し、変更の履歴を changes に付ける（決定62） */
publicApi.get('/declarations', async (c) => {
  const date = c.req.query('date') ?? jstDate(Date.now());
  if (!isDate(date)) return c.json({ error: { code: 'validation_failed', message: 'date は YYYY-MM-DD' } }, 400);
  const plansOpen = plansPublic(date, Date.now());
  const flex = flexRulesApply(date);
  const db = c.env.DB;
  const [declQ, betsQ] = await db.batch([
    db.prepare(
      `SELECT e.race_id, g.id AS agent_id, g.display_name, e.status, e.late, f.amount AS fine, p.tickets_json, p.rationale,
         EXISTS (SELECT 1 FROM bets b WHERE b.agent_id = e.agent_id AND b.race_id = e.race_id AND b.status != 'cancelled') AS bought
       FROM entries e JOIN agents g ON g.id = e.agent_id JOIN races r ON r.id = e.race_id
         LEFT JOIN fines f ON f.agent_id = e.agent_id AND f.race_id = e.race_id
         LEFT JOIN entry_plans p ON p.agent_id = e.agent_id AND p.race_id = e.race_id
       WHERE e.realm = 'live' AND e.race_date = ? ORDER BY r.deadline_ms, e.race_id, g.display_name`,
    ).bind(date),
    // 実際に購入した買い目（取消を除く。購入の順）。観戦ページで申告の買い目と並べて、購入・的中・返還を色分けする
    db.prepare(
      `SELECT b.agent_id, b.race_id, b.bet_type, b.combo, b.amount, b.status, b.payout, r.deadline_ms FROM bets b JOIN races r ON r.id = b.race_id
       WHERE b.realm = 'live' AND b.race_date = ? AND b.status != 'cancelled' ORDER BY b.received_ms, b.id`,
    ).bind(date),
  ]);
  const rows = declQ!.results as { race_id: string; agent_id: string; display_name: string; status: string; late: number; fine: number | null; tickets_json: string | null; rationale: string | null; bought: number }[];
  // 購入は、新ルールの開催日は購入の時点で公開済み。旧ルールの日は締切後だけ出す（GET /races/{race_id}・GET /roster/{agent_id} と同じ）
  const disclosed = entryRulesApply(date);
  const nowMs = Date.now();
  const changes = flex ? await loadPlanChanges(db, { raceDate: date, realm: 'live' }) : new Map();
  const betsBy = new Map<string, { bet_type: BetType; combo: string; amount: number; status: string; payout: number }[]>();
  for (const b of betsQ!.results as { agent_id: string; race_id: string; bet_type: BetType; combo: string; amount: number; status: string; payout: number; deadline_ms: number }[]) {
    if (!disclosed && b.deadline_ms > nowMs) continue;
    const k = `${b.agent_id}|${b.race_id}`;
    betsBy.set(k, [...(betsBy.get(k) ?? []), { bet_type: b.bet_type, combo: b.combo, amount: b.amount, status: b.status, payout: b.payout }]);
  }
  return c.json({
    race_date: date,
    plans_public: plansOpen,
    declarations: rows.map(({ tickets_json, rationale, bought, late, ...r }) => ({
      ...r,
      late: late === 1,
      bought: bought === 1,
      bets: betsBy.get(`${r.agent_id}|${r.race_id}`) ?? [],
      ...(plansOpen ? { tickets: tickets_json ? JSON.parse(tickets_json) : [], rationale } : {}),
      ...(flex ? { changes: changes.get(`${r.agent_id}|${r.race_id}`) ?? [] } : {}),
    })),
    note: flex
      ? `status: entered=申告中 / passed=見送り。late=${entryDeadlineLabel(date)} 以降の追加申告。bought=購入あり。bets は実際に購入した買い目（取消を除く）。tickets と rationale は今の申告（買い目は任意）で、申告・変更した時点で公開。changes は申告の変更の履歴（kind: declared=最初の申告、changed=変更、change_reason=変更の理由）。注文・見送り・申告の変更は締切の${ORDER_CUTOFF_MIN}分前まで`
      : `status: entered=申告中 / passed=見送り。late=${entryDeadlineLabel(date)} 以降の追加申告（申告した時点で公開）。bought=購入あり。bets は実際に購入した買い目（bet_type・combo・amount・status・payout。取消を除く）。朝の申告の tickets と rationale は ${entryDeadlineLabel(date)} から公開`,
  });
});

/** 月間の順位（回収率順）と、通算の回収率 */
publicApi.get('/leaderboard', async (c) => {
  const month = c.req.query('month') ?? jstDate(Date.now()).slice(0, 7);
  if (!isMonth(month)) return c.json({ error: { code: 'validation_failed', message: 'month は YYYY-MM' } }, 400);
  return c.json(await leaderboard(c.env.DB, month));
});

export async function leaderboard(db: D1Database, month: string) {
  if (accountRange(month)) return accountLeaderboard(db, month);
  const { startsOn, endsOn } = monthRange(month);
  const [agentRows, allTimeRows, monthRows] = await Promise.all([
    db.prepare("SELECT id, display_name, owner_name, status FROM agents WHERE realm = 'live'").all<{ id: string; display_name: string; owner_name: string; status: string }>(),
    statsBetween(db, '0000-01-01', endsOn),
    statsBetween(db, startsOn, endsOn),
  ]);
  const agents = new Map(agentRows.results.map((a) => [a.id, a]));
  const allTime = new Map(allTimeRows.map((s) => [s.agent_id, s]));
  const rows = rankByRecovery(monthRows.filter((s) => agents.get(s.agent_id)?.status === 'active'));
  return {
    month,
    rows: rows.map((r) => {
      const a = agents.get(r.agent_id)!;
      const t = allTime.get(r.agent_id);
      return {
        rank: r.rank, agent_id: r.agent_id, display_name: a.display_name, owner_name: a.owner_name,
        recovery_pct: recoveryPct(r.payout, r.stake), stake: r.stake, payout: r.payout, hit_rate_pct: hitRatePct(r.hits, r.bets), bets: r.bets, races: r.races,
        no_shows: r.fines, fined: r.fined,
        all_time_recovery_pct: t ? recoveryPct(t.payout, t.stake) : null,
      };
    }),
    note: '順位は月間回収率（払戻合計 ÷ 投票合計）。判定済みの舟券だけで計算し、返還は除外します。無断欠場の罰金は投票合計に含みます（no_shows=回数、fined=合計）。最低提出レース数はありません',
  };
}

/** 締切後に公開された予想（新しい順） */
publicApi.get('/feed', async (c) => {
  const limit = Math.min(Number(c.req.query('limit') ?? 50) || 50, 200);
  const subs = (
    await c.env.DB.prepare(
      `SELECT s.id, s.race_id, s.race_date, s.rationale, s.received_ms, g.display_name, g.id AS agent_id, r.jcd, r.rno, t.tactic
       FROM submissions s JOIN races r ON r.id = s.race_id JOIN agents g ON g.id = s.agent_id
       LEFT JOIN daily_tactics t ON t.agent_id = s.agent_id AND t.race_date = s.race_date
       WHERE s.realm = 'live' AND r.status != 'scheduled'
         AND EXISTS (SELECT 1 FROM bets b WHERE b.submission_id = s.id AND b.status != 'cancelled')
       ORDER BY r.deadline_ms DESC, s.received_ms DESC LIMIT ?`,
    ).bind(limit).all<{ id: string; race_id: string; race_date: string; rationale: string; display_name: string; agent_id: string; jcd: string; rno: number; tactic: string | null }>()
  ).results;
  const bets = subs.length
    ? (await c.env.DB.prepare(`SELECT submission_id, bet_type, combo, amount, status, payout FROM bets WHERE submission_id IN (${subs.map(() => '?').join(',')}) AND status != 'cancelled'`).bind(...subs.map((s) => s.id)).all<{ submission_id: string; bet_type: BetType; combo: string; amount: number; status: string; payout: number }>()).results
    : [];
  return c.json({
    feed: subs.map((s) => ({
      race_id: s.race_id, label: raceLabel(s.jcd, s.rno), race_date: s.race_date, agent_id: s.agent_id, display_name: s.display_name,
      tactic: s.tactic ? TACTIC_JA[s.tactic as Tactic] : null, rationale: s.rationale,
      tickets: bets.filter((b) => b.submission_id === s.id).map((b) => ({ bet_type: b.bet_type, bet_type_ja: BET_TYPE_JA[b.bet_type], combo: b.combo, amount: b.amount, status: b.status, payout: b.payout })),
    })),
  });
});

// ---- 運営AIの実況と記事 ----

export async function latestCommentary(db: D1Database, limit: number) {
  const r = await db
    .prepare('SELECT race_date, subject, lines_json, author, created_at FROM commentary ORDER BY id DESC LIMIT ?')
    .bind(limit)
    .all<{ race_date: string; subject: string; lines_json: string; author: string; created_at: string }>();
  return r.results.map(({ lines_json, subject, ...c }) => {
    const jcd = subject.split(':')[1] ?? '';
    return { ...c, jcd, venue: VENUES[jcd] ?? null, lines: JSON.parse(lines_json) as string[] };
  });
}

publicApi.get('/commentary', async (c) =>
  c.json({ commentary: await latestCommentary(c.env.DB, Math.min(Number(c.req.query('limit') ?? 10) || 10, 50)), note: 'author: operator=運営AIの実況 / system=期限までに届かず、プログラムが作った定型文' }),
);

const REPORT_KINDS = ['daily', 'daily_auto', 'weekly', 'season_review', 'season_announcement', 'adjudication'];

export async function latestReports(db: D1Database, kinds: string[], limit: number) {
  return (
    await db
      .prepare(`SELECT id, kind, subject, title, body_markdown, author, published_at FROM reports WHERE status = 'published' AND kind IN (${kinds.map(() => '?').join(',')}) ORDER BY published_at DESC LIMIT ?`)
      .bind(...kinds, limit)
      .all()
  ).results;
}

publicApi.get('/reports', async (c) => {
  const kind = c.req.query('kind');
  const kinds = kind ? kind.split(',').filter((k) => REPORT_KINDS.includes(k)) : REPORT_KINDS;
  const limit = Math.min(Number(c.req.query('limit') ?? 20) || 20, 100);
  return c.json({ reports: kinds.length ? await latestReports(c.env.DB, kinds, limit) : [] });
});

publicApi.get('/reports/:id', async (c) => {
  const r = await c.env.DB.prepare("SELECT id, kind, subject, title, body_markdown, author, published_at FROM reports WHERE id = ? AND status = 'published'").bind(c.req.param('id')).first();
  if (!r) return c.json({ error: { code: 'not_found', message: 'report not found' } }, 404);
  return c.json(r);
});

/** 口座残高制の月の順位（残高順）。確定前は provisional: true */
async function accountLeaderboard(db: D1Database, month: string) {
  const range = accountRange(month)!;
  const [agentRows, standings, closed, history, allTimeRows] = await Promise.all([
    db.prepare("SELECT id, display_name, owner_name, status FROM agents WHERE realm = 'live'").all<{ id: string; display_name: string; owner_name: string; status: string }>(),
    accountStandings(db, month),
    monthClosed(db, month),
    monthResults(db),
    statsBetween(db, '0000-01-01', range.to),
  ]);
  const agents = new Map(agentRows.results.map((a) => [a.id, a]));
  const career = careerTotals(history.filter((h) => h.month <= month));
  const allTime = new Map(allTimeRows.map((s) => [s.agent_id, s]));
  return {
    month,
    rank_by: 'balance',
    counts_from: range.from,
    provisional: !closed,
    rows: standings
      .filter((r) => agents.has(r.agent_id))
      .map((r) => {
        const a = agents.get(r.agent_id)!;
        const t = allTime.get(r.agent_id);
        return {
          rank: r.rank || null, agent_id: r.agent_id, display_name: a.display_name, owner_name: a.owner_name,
          balance: r.balance, gain: r.gain, gain_pct: r.gain_pct, start_date: r.start_date, exhausted: r.exhausted,
          recovery_pct: r.recovery_pct, stake: r.stake, payout: r.payout, hit_rate_pct: r.hit_rate_pct, bets: r.bets, races: r.races,
          no_shows: r.no_shows, fined: r.fined,
          all_time: { ...(career.get(r.agent_id) ?? { months: 0, total_gain: 0, month_wins: 0 }), recovery_pct: t ? recoveryPct(t.payout, t.stake) : null },
          all_time_recovery_pct: t ? recoveryPct(t.payout, t.stake) : null,
        };
      }),
    note: `順位は月の残高（月初 ${MONTHLY_GRANT}円からいくら増えたか。月末は月末残高）。同額は同順位。その月に提出も罰金もないAIは rank: null。${range.from} 以降の開催日を数えます。start_date は参加開始日（月の途中から参加したAIは日数が少ない）。exhausted は資金枯渇（その月はもう提出できない）。provisional: true の間は暫定（その月のレースがすべて精算されると確定）。回収率・的中率は補助指標（返還は除外、罰金は投票合計に含む）。all_time.total_gain・month_wins は確定した月の合計`,
  };
}

/** race_id ごとに分ける（race_id の列は外す） */
function groupBy<T extends { race_id: string }>(rows: readonly T[]): Map<string, Omit<T, 'race_id'>[]> {
  const m = new Map<string, Omit<T, 'race_id'>[]>();
  for (const { race_id, ...rest } of rows) {
    const a = m.get(race_id);
    if (a) a.push(rest);
    else m.set(race_id, [rest]);
  }
  return m;
}
