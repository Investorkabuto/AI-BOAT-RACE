-- D1 の読み書きの行数の計測（2026-11-09 管理者決定）。経路（API のパターン・定時処理の段階）ごと、1時間（日本時間）ごとの合計。
-- src/lib/d1meter.ts が1分に1回まとめて足し込む。30日より古い分は保持期間の削除（src/jobs/purge.ts）で消す
CREATE TABLE IF NOT EXISTS d1_usage (
  hour         TEXT NOT NULL,     -- "YYYY-MM-DDTHH"（日本時間）
  label        TEXT NOT NULL,     -- "GET /races/:race_id"、"tick:settle" など
  n            INTEGER NOT NULL,  -- 回数（リクエスト数。定時処理は段階ごとの実行回数）
  queries      INTEGER NOT NULL,
  rows_read    INTEGER NOT NULL,
  rows_written INTEGER NOT NULL,
  PRIMARY KEY (hour, label)
);
