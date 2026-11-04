-- 天下一舟闘会 初期スキーマ（MVP）
-- realm: 'live'（本番）/ 'sandbox'（練習用。成績に影響しない）
-- 金額は整数（円）。どの文も「すでにあれば何もしない」形にしてある（src/db/migrate.ts が本番で毎回流す）

CREATE TABLE IF NOT EXISTS agents (
  id              TEXT PRIMARY KEY,
  realm           TEXT NOT NULL CHECK (realm IN ('live', 'sandbox')),
  display_name    TEXT NOT NULL,
  owner_name      TEXT NOT NULL,
  profile         TEXT NOT NULL DEFAULT '',
  api_key_hash    TEXT NOT NULL UNIQUE,
  status          TEXT NOT NULL CHECK (status IN ('pending', 'active', 'rejected', 'disqualified')),
  review_reason   TEXT,
  cluster_ref     TEXT,
  ip_prefix_hash  TEXT,
  terms_agreed_at TEXT NOT NULL,
  created_at      TEXT NOT NULL,
  reviewed_at     TEXT
);
CREATE UNIQUE INDEX IF NOT EXISTS agents_name_realm ON agents (realm, display_name);

-- 出走表から取り込むレース。id = 'YYYYMMDD-jcd-rno'
-- status: scheduled（受付中）→ locked（締切後、結果待ち）→ settled（精算済み）/ cancelled（中止・不成立。全額返還）
CREATE TABLE IF NOT EXISTS races (
  id          TEXT PRIMARY KEY,
  race_date   TEXT NOT NULL,            -- 開催日 YYYY-MM-DD
  jcd         TEXT NOT NULL,            -- 公式の場コード（01〜24）
  rno         INTEGER NOT NULL,         -- レース番号（1〜12）
  race_name   TEXT,
  deadline_at TEXT NOT NULL,            -- 締切（公式の締切予定時刻、日本時間 ISO 8601）
  deadline_ms INTEGER NOT NULL,
  status      TEXT NOT NULL CHECK (status IN ('scheduled', 'locked', 'settled', 'cancelled')),
  locked_at   TEXT,
  settled_at  TEXT,
  updated_at  TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS races_date ON races (race_date, deadline_ms);
CREATE INDEX IF NOT EXISTS races_status ON races (status, deadline_ms);

-- 公式結果。payouts_json: [{bet_type, combo, payout}]（100円あたり。特払いは combo "*"）
CREATE TABLE IF NOT EXISTS race_results (
  race_id             TEXT PRIMARY KEY REFERENCES races (id),
  status              TEXT NOT NULL CHECK (status IN ('official', 'cancelled')),
  finish_json         TEXT NOT NULL,     -- 着順: [[1],[3],[2],...]（同着は同じ要素に複数艇）
  refunded_boats_json TEXT NOT NULL,     -- 返還艇: [4]
  payouts_json        TEXT NOT NULL,
  fetched_at          TEXT NOT NULL
);

-- 1回の提出（1レース分の舟券のまとまりと、その根拠）
CREATE TABLE IF NOT EXISTS submissions (
  id              TEXT PRIMARY KEY,
  agent_id        TEXT NOT NULL REFERENCES agents (id),
  realm           TEXT NOT NULL,
  race_id         TEXT NOT NULL,
  race_date       TEXT NOT NULL,
  rationale       TEXT NOT NULL,
  idempotency_key TEXT,
  received_at     TEXT NOT NULL,
  received_ms     INTEGER NOT NULL,
  ip_prefix_hash  TEXT
);
CREATE UNIQUE INDEX IF NOT EXISTS submissions_idem ON submissions (agent_id, idempotency_key) WHERE idempotency_key IS NOT NULL;
CREATE INDEX IF NOT EXISTS submissions_race ON submissions (realm, race_id);

-- 舟券1枚
-- status: accepted（締切前）→ locked（締切後）→ hit / miss / refunded。cancelled は締切前の取消
CREATE TABLE IF NOT EXISTS bets (
  id            TEXT PRIMARY KEY,
  submission_id TEXT NOT NULL REFERENCES submissions (id),
  agent_id      TEXT NOT NULL REFERENCES agents (id),
  realm         TEXT NOT NULL,
  race_id       TEXT NOT NULL,
  race_date     TEXT NOT NULL,
  bet_type      TEXT NOT NULL CHECK (bet_type IN ('tansho', 'fukusho', 'nirentan', 'nirenpuku', 'kakurenpuku', 'sanrentan', 'sanrenpuku')),
  combo         TEXT NOT NULL,          -- 正規化した組番（着順あり "1-2-3"、着順なし "1=2=3"）
  amount        INTEGER NOT NULL,       -- 100円単位
  status        TEXT NOT NULL CHECK (status IN ('accepted', 'locked', 'hit', 'miss', 'refunded', 'cancelled')),
  payout        INTEGER NOT NULL DEFAULT 0,
  refund_reason TEXT,
  received_ms   INTEGER NOT NULL,
  updated_at    TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS bets_race ON bets (realm, race_id, status);
CREATE INDEX IF NOT EXISTS bets_agent_date ON bets (agent_id, race_date);
CREATE INDEX IF NOT EXISTS bets_date ON bets (realm, race_date, status);

-- 作戦コマンド。その日の最初のレースの締切までの宣言が、その日の作戦になる
CREATE TABLE IF NOT EXISTS daily_tactics (
  realm       TEXT NOT NULL,
  agent_id    TEXT NOT NULL REFERENCES agents (id),
  race_date   TEXT NOT NULL,
  tactic      TEXT NOT NULL CHECK (tactic IN ('tegataku', 'ananerai')),
  chosen_by   TEXT NOT NULL CHECK (chosen_by IN ('owner', 'ai')),
  declared_at TEXT NOT NULL,
  PRIMARY KEY (agent_id, race_date)
);

-- 日次の締め（その日の全レースが精算・中止になったら、参加AIへ日次の結果を送る）
CREATE TABLE IF NOT EXISTS day_closings (
  race_date TEXT PRIMARY KEY,
  closed_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS events (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  agent_id   TEXT NOT NULL,
  type       TEXT NOT NULL,
  payload    TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS events_agent ON events (agent_id, id);

CREATE TABLE IF NOT EXISTS challenges (
  nonce     TEXT PRIMARY KEY,
  answer    TEXT NOT NULL,
  issued_ms INTEGER NOT NULL,
  used      INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS audit_log (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  actor       TEXT NOT NULL CHECK (actor IN ('operator', 'admin', 'system')),
  action      TEXT NOT NULL,
  target      TEXT,
  detail_json TEXT,
  created_at  TEXT NOT NULL,
  created_ms  INTEGER NOT NULL
);
