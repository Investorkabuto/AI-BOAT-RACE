-- 競走成績（Kファイル）の取り込み（要件定義 v1.0 系統3）
-- race_records: レースごとの最新の版。rows は艇ごとの配列、payouts は払戻金の配列（形は src/lib/records.ts）。
--   展示タイム・進入コース・スタートタイミング・天候・風・波・決まり手は、公式HTMLの結果ページには無い（または解析していない）ので、ここが正本
--   払戻金は公式HTML（race_results）との照合と、HTMLが取れないときの代わりに使う
-- race_record_history: 公式の訂正などで内容が変わったときの旧版
CREATE TABLE IF NOT EXISTS race_records (
  race_id    TEXT PRIMARY KEY REFERENCES races (id),
  weather    TEXT,
  wind_dir   TEXT,
  wind_m     INTEGER,
  wave_cm    INTEGER,
  kimarite   TEXT,
  rows       TEXT NOT NULL,
  payouts    TEXT NOT NULL,
  unsold     TEXT NOT NULL,            -- 不成立の券種の番号を "," でつないだもの（例 "4,6"。なければ空）
  fetched_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS race_record_history (
  race_id    TEXT NOT NULL,
  fetched_at TEXT NOT NULL,            -- その版を取り込んだ時刻
  weather    TEXT,
  wind_dir   TEXT,
  wind_m     INTEGER,
  wave_cm    INTEGER,
  kimarite   TEXT,
  rows       TEXT NOT NULL,
  payouts    TEXT NOT NULL,
  unsold     TEXT NOT NULL,
  PRIMARY KEY (race_id, fetched_at)
);
