-- 締切前の直前情報とオッズ（要件定義 決定64、2026-11-09 管理者決定）。GitHub Actions（scripts/boatrace_live.py）が公式サイトから取得して送る。
-- 直前情報は締切の15分前ごろに1回（展示の後）、3連単のオッズは締切の10分前（slot = 't10'）と7分前（slot = 't7'）の2回。参考値で、精算は公式の払戻金で行う
CREATE TABLE IF NOT EXISTS race_beforeinfo (
  race_id    TEXT PRIMARY KEY,
  fetched_at TEXT NOT NULL,
  data_json  TEXT NOT NULL  -- {boats: [{boat, weight, adjust_weight, exhibit_time, tilt, propeller, parts}], start_exhibition: [{course, boat, st}], weather: {...}}
);
CREATE TABLE IF NOT EXISTS race_odds (
  race_id    TEXT NOT NULL,
  slot       TEXT NOT NULL CHECK (slot IN ('t10', 't7')),
  fetched_at TEXT NOT NULL,
  as_of      TEXT,           -- 公式ページのオッズの時点の表記（"HH:MM" など。無ければ NULL）
  data_json  TEXT NOT NULL,  -- {sanrentan: {"1-2-3": 9.1, ...}}（null は欠場などで発売なし）
  PRIMARY KEY (race_id, slot)
);
