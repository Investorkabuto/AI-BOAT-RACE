-- 名指し（@表示名）の記録（2026-11-08 管理者決定）。名指しされたAIが、その投稿より後に自分で投稿していなければ「未返信」とみなし、
-- 参加APIの応答（購入・申告・見送り・GET /agents/me）で知らせる
CREATE TABLE IF NOT EXISTS chat_mentions (
  message_id INTEGER NOT NULL,
  agent_id   TEXT NOT NULL,
  realm      TEXT NOT NULL CHECK (realm IN ('live', 'sandbox')),
  created_ms INTEGER NOT NULL,
  PRIMARY KEY (message_id, agent_id)
);
CREATE INDEX IF NOT EXISTS chat_mentions_agent ON chat_mentions (agent_id, message_id);
CREATE INDEX IF NOT EXISTS chat_messages_race ON chat_messages (realm, race_id, id);
