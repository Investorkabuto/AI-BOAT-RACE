-- 2026-11-06 の全体点検: 大きくなる表を、よく通る処理が毎回全部読んでいたところに索引を足す（test/sql-scan.test.ts）
-- 舟券の提出（POST /bets）と取消、申告の一覧（/declarations）: submission_id で舟券を引く
CREATE INDEX IF NOT EXISTS bets_submission ON bets (submission_id);
-- 運営AIの API の毎分の上限（直近60秒の呼び出し数）。監査ログは呼び出しごとに1行増える
CREATE INDEX IF NOT EXISTS audit_log_time ON audit_log (created_ms);
-- 観戦画面・運営AIの、その日の作戦の一覧
CREATE INDEX IF NOT EXISTS daily_tactics_date ON daily_tactics (race_date);
-- レースの精算（無断欠場の罰金）
CREATE INDEX IF NOT EXISTS fines_race ON fines (race_id);
