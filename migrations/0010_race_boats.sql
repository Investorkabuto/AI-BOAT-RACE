-- 検索・集計用の表（2026-11-05 管理者決定: 容量を小さくするより、検索できる形を優先する）
-- race_boats: レース×艇で1行。レース前に分かる値（番組表B）と、レース後に分かる値（競走成績K）を同じ行に持つ。
--   選手別・場×コース別・展示順位などの集計を、SQL だけで速く引けるようにする
--   B の列は PUT /internal/cards と過去分の取り込みが、K の列は PUT /internal/records と過去分の取り込みが書く
-- race_payouts: レース×券種×組番で1行（K の払戻金と人気順）。配当の分布・人気別の的中の集計に使う
-- race_cards / race_records の詰めた形（rows・payouts の JSON）は、版の比較と履歴のために残す
CREATE TABLE IF NOT EXISTS race_boats (
  race_id    TEXT NOT NULL,
  boat       INTEGER NOT NULL,          -- 枠番
  race_date  TEXT NOT NULL,
  jcd        TEXT NOT NULL,
  rno        INTEGER NOT NULL,
  toban      TEXT NOT NULL,             -- 登録番号
  name       TEXT,
  grade      TEXT,                      -- 級別
  branch     TEXT,                      -- 支部
  age        INTEGER,
  weight     INTEGER,
  nat_win    REAL,                      -- 全国勝率（B）
  nat_2r     REAL,
  loc_win    REAL,                      -- 当地勝率（B）
  loc_2r     REAL,
  motor_no   INTEGER,
  motor_2r   REAL,
  boat_no    INTEGER,
  boat_2r    REAL,
  series     TEXT,                      -- 今節成績（"32,1,24,12" の形）
  next_rno   INTEGER,                   -- 同じ日にもう1レース出走する場合のレース番号
  place      INTEGER,                   -- 着順 1〜6（K。記号の艇は NULL）
  place_mark TEXT,                      -- F・L0・L1・K0・K1・S0・S1・S2（K。着順が数字なら NULL）
  course     INTEGER,                   -- 進入コース（K）
  st         REAL,                      -- スタートタイミング（秒。F・L も正の値で、place_mark で区別）
  tenji      REAL,                      -- 展示タイム（秒）
  race_time  REAL,                      -- レースタイム（秒）
  PRIMARY KEY (race_id, boat)
);
CREATE INDEX IF NOT EXISTS race_boats_toban ON race_boats (toban, race_date);
CREATE INDEX IF NOT EXISTS race_boats_venue_course ON race_boats (jcd, course, race_date);
CREATE INDEX IF NOT EXISTS race_boats_date ON race_boats (race_date, jcd);
CREATE INDEX IF NOT EXISTS race_boats_motor ON race_boats (jcd, motor_no, race_date);

CREATE TABLE IF NOT EXISTS race_payouts (
  race_id   TEXT NOT NULL,
  race_date TEXT NOT NULL,
  jcd       TEXT NOT NULL,
  bet_type  TEXT NOT NULL,
  combo     TEXT NOT NULL,              -- 特払いは "*"
  payout    INTEGER NOT NULL,           -- 100円あたり
  pop       INTEGER,                    -- 人気順（単勝・複勝には無い）
  PRIMARY KEY (race_id, bet_type, combo)
);
CREATE INDEX IF NOT EXISTS race_payouts_type ON race_payouts (bet_type, race_date);
CREATE INDEX IF NOT EXISTS race_payouts_venue ON race_payouts (jcd, bet_type, race_date);

-- 取り込み済みの番組表（race_cards）から、B の列を作る（この移行の1回だけ）
INSERT OR IGNORE INTO race_boats (race_id, boat, race_date, jcd, rno, toban, name, grade, branch, age, weight, nat_win, nat_2r, loc_win, loc_2r, motor_no, motor_2r, boat_no, boat_2r, series, next_rno)
SELECT c.race_id, json_extract(j.value, '$[0]'), r.race_date, r.jcd, r.rno, json_extract(j.value, '$[1]'), json_extract(j.value, '$[2]'), json_extract(j.value, '$[6]'),
  json_extract(j.value, '$[4]'), json_extract(j.value, '$[3]'), json_extract(j.value, '$[5]'),
  json_extract(j.value, '$[7]') / 100.0, json_extract(j.value, '$[8]') / 100.0, json_extract(j.value, '$[9]') / 100.0, json_extract(j.value, '$[10]') / 100.0,
  json_extract(j.value, '$[11]'), json_extract(j.value, '$[12]') / 100.0, json_extract(j.value, '$[13]'), json_extract(j.value, '$[14]') / 100.0,
  json_extract(j.value, '$[15]'), json_extract(j.value, '$[16]')
FROM race_cards c JOIN races r ON r.id = c.race_id, json_each(c.rows) j;

-- 取り込み済みの競走成績（race_records）から、K の列と払戻金を作る（この移行の1回だけ）
-- rows の艇 = [着順, 枠番, 登録番号, モーター番号, ボート番号, 展示×100, 進入コース, ST×100, レースタイム×10]（src/lib/records.ts）
INSERT INTO race_boats (race_id, boat, race_date, jcd, rno, toban, place, place_mark, course, st, tenji, race_time)
SELECT k.race_id, json_extract(j.value, '$[1]'), r.race_date, r.jcd, r.rno, json_extract(j.value, '$[2]'),
  CASE WHEN json_type(j.value, '$[0]') = 'integer' THEN json_extract(j.value, '$[0]') END,
  CASE WHEN json_type(j.value, '$[0]') = 'text' THEN json_extract(j.value, '$[0]') END,
  json_extract(j.value, '$[6]'), json_extract(j.value, '$[7]') / 100.0, json_extract(j.value, '$[5]') / 100.0, json_extract(j.value, '$[8]') / 10.0
FROM race_records k JOIN races r ON r.id = k.race_id, json_each(k.rows) j WHERE 1
ON CONFLICT (race_id, boat) DO UPDATE SET place = excluded.place, place_mark = excluded.place_mark, course = excluded.course, st = excluded.st, tenji = excluded.tenji, race_time = excluded.race_time;

-- 払戻金 = [券種の番号, 組番, 払戻金, 人気]（券種の番号は src/lib/bets.ts の BET_TYPES の順）
INSERT OR IGNORE INTO race_payouts (race_id, race_date, jcd, bet_type, combo, payout, pop)
SELECT k.race_id, r.race_date, r.jcd,
  CASE json_extract(j.value, '$[0]') WHEN 0 THEN 'tansho' WHEN 1 THEN 'fukusho' WHEN 2 THEN 'nirentan' WHEN 3 THEN 'nirenpuku' WHEN 4 THEN 'kakurenpuku' WHEN 5 THEN 'sanrentan' ELSE 'sanrenpuku' END,
  json_extract(j.value, '$[1]'), json_extract(j.value, '$[2]'), json_extract(j.value, '$[3]')
FROM race_records k JOIN races r ON r.id = k.race_id, json_each(k.payouts) j;
