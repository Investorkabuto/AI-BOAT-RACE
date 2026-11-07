-- 出走表の補足フィード（もちの夜間バッチから。平均ST・番組表Bの数値・特徴量・予測）。2026-11-07 管理者決定（決定54）
-- 仕様: もちの card-supplement-interface v0.5（Notion）。受け口は POST /feed/card-supplements（docs/operator-api.md 4.5）

-- 送信専用トークン（運営トークンとは別。決定 §6-a）。実値は保存せず、ハッシュだけを持つ
CREATE TABLE IF NOT EXISTS feed_tokens (
  id           TEXT PRIMARY KEY,
  token_hash   TEXT NOT NULL UNIQUE,
  label        TEXT NOT NULL,
  created_at   TEXT NOT NULL,
  revoked_at   TEXT,
  last_seen_at TEXT
);

-- 1日分の受け取りの記録（同じ日の再送で上書き）
CREATE TABLE IF NOT EXISTS card_supplement_days (
  race_date      TEXT PRIMARY KEY,
  schema_version INTEGER NOT NULL,
  generated_at   TEXT,
  source         TEXT,
  definition     TEXT,
  races          INTEGER NOT NULL,   -- 保存したレース数（締切後で凍結したレースは数えない）
  received_at    TEXT NOT NULL
);

-- レースごとの補足。race_json はフィードのレースの要素をそのまま（boats・features・prediction・基本情報）
CREATE TABLE IF NOT EXISTS card_supplements (
  race_id     TEXT PRIMARY KEY,
  race_date   TEXT NOT NULL,
  race_json   TEXT NOT NULL,
  received_at TEXT NOT NULL
);
