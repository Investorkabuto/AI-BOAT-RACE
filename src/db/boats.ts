// レース×艇の表 race_boats と払戻金の表 race_payouts（migrations/0010・0012）の書き込みと読み出し。
// v1.3（決定51）から、番組表の基礎数値と競走成績の正本はこの2つ（race_cards・race_records の詰めた形は src/jobs/compact.ts が空にする）。
// 書き込みはどれも1レース1文（艇・払戻金の配列は JSON で1つのパラメータにして json_each で展開する。D1 の1文あたりのパラメータ数の上限を超えないように）。
import { decodeSeries, encodeSeries, type CardGrade, type CardRacer, type SeriesMark } from '../lib/cards';
import type { Place, RecordPayout, RecordRow } from '../lib/records';
import { BET_TYPES, type BetType } from '../lib/bets';

/** 書き込む条件（例: その版を今回書いたときだけ）。SQL の式と、そのパラメータ */
export interface Guard {
  sql: string;
  args: unknown[];
}
const ALWAYS: Guard = { sql: '1', args: [] };

const v = (k: string) => `json_extract(j.value, '$.${k}')`;

/** 番組表（B）の値を race_boats に書く（K の列は変えない） */
export function boatsFromCard(db: D1Database, race: { id: string; date: string; jcd: string; rno: number }, racers: readonly CardRacer[], guard: Guard = ALWAYS): D1PreparedStatement {
  const cols = ['toban', 'name', 'grade', 'branch', 'age', 'weight', 'nat_win', 'nat_2r', 'loc_win', 'loc_2r', 'motor_no', 'motor_2r', 'boat_no', 'boat_2r', 'series', 'next_rno'];
  const json = JSON.stringify(racers.map((r) => ({ ...r, series: encodeSeries(r.series) })));
  return db
    .prepare(
      `INSERT INTO race_boats (race_id, boat, race_date, jcd, rno, ${cols.join(', ')})
       SELECT ?, ${v('boat')}, ?, ?, ?, ${cols.map(v).join(', ')} FROM json_each(?) j WHERE ${guard.sql}
       ON CONFLICT (race_id, boat) DO UPDATE SET ${cols.map((c) => `${c} = excluded.${c}`).join(', ')}`,
    )
    .bind(race.id, race.date, race.jcd, race.rno, json, ...guard.args);
}

/** K の番号を k_* に入れる式（B の番号と違うときだけ。同じ・どちらかが無いなら NULL）。ON CONFLICT の中で使う */
const kOnly = (c: string) =>
  `CASE WHEN race_boats.${c} IS NULL OR excluded.${c} IS NULL OR race_boats.${c} = excluded.${c} THEN NULL ELSE excluded.${c} END`;

/**
 * 競走成績（K）の値を race_boats に書く（B の列は変えない。B が無いレースでも行を作る）。
 * モーター・ボート番号は B が無いときだけ K の値を motor_no・boat_no に入れ、B と違うときは k_motor_no・k_boat_no に入れる
 */
export function boatsFromRecord(db: D1Database, race: { id: string; date: string; jcd: string; rno: number }, rows: readonly RecordRow[], guard: Guard = ALWAYS): D1PreparedStatement {
  const json = JSON.stringify(
    rows.map((r) => ({
      boat: r.boat, toban: r.toban, motor_no: r.motor_no, boat_no: r.boat_no, place: typeof r.place === 'number' ? r.place : null, place_mark: typeof r.place === 'string' ? r.place : null,
      course: r.course, st: r.st, tenji: r.tenji, race_time: r.time,
    })),
  );
  const cols = ['place', 'place_mark', 'course', 'st', 'tenji', 'race_time'];
  return db
    .prepare(
      `INSERT INTO race_boats (race_id, boat, race_date, jcd, rno, toban, motor_no, boat_no, ${cols.join(', ')})
       SELECT ?, ${v('boat')}, ?, ?, ?, ${v('toban')}, ${v('motor_no')}, ${v('boat_no')}, ${cols.map(v).join(', ')} FROM json_each(?) j WHERE ${guard.sql}
       ON CONFLICT (race_id, boat) DO UPDATE SET ${cols.map((c) => `${c} = excluded.${c}`).join(', ')},
         motor_no = IFNULL(race_boats.motor_no, excluded.motor_no), boat_no = IFNULL(race_boats.boat_no, excluded.boat_no),
         k_motor_no = ${kOnly('motor_no')}, k_boat_no = ${kOnly('boat_no')}`,
    )
    .bind(race.id, race.date, race.jcd, race.rno, json, ...guard.args);
}

/** 競走成績（K）の払戻金を race_payouts に書く（そのレースの分を入れ替える） */
export function payoutsFromRecord(db: D1Database, race: { id: string; date: string; jcd: string }, payouts: readonly RecordPayout[], guard: Guard = ALWAYS): D1PreparedStatement[] {
  return [
    db.prepare(`DELETE FROM race_payouts WHERE race_id = ? AND ${guard.sql}`).bind(race.id, ...guard.args),
    db
      .prepare(
        `INSERT OR REPLACE INTO race_payouts (race_id, race_date, jcd, bet_type, combo, payout, pop)
         SELECT ?, ?, ?, ${v('bet_type')}, ${v('combo')}, ${v('payout')}, ${v('pop')} FROM json_each(?) j WHERE ${guard.sql}`,
      )
      .bind(race.id, race.date, race.jcd, JSON.stringify(payouts), ...guard.args),
  ];
}

// ---- 読み出し（v1.3 決定51: race_boats・race_payouts が正本。参加APIの出走表 card と競走成績 record はここから作る） ----

/** race_boats から読む列（SELECT ${BOAT_COLS} FROM race_boats ...） */
export const BOAT_COLS =
  'boat, toban, name, grade, branch, age, weight, nat_win, nat_2r, loc_win, loc_2r, motor_no, motor_2r, boat_no, boat_2r, series, next_rno, place, place_mark, course, st, tenji, race_time, k_motor_no, k_boat_no';

export interface BoatRow {
  boat: number;
  toban: string;
  name: string | null;
  grade: string | null;
  branch: string | null;
  age: number | null;
  weight: number | null;
  nat_win: number | null;
  nat_2r: number | null;
  loc_win: number | null;
  loc_2r: number | null;
  motor_no: number | null;
  motor_2r: number | null;
  boat_no: number | null;
  boat_2r: number | null;
  series: string | null;
  next_rno: number | null;
  place: number | null;
  place_mark: string | null;
  course: number | null;
  st: number | null;
  tenji: number | null;
  race_time: number | null;
  k_motor_no: number | null;
  k_boat_no: number | null;
}

/** 番組表（B）の選手（枠番の順）。B の値がある行（氏名あり）だけ */
export function racersFromBoats(rows: readonly BoatRow[]): CardRacer[] {
  return rows
    .filter((b) => b.name !== null)
    .sort((a, b) => a.boat - b.boat)
    .map((b) => ({
      boat: b.boat, toban: b.toban, name: b.name!, age: b.age, branch: b.branch, weight: b.weight, grade: b.grade as CardGrade,
      nat_win: b.nat_win, nat_2r: b.nat_2r, loc_win: b.loc_win, loc_2r: b.loc_2r,
      motor_no: b.motor_no, motor_2r: b.motor_2r, boat_no: b.boat_no, boat_2r: b.boat_2r,
      series: decodeSeries(b.series ?? '') as SeriesMark[][], next_rno: b.next_rno,
    }));
}

/** 競走成績（K）の艇（着順の順。記号の艇は後ろに枠番の順）。K の値がある行（着順か記号あり）だけ */
export function recordRowsFromBoats(rows: readonly BoatRow[]): RecordRow[] {
  return rows
    .filter((b) => b.place !== null || b.place_mark !== null)
    .sort((a, b) => (a.place ?? 99) - (b.place ?? 99) || a.boat - b.boat)
    .map((b) => ({
      place: (b.place ?? b.place_mark) as Place, boat: b.boat, toban: b.toban,
      motor_no: b.k_motor_no ?? b.motor_no, boat_no: b.k_boat_no ?? b.boat_no,
      tenji: b.tenji, course: b.course, st: b.st, time: b.race_time,
    }));
}

/** race_payouts の行（SELECT bet_type, combo, payout, pop ... ORDER BY rowid）を、券種の順に並べる（同じ券種の中は取り込んだ順） */
export function payoutsFromRows(rows: readonly { bet_type: string; combo: string; payout: number; pop: number | null }[]): RecordPayout[] {
  return rows
    .map((r, i) => ({ r, i }))
    .sort((a, b) => BET_TYPES.indexOf(a.r.bet_type as BetType) - BET_TYPES.indexOf(b.r.bet_type as BetType) || a.i - b.i)
    .map(({ r }) => ({ bet_type: r.bet_type as BetType, combo: r.combo, payout: r.payout, pop: r.pop }));
}

/** その日のレースの id の範囲（race_id は 'YYYYMMDD-jcd-rno'。主キーの範囲で引くため） */
export const dayIdRange = (date: string): [string, string] => {
  const d = date.replaceAll('-', '');
  return [`${d}-`, `${d}-~`];
};
