-- 番組表（Bファイル）の出走表と基礎数値（要件定義 v1.0 系統1、v1.2 の詰めた保存形）
-- race_cards: レースごとの最新の版。rows は6艇分の配列（src/lib/cards.ts の CardRow の順。勝率・2連率は ×100 の整数）
-- race_card_history: 版が変わったときの旧版。基礎数値は「その日のBファイルの版」をそのまま残し、後の値で上書きしない（予想時点の値だけで検証できるように）
CREATE TABLE IF NOT EXISTS race_cards (
  race_id      TEXT PRIMARY KEY REFERENCES races (id),
  fixed_course INTEGER NOT NULL,   -- 進入固定のレース
  distance     INTEGER,            -- 距離（m）
  rows         TEXT NOT NULL,
  fetched_at   TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS race_card_history (
  race_id      TEXT NOT NULL,
  fetched_at   TEXT NOT NULL,      -- その版を取り込んだ時刻
  fixed_course INTEGER NOT NULL,
  distance     INTEGER,
  rows         TEXT NOT NULL,
  PRIMARY KEY (race_id, fetched_at)
);
