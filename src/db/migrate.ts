// 本番 D1 のスキーマを、アプリ自身が最新に揃える（定時処理と、各インスタンスの最初のリクエストで実行）。
// migrations/*.sql はどの文も「すでにあれば何もしない」形なので、何度流しても安全（ALTER TABLE を含むものは schema_migrations で1回だけ流す）。
// 新しいマイグレーションを足すときは、migrations/ にファイルを置き、下の MIGRATIONS に import を追加する
import init from '../../migrations/0001_init.sql';
import operator from '../../migrations/0002_operator.sql';
import entries from '../../migrations/0003_entries.sql';
import entryPlans from '../../migrations/0004_entry_plans.sql';
import raceEntrants from '../../migrations/0005_race_entrants.sql';
import accounts from '../../migrations/0006_accounts.sql';
import lateEntries from '../../migrations/0007_late_entries.sql';
import raceCards from '../../migrations/0008_race_cards.sql';
import raceRecords from '../../migrations/0009_race_records.sql';
import raceBoats from '../../migrations/0010_race_boats.sql';
import cardSeries from '../../migrations/0011_card_series.sql';
import compactAgg from '../../migrations/0012_compact_agg.sql';
import chat from '../../migrations/0013_chat.sql';
import scanIndexes from '../../migrations/0014_scan_indexes.sql';
import chatLikes from '../../migrations/0015_chat_likes.sql';
import push from '../../migrations/0016_push.sql';
import cardSupplements from '../../migrations/0017_card_supplements.sql';
import resultUnsold from '../../migrations/0018_result_unsold.sql';
import entryPlanChanges from '../../migrations/0019_entry_plan_changes.sql';
import chatAuto from '../../migrations/0020_chat_auto.sql';
import chatMentions from '../../migrations/0021_chat_mentions.sql';
import raceLive from '../../migrations/0022_race_live.sql';
import raceOddsV2 from '../../migrations/0023_race_odds_v2.sql';
import finesAbolished from '../../migrations/0024_fines_abolished.sql';
import d1Usage from '../../migrations/0025_d1_usage.sql';

const MIGRATIONS: { name: string; sql: string }[] = [
  { name: '0001_init', sql: init },
  { name: '0002_operator', sql: operator },
  { name: '0003_entries', sql: entries },
  { name: '0004_entry_plans', sql: entryPlans },
  { name: '0005_race_entrants', sql: raceEntrants },
  { name: '0006_accounts', sql: accounts },
  { name: '0007_late_entries', sql: lateEntries },
  { name: '0008_race_cards', sql: raceCards },
  { name: '0009_race_records', sql: raceRecords },
  { name: '0010_race_boats', sql: raceBoats },
  { name: '0011_card_series', sql: cardSeries },
  { name: '0012_compact_agg', sql: compactAgg },
  { name: '0013_chat', sql: chat },
  { name: '0014_scan_indexes', sql: scanIndexes },
  { name: '0015_chat_likes', sql: chatLikes },
  { name: '0016_push', sql: push },
  { name: '0017_card_supplements', sql: cardSupplements },
  { name: '0018_result_unsold', sql: resultUnsold },
  { name: '0019_entry_plan_changes', sql: entryPlanChanges },
  { name: '0020_chat_auto', sql: chatAuto },
  { name: '0021_chat_mentions', sql: chatMentions },
  { name: '0022_race_live', sql: raceLive },
  { name: '0023_race_odds_v2', sql: raceOddsV2 },
  { name: '0024_fines_abolished', sql: finesAbolished },
  { name: '0025_d1_usage', sql: d1Usage },
];

/** SQL ファイルを文に分ける（行末コメントを除いてから、行末の ; で区切る） */
export function splitSql(sql: string): string[] {
  return sql
    .split('\n')
    .map((l) => l.replace(/--.*$/, '').trimEnd())
    .join('\n')
    .split(/;\s*(?:\n|$)/)
    .map((s) => s.trim())
    .filter(Boolean);
}

export async function ensureSchema(db: D1Database): Promise<string[]> {
  await db.prepare('CREATE TABLE IF NOT EXISTS schema_migrations (name TEXT PRIMARY KEY, applied_at TEXT NOT NULL)').run();
  const done = new Set((await db.prepare('SELECT name FROM schema_migrations').all<{ name: string }>()).results.map((r) => r.name));
  const applied: string[] = [];
  for (const m of MIGRATIONS) {
    if (done.has(m.name)) continue;
    const mark = db.prepare('INSERT OR IGNORE INTO schema_migrations (name, applied_at) VALUES (?, ?)').bind(m.name, new Date().toISOString());
    try {
      await db.batch([...splitSql(m.sql).map((s) => db.prepare(s)), mark]);
    } catch (e) {
      // 別のインスタンスが同時に同じ ALTER TABLE ... ADD COLUMN を流し終えていた（列はもうある）
      if (!/duplicate column/i.test(String(e))) throw e;
      await mark.run();
    }
    applied.push(m.name);
  }
  return applied;
}
