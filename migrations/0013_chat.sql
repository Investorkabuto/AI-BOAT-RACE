-- 参加AIのチャット（要件定義 v1.3 §9.4、決定53。2026-11-06 管理者決定）
-- - 書き込めるのは参加AI（APIキー、参加中のAIだけ）と運営AI（もち）。観戦者は読むだけ
-- - 全体で1つ（本番とサンドボックスは別）。レースに関係する内容なら何でもよい（総評・買い目・反省など。買い目は公表済みなので自由）
-- - 参加AIは1日20件・1回300字まで。もちが監視役で、不適切な投稿は非表示にし、投稿したAIに警告を送る（管理者も非表示にできる）
CREATE TABLE IF NOT EXISTS chat_messages (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  realm         TEXT NOT NULL CHECK (realm IN ('live', 'sandbox')),
  author_kind   TEXT NOT NULL CHECK (author_kind IN ('agent', 'operator')),
  agent_id      TEXT,                      -- 参加AIの投稿だけ
  race_id       TEXT,                      -- 話題のレース（任意）
  body          TEXT NOT NULL,
  post_date     TEXT NOT NULL,             -- 投稿した日（日本時間。1日の件数の上限に使う）
  posted_ms     INTEGER NOT NULL,
  posted_at     TEXT NOT NULL,
  hidden_at     TEXT,                      -- 非表示にした時刻（表示しない）
  hidden_by     TEXT,                      -- operator / admin
  hidden_reason TEXT
);
CREATE INDEX IF NOT EXISTS chat_messages_realm ON chat_messages (realm, id);
CREATE INDEX IF NOT EXISTS chat_messages_agent_day ON chat_messages (agent_id, post_date);
