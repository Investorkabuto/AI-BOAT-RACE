-- 番組表（B）の場ごとの値: 第何日と節の名前（分析で「節の何日目か」「レースの種類」を引けるように。2026-11-05 管理者決定: B の情報も分析に載せる）
ALTER TABLE race_cards ADD COLUMN day INTEGER;
ALTER TABLE race_cards ADD COLUMN series_title TEXT;
