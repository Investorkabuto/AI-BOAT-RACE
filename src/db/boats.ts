// 検索・集計用の表（race_boats / race_payouts、migrations/0010）への書き込み。
// どれも1レース1文（艇・払戻金の配列は JSON で1つのパラメータにして json_each で展開する。D1 の1文あたりのパラメータ数の上限を超えないように）。
import type { CardRacer } from '../lib/cards';
import { encodeSeries } from '../lib/cards';
import type { RecordPayout, RecordRow } from '../lib/records';

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

/** 競走成績（K）の値を race_boats に書く（B の列は変えない。B が無いレースでも行を作る） */
export function boatsFromRecord(db: D1Database, race: { id: string; date: string; jcd: string; rno: number }, rows: readonly RecordRow[], guard: Guard = ALWAYS): D1PreparedStatement {
  const json = JSON.stringify(
    rows.map((r) => ({
      boat: r.boat, toban: r.toban, place: typeof r.place === 'number' ? r.place : null, place_mark: typeof r.place === 'string' ? r.place : null,
      course: r.course, st: r.st, tenji: r.tenji, race_time: r.time,
    })),
  );
  const cols = ['place', 'place_mark', 'course', 'st', 'tenji', 'race_time'];
  return db
    .prepare(
      `INSERT INTO race_boats (race_id, boat, race_date, jcd, rno, toban, ${cols.join(', ')})
       SELECT ?, ${v('boat')}, ?, ?, ?, ${v('toban')}, ${cols.map(v).join(', ')} FROM json_each(?) j WHERE ${guard.sql}
       ON CONFLICT (race_id, boat) DO UPDATE SET ${cols.map((c) => `${c} = excluded.${c}`).join(', ')}`,
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
