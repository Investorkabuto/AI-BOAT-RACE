-- 要件定義 v1.3（決定50〜52）: 保存の見直しと分析の事前集計
--
-- 1. 二重保存の解消（決定51）: race_cards.rows・race_records.rows・payouts（詰めた形）は、race_boats・race_payouts を正本にして空（''）にする。
--    - 締切前の番組表（版の比較と race_card_history のため）と、直近数日の競走成績（公式の訂正との比較と race_record_history のため）だけ詰めた形を持ち、
--      それを過ぎたら定時処理（src/jobs/compact.ts）が race_boats・race_payouts に全て入っていることを確かめてから空にする。
--      D1 の書き込みの上限（1日10万行）を超えないよう、1日の量に上限を設けて少しずつ進める
--    - 過去分の取り込み（PUT /internal/history）は、はじめから詰めた形を書かない
-- 2. race_boats.k_motor_no・k_boat_no: Kファイルのモーター・ボート番号が番組表（B）と違うときだけ入れる（同じなら NULL）。
--    B の取り込み後にモーターが替わったレースで、競走成績の番号と、実際に乗ったモーターの集計を正しく出すため
-- 3. 事前集計の表（決定50）: 月ごとの小さな表。src/jobs/aggregate.ts が月単位で作り直す（ym = 'YYYY-MM'）
-- 4. 事前集計に置き換わる索引（場×コース、モーター）を削る（決定52）。日付と登録番号の索引、払戻金の索引は残す
ALTER TABLE race_boats ADD COLUMN k_motor_no INTEGER;
ALTER TABLE race_boats ADD COLUMN k_boat_no INTEGER;

DROP INDEX IF EXISTS race_boats_venue_course;
DROP INDEX IF EXISTS race_boats_motor;

-- 選手×コース×月。出走（欠場を除く）、1〜3着の数、ST（F・L・欠場を除く）の合計と件数、F の数と F の ST の合計、L の数
-- 平均ST の F の扱いは未確定（§9.1）なので、F を含める・除くのどちらでも出せる形で持つ
CREATE TABLE IF NOT EXISTS agg_racer_course (
  toban    TEXT NOT NULL,
  ym       TEXT NOT NULL,
  course   INTEGER NOT NULL,
  n        INTEGER NOT NULL,
  w1       INTEGER NOT NULL,
  w2       INTEGER NOT NULL,
  w3       INTEGER NOT NULL,
  st_sum   REAL NOT NULL,
  st_n     INTEGER NOT NULL,
  f_n      INTEGER NOT NULL,
  f_st_sum REAL NOT NULL,
  l_n      INTEGER NOT NULL,
  PRIMARY KEY (toban, ym, course)
);
CREATE INDEX IF NOT EXISTS agg_racer_course_ym ON agg_racer_course (ym);

-- モーター（場×番号）×月。番号は実際に乗ったもの（K の番号が B と違えば K）。展示順位はレース内の展示タイムの順位（同タイムは同順位）
CREATE TABLE IF NOT EXISTS agg_motor (
  jcd        TEXT NOT NULL,
  motor_no   INTEGER NOT NULL,
  ym         TEXT NOT NULL,
  n          INTEGER NOT NULL,
  w1         INTEGER NOT NULL,
  w2         INTEGER NOT NULL,
  w3         INTEGER NOT NULL,
  tenji_rank_sum INTEGER NOT NULL,
  tenji_n    INTEGER NOT NULL,
  PRIMARY KEY (jcd, motor_no, ym)
);
CREATE INDEX IF NOT EXISTS agg_motor_ym ON agg_motor (ym);

-- 場×コース×月
CREATE TABLE IF NOT EXISTS agg_venue_course (
  jcd    TEXT NOT NULL,
  ym     TEXT NOT NULL,
  course INTEGER NOT NULL,
  n      INTEGER NOT NULL,
  w1     INTEGER NOT NULL,
  w2     INTEGER NOT NULL,
  w3     INTEGER NOT NULL,
  PRIMARY KEY (jcd, ym, course)
);

-- 場×コース×月×決まり手（1着の艇の進入コースで数える）
CREATE TABLE IF NOT EXISTS agg_venue_kimarite (
  jcd      TEXT NOT NULL,
  ym       TEXT NOT NULL,
  course   INTEGER NOT NULL,
  kimarite TEXT NOT NULL,             -- 不明は ''
  n        INTEGER NOT NULL,
  PRIMARY KEY (jcd, ym, course, kimarite)
);

-- 券種×月の配当の分布: 価格帯（band = 100円あたりの払戻金の下限）×人気（11 は 11番人気以下、0 は人気なし）。特払いは除く
CREATE TABLE IF NOT EXISTS agg_payout (
  bet_type   TEXT NOT NULL,
  ym         TEXT NOT NULL,
  band       INTEGER NOT NULL,
  pop        INTEGER NOT NULL,
  n          INTEGER NOT NULL,
  payout_sum INTEGER NOT NULL,
  PRIMARY KEY (bet_type, ym, band, pop)
);

-- 集計の状態: どの表のどの月を作り直す必要があるか（dirty_at > built_at、または built_at が無い）
CREATE TABLE IF NOT EXISTS agg_months (
  kind     TEXT NOT NULL,             -- racer_course / motor / venue_course / payout
  ym       TEXT NOT NULL,
  dirty_at TEXT NOT NULL,             -- 作り直しの印を付けた時刻（UTC の ISO、ミリ秒まで）
  built_at TEXT,                      -- 作り直したときに読んだ dirty_at
  PRIMARY KEY (kind, ym)
);
