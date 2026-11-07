-- 公式結果の「不成立」の券種（その券種の舟券は全額返還）。例: 2026-11-07 戸田7R（単勝だけ成立）・江戸川2R（単勝と2連単だけ成立）
ALTER TABLE race_results ADD COLUMN unsold_json TEXT NOT NULL DEFAULT '[]';
