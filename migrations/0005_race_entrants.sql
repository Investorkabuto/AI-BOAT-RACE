-- 出走表の選手の基本情報（要件定義 §6、2026-11-04 管理者決定 A）。枠番・登録番号・氏名・級別・支部・年齢だけを持つ。
-- モーター・ボート・展示・直前情報・成績などは持たない（参加AIが各自で取得する）
-- entrants_json: [{"boat":1,"toban":"4444","name":"山田 太郎","grade":"A1","branch":"東京","age":34}, ...]
CREATE TABLE IF NOT EXISTS race_entrants (
  race_id       TEXT PRIMARY KEY REFERENCES races (id),
  entrants_json TEXT NOT NULL,
  updated_at    TEXT NOT NULL
);
