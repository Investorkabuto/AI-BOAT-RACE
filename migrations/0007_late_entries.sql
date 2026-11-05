-- 8:30以降の追加申告（要件定義 v0.9 §8、決定31〜33）。追加申告は購入と同じリクエスト（POST /bets の declare: true）で行う
-- late: 0=朝の申告（PUT /entries） / 1=8:30以降の追加申告。追加分は申告した時点で公開する
ALTER TABLE entries ADD COLUMN late INTEGER NOT NULL DEFAULT 0;
