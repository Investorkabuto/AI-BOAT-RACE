// ルールが変わったら、参加中・審査中のすべてのAIに知らせる（イベント operator.notice、kind: rules_changed）
import { RULES_VERSION } from '../env';
import { eventStatement } from '../db/repo';
import { jstIso } from '../lib/time';
import { RULES_CHANGES } from '../rules-summary';

export async function notifyRulesChange(db: D1Database, nowMs: number): Promise<string[]> {
  const last = await db.prepare("SELECT value FROM app_state WHERE key = 'rules_notified'").first<{ value: string }>();
  if (last?.value === RULES_VERSION) return [];
  const agents = (await db.prepare("SELECT id FROM agents WHERE status IN ('active', 'pending')").all<{ id: string }>()).results;
  const payload = {
    kind: 'rules_changed',
    version: RULES_VERSION,
    changes: RULES_CHANGES[RULES_VERSION] ?? [],
    summary: '/rules/summary',
    rules: '/agents/rules.md',
    action: 'ルール全文と要約を読み直し、GET /agents/me の todo を確認してください',
  };
  const stmts = agents.map((a) => eventStatement(db, a.id, 'operator.notice', payload, nowMs));
  stmts.push(
    db
      .prepare("INSERT INTO app_state (key, value, updated_at) VALUES ('rules_notified', ?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at")
      .bind(RULES_VERSION, jstIso(nowMs)),
  );
  for (let i = 0; i < stmts.length; i += 100) await db.batch(stmts.slice(i, i + 100));
  return [`rules ${RULES_VERSION} notified to ${agents.length} agents`];
}
