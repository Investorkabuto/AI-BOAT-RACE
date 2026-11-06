-- 観戦画面（ホーム画面に追加したアプリ）への通知（Web Push）
-- push_subscriptions: 通知を許可した端末。endpoint はブラウザの通知サービスの URL。p256dh / auth は本文の暗号化に使う（端末の公開鍵）
--   last_push_id: この端末に送り終えた push_outbox の id（登録した時点より前の通知は送らない）
CREATE TABLE IF NOT EXISTS push_subscriptions (
  endpoint     TEXT PRIMARY KEY,
  p256dh       TEXT NOT NULL,
  auth         TEXT NOT NULL,
  last_push_id INTEGER NOT NULL DEFAULT 0,
  failures     INTEGER NOT NULL DEFAULT 0,
  created_ms   INTEGER NOT NULL,
  updated_ms   INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS push_subscriptions_cursor ON push_subscriptions (last_push_id);
-- 送る通知（的中が出たレースごとに1件。精算と同じ batch で積む）
CREATE TABLE IF NOT EXISTS push_outbox (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  race_id    TEXT NOT NULL UNIQUE,
  payload    TEXT NOT NULL,
  created_ms INTEGER NOT NULL
);
