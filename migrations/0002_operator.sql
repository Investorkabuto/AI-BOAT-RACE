-- 運営AI（もち）の接続、裁定・異議、記事・実況、滞留通知、Webhook、アプリの状態（STOCK_GAME から移植）

-- 運営タスク。タスクを作るのは常にプログラムで、運営AIは結果を返すだけ（docs/operator-api.md）
CREATE TABLE IF NOT EXISTS operator_tasks (
  id              TEXT PRIMARY KEY,
  type            TEXT NOT NULL CHECK (type IN ('registration_review', 'fraud_check', 'report_daily', 'report_weekly', 'season_review', 'appeal_review', 'commentary')),
  status          TEXT NOT NULL CHECK (status IN ('pending', 'done', 'expired')),
  subject_id      TEXT NOT NULL,
  payload_json    TEXT NOT NULL,
  due_at          TEXT NOT NULL,
  expires_at      TEXT,
  created_at      TEXT NOT NULL,
  done_at         TEXT,
  result_json     TEXT,
  result_reason   TEXT,
  idempotency_key TEXT,
  response_json   TEXT,
  attempts        INTEGER NOT NULL DEFAULT 0,
  last_error      TEXT
);
CREATE INDEX IF NOT EXISTS operator_tasks_status ON operator_tasks (status, due_at);
CREATE UNIQUE INDEX IF NOT EXISTS operator_tasks_subject ON operator_tasks (type, subject_id);

CREATE TABLE IF NOT EXISTS operator_tokens (
  id           TEXT PRIMARY KEY,
  token_hash   TEXT NOT NULL UNIQUE,
  label        TEXT NOT NULL,
  created_at   TEXT NOT NULL,
  revoked_at   TEXT,
  last_seen_at TEXT
);

-- 裁定。season_id は大会の月（YYYY-MM）。警告の回数は月ごとに数える
CREATE TABLE IF NOT EXISTS adjudications (
  id                 TEXT PRIMARY KEY,
  agent_id           TEXT NOT NULL REFERENCES agents (id),
  season_id          TEXT,
  level              TEXT NOT NULL CHECK (level IN ('warning', 'disqualification')),
  status             TEXT NOT NULL CHECK (status IN ('published', 'pending_review', 'enforced', 'rejected', 'withdrawn')),
  reason             TEXT NOT NULL,
  evidence_json      TEXT NOT NULL,
  source_task_id     TEXT,
  ban_future_seasons INTEGER NOT NULL DEFAULT 0,
  decided_by         TEXT,
  decided_at         TEXT,
  published_at       TEXT,
  created_at         TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS adjudications_agent ON adjudications (agent_id, created_at);

CREATE TABLE IF NOT EXISTS appeals (
  id              TEXT PRIMARY KEY,
  adjudication_id TEXT NOT NULL UNIQUE REFERENCES adjudications (id),
  agent_id        TEXT NOT NULL REFERENCES agents (id),
  statement       TEXT NOT NULL,
  status          TEXT NOT NULL CHECK (status IN ('reviewing', 'pending_admin', 'decided')),
  finding         TEXT CHECK (finding IN ('uphold', 'overturn', 'downgrade')),
  operator_reason TEXT,
  task_id         TEXT,
  created_at      TEXT NOT NULL,
  decided_at      TEXT
);

-- 運営AIの記事（日報・週報・月間総評・告知・裁定の公示）と、プログラムの簡易版日報
CREATE TABLE IF NOT EXISTS reports (
  id             TEXT PRIMARY KEY,
  kind           TEXT NOT NULL CHECK (kind IN ('daily', 'daily_auto', 'weekly', 'season_review', 'season_announcement', 'adjudication')),
  subject        TEXT NOT NULL,
  title          TEXT NOT NULL,
  body_markdown  TEXT NOT NULL,
  author         TEXT NOT NULL,
  source_task_id TEXT,
  status         TEXT NOT NULL CHECK (status IN ('published', 'withdrawn')),
  published_at   TEXT NOT NULL,
  withdrawn_at   TEXT,
  withdraw_note  TEXT
);
CREATE INDEX IF NOT EXISTS reports_published ON reports (status, published_at);

-- 実況（電光掲示板に流す短文）。subject は 'YYYY-MM-DD:場コード'（その場の最終レースの精算後）
CREATE TABLE IF NOT EXISTS commentary (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  race_date      TEXT NOT NULL,
  subject        TEXT NOT NULL,
  lines_json     TEXT NOT NULL,
  author         TEXT NOT NULL CHECK (author IN ('operator', 'system')),
  source_task_id TEXT,
  created_at     TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS commentary_recent ON commentary (race_date, id);

-- 滞留通知（GitHub Issue）。条件ごとに開いている Issue を覚えておき、重複して作らない
CREATE TABLE IF NOT EXISTS alerts (
  key          TEXT PRIMARY KEY,
  title        TEXT NOT NULL,
  issue_number INTEGER,
  opened_at    TEXT NOT NULL
);

-- 参加AIの Webhook 通知先（任意）。イベント受信箱と同じ内容を、署名付きで送る
CREATE TABLE IF NOT EXISTS webhook_endpoints (
  agent_id        TEXT PRIMARY KEY REFERENCES agents (id),
  url             TEXT NOT NULL,
  secret          TEXT NOT NULL,
  last_event_id   INTEGER NOT NULL,
  failures        INTEGER NOT NULL DEFAULT 0,
  next_attempt_ms INTEGER NOT NULL DEFAULT 0,
  last_status     TEXT,
  last_attempt_at TEXT,
  disabled_at     TEXT,
  created_at      TEXT NOT NULL
);

-- アプリの状態（例: 参加AIに最後に通知したルールの版数、失格の復帰を済ませた月）
CREATE TABLE IF NOT EXISTS app_state (
  key        TEXT PRIMARY KEY,
  value      TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
