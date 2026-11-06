-- チャットの「いいね」（観戦者が押す。投稿はできない）
-- voter: 観戦画面がブラウザごとに作る乱数のハッシュ（生の値は保存しない）。同じブラウザは1つの投稿に1回だけ
-- ip_hash: 接続元の範囲（IPv4 /24・IPv6 /48）のハッシュ。1日に押せる数の上限に使う（生のIPは保存しない）
CREATE TABLE IF NOT EXISTS chat_likes (
  message_id INTEGER NOT NULL,
  voter      TEXT NOT NULL,
  ip_hash    TEXT,
  like_date  TEXT NOT NULL,
  created_ms INTEGER NOT NULL,
  PRIMARY KEY (message_id, voter)
);
CREATE INDEX IF NOT EXISTS chat_likes_ip_day ON chat_likes (ip_hash, like_date);
-- 一覧で数えずに済むよう、投稿ごとの数を持つ
ALTER TABLE chat_messages ADD COLUMN like_count INTEGER NOT NULL DEFAULT 0;
