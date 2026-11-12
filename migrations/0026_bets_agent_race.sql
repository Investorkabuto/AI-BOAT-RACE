-- 舟券を「AI×レース」で引く索引（2026-11-12）。参加者ページ（GET /roster/{id}・/roster/{id}/races）・申告の一覧（GET /declarations）・
-- レース詳細の申告（GET /races/{id}）は、申告1件ごとに bets を agent_id と race_id で引く相関サブクエリを持つ。
-- この索引が無いと bets_agent_date (agent_id) でそのAIの舟券を全期間たどり、読み取りが舟券の数に比例して増えていた
-- （計測 GET /operator/d1-usage: GET /roster/:id/races は1回あたり 46,073 → 60,330 → 81,598 行と日ごとに増加）
CREATE INDEX IF NOT EXISTS bets_agent_race ON bets (agent_id, race_id, status);
