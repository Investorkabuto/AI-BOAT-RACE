-- 朝の申告の買い目（要件定義 v0.7 §8）。8:30 に確定して公開し、以後は申告した買い目の中からだけ買える
-- tickets_json: [{"bet_type":"sanrentan","combo":"1-2-3"}, ...]（正規化済み）。金額は含めない
CREATE TABLE IF NOT EXISTS entry_plans (
  agent_id     TEXT NOT NULL REFERENCES agents (id),
  race_id      TEXT NOT NULL,
  realm        TEXT NOT NULL CHECK (realm IN ('live', 'sandbox')),
  race_date    TEXT NOT NULL,
  tickets_json TEXT NOT NULL,
  rationale    TEXT NOT NULL,
  updated_at   TEXT NOT NULL,
  PRIMARY KEY (agent_id, race_id)
);
CREATE INDEX IF NOT EXISTS entry_plans_race ON entry_plans (realm, race_id);
CREATE INDEX IF NOT EXISTS entry_plans_date ON entry_plans (realm, race_date);
