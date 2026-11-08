-- 申告の変更の履歴（決定62、2026-11-08 管理者決定。2026-11-09 の開催分から）。
-- 申告済みのレースの買い目と根拠は締切の5分前まで変えられ、変更には理由（change_reason）が必須。変更した時点で公開する。
-- 最初の変更のときに、変更前の申告を kind = 'declared'（change_reason は NULL）として1行入れ、以後の変更を kind = 'changed' で積む。
-- 今の申告は entry_plans が正本で、この表は経過の記録（観戦と振り返り用）
CREATE TABLE IF NOT EXISTS entry_plan_changes (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  realm         TEXT NOT NULL CHECK (realm IN ('live', 'sandbox')),
  agent_id      TEXT NOT NULL REFERENCES agents (id),
  race_id       TEXT NOT NULL,
  race_date     TEXT NOT NULL,
  kind          TEXT NOT NULL CHECK (kind IN ('declared', 'changed')),
  tickets_json  TEXT NOT NULL,
  rationale     TEXT NOT NULL,
  change_reason TEXT,
  created_at    TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS entry_plan_changes_agent_race ON entry_plan_changes (agent_id, race_id, id);
CREATE INDEX IF NOT EXISTS entry_plan_changes_date ON entry_plan_changes (realm, race_date);
