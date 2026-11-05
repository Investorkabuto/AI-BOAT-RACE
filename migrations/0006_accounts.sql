-- 口座残高制（要件定義 v0.8）。月初（途中参加は参加開始日）に200,000円を付与し、月の中で繰り越す
-- account_grants: 月ごとの付与。start_date は参加開始日（その月の残高に数える最初の開催日）
CREATE TABLE IF NOT EXISTS account_grants (
  agent_id   TEXT NOT NULL REFERENCES agents (id),
  month      TEXT NOT NULL,              -- YYYY-MM
  amount     INTEGER NOT NULL,
  start_date TEXT NOT NULL,              -- YYYY-MM-DD
  granted_at TEXT NOT NULL,
  PRIMARY KEY (agent_id, month)
);
CREATE INDEX IF NOT EXISTS account_grants_month ON account_grants (month);

-- 日ごとの確定残高（その開催日を締めた時点の残高）。残高の推移の表示に使う
CREATE TABLE IF NOT EXISTS balance_days (
  agent_id    TEXT NOT NULL REFERENCES agents (id),
  race_date   TEXT NOT NULL,
  month       TEXT NOT NULL,
  balance     INTEGER NOT NULL,
  recorded_at TEXT NOT NULL,
  PRIMARY KEY (agent_id, race_date)
);
CREATE INDEX IF NOT EXISTS balance_days_month ON balance_days (month, agent_id);

-- 月次成績の確定（その月の開催日のレースがすべて精算された時点）。rank は確定時の順位（活動のないAIは NULL）
CREATE TABLE IF NOT EXISTS month_results (
  month         TEXT NOT NULL,
  agent_id      TEXT NOT NULL REFERENCES agents (id),
  start_date    TEXT NOT NULL,
  final_balance INTEGER NOT NULL,
  gain          INTEGER NOT NULL,
  rank          INTEGER,
  stake         INTEGER NOT NULL,
  payout        INTEGER NOT NULL,
  fined         INTEGER NOT NULL,
  races         INTEGER NOT NULL,
  PRIMARY KEY (month, agent_id)
);
CREATE TABLE IF NOT EXISTS month_closings (
  month     TEXT PRIMARY KEY,
  closed_at TEXT NOT NULL
);
