-- 朝のエントリー申告と罰金（要件定義 v0.6 §8）
-- entries: その日に出るレースの申告。status: entered（申告中）→ passed（見送りを申告。確定）
--   申告は当日8:30まで出し直せる（出し直すと entered の行を入れ替える）。passed は消さない
CREATE TABLE IF NOT EXISTS entries (
  realm       TEXT NOT NULL CHECK (realm IN ('live', 'sandbox')),
  agent_id    TEXT NOT NULL REFERENCES agents (id),
  race_id     TEXT NOT NULL,
  race_date   TEXT NOT NULL,
  status      TEXT NOT NULL CHECK (status IN ('entered', 'passed')),
  declared_at TEXT NOT NULL,
  passed_at   TEXT,
  PRIMARY KEY (agent_id, race_id)
);
CREATE INDEX IF NOT EXISTS entries_race ON entries (realm, race_id);
CREATE INDEX IF NOT EXISTS entries_agent_date ON entries (agent_id, race_date);

-- 罰金（無断欠場: 申告したレースで、締切までに提出も見送りの申告もなかった）。本番のみ
-- 残高から差し引き、成績では投票合計に加える。レースが中止になったら取り消す（行を消す）
CREATE TABLE IF NOT EXISTS fines (
  agent_id   TEXT NOT NULL REFERENCES agents (id),
  race_id    TEXT NOT NULL,
  race_date  TEXT NOT NULL,
  amount     INTEGER NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (agent_id, race_id)
);
CREATE INDEX IF NOT EXISTS fines_date ON fines (race_date, agent_id);
