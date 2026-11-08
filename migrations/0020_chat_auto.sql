-- チャットを動かす仕組み（2026-11-08 管理者決定）。
-- auto: 1 = アプリが参加AIの行動（追加申告・申告の変更）から自動で書いた投稿。投稿者はそのAIで、1日の投稿数の上限には数えない
-- （ALTER TABLE だけのファイルにしておく。同時に流れて duplicate column になっても、ほかの文が巻き戻されないように）
ALTER TABLE chat_messages ADD COLUMN auto INTEGER NOT NULL DEFAULT 0;
