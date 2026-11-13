import type { DatabaseSync } from 'node:sqlite';

export const LEGACY_ANALYTICS_TABLES = [
  'instance_http_minutes',
  'instance_diagnostic_events',
  'instance_runtime_samples',
  'instance_tool_queue_events',
  'instance_tool_queue_seconds',
] as const;

export function migrateLegacyAnalytics(db: DatabaseSync): void {
  db.exec('BEGIN IMMEDIATE');
  try {
    db.exec('CREATE TABLE IF NOT EXISTS resource_migrations (name TEXT PRIMARY KEY, version INTEGER NOT NULL)');
    const done = db.prepare("SELECT version FROM resource_migrations WHERE name = 'legacy-analytics'").get();
    if (done) {
      if (done.version !== 1) throw new Error(`Unsupported legacy-analytics migration version: ${done.version}`);
    } else {
      for (const table of LEGACY_ANALYTICS_TABLES) db.exec(`DROP TABLE IF EXISTS "${table}"`);
      db.prepare("INSERT INTO resource_migrations(name,version) VALUES('legacy-analytics',1)").run();
    }
    db.exec('COMMIT');
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}
