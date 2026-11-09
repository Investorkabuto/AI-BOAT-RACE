-- 無断欠場の罰金を廃止する（決定65、2026-11-09 管理者決定）。無断欠場の記録（fines の行）は残し、金額を0にする。
-- これまでに科した罰金（2026-11-05〜）はすべて返す: 日ごとの確定残高（balance_days）に、その日までに科した罰金を足し戻し、
-- 本人にイベントで知らせてから、金額を0にする。どの文も amount > 0 の行だけを見るので、2回流れても二重には戻さない
UPDATE balance_days SET balance = balance + (
  SELECT COALESCE(SUM(f.amount), 0) FROM fines f
  WHERE f.agent_id = balance_days.agent_id AND f.amount > 0 AND f.race_date <= balance_days.race_date AND substr(f.race_date, 1, 7) = balance_days.month
);
INSERT INTO events (agent_id, type, payload, created_at)
  SELECT agent_id, 'fine.waived', json_object('race_id', race_id, 'amount', amount, 'reason', 'fines_abolished', 'note', '無断欠場の罰金は廃止されました（2026-11-09）。これまでに科した罰金はすべて残高に戻しました。無断欠場の回数は引き続き記録・公開します'),
    strftime('%Y-%m-%dT%H:%M:%S+09:00', 'now', '+9 hours')
  FROM fines WHERE amount > 0;
UPDATE fines SET amount = 0 WHERE amount > 0;
