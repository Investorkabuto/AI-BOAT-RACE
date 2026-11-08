-- オッズの取得の枠に「締切の30分前（t30）」を足す（決定64の変更、2026-11-09 管理者決定）。
-- 全レースで30分前に取り、10分前（t10）と7分前（t7）は、申告（見送りを除く）か舟券があるレースだけ取る。
-- race_odds（0022）の slot の CHECK は変えられないので、新しい表に移す。0022 の表は取り込み初日の分だけなので移さずに消す
-- （どの文も何度流しても安全な形にしてある）
CREATE TABLE IF NOT EXISTS race_odds_v2 (
  race_id    TEXT NOT NULL,
  slot       TEXT NOT NULL CHECK (slot IN ('t30', 't10', 't7')),
  fetched_at TEXT NOT NULL,
  as_of      TEXT,
  data_json  TEXT NOT NULL,  -- {sanrentan: {"1-2-3": 9.1, ...}}（null は欠場などで発売なし）
  PRIMARY KEY (race_id, slot)
);
DROP TABLE IF EXISTS race_odds;
