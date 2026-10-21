import type { DatabaseSync } from 'node:sqlite';
import { agentMessageSpec, legacyToMessage } from './kinds/agentmessage/spec.js';

/**
 * Resource-store migrations use named versions, independent of the historical
 * relational schema/ SQL sequence (021 is reserved by parallel work).
 */
export function migrateAgentMessages(db: DatabaseSync): void {
  db.exec('BEGIN IMMEDIATE');
  try {
    db.exec('CREATE TABLE IF NOT EXISTS resource_migrations (name TEXT PRIMARY KEY, version INTEGER NOT NULL)');
    const done = db.prepare("SELECT version FROM resource_migrations WHERE name = 'agent-messages'").get() as { version: number } | undefined;
    if (done) {
      if (done.version !== 1 && done.version !== 2 && done.version !== 3) throw new Error(`Unsupported agent-messages migration version: ${done.version}`);
      if (done.version === 3) {
        db.exec('COMMIT');
        return;
      }
    }
    const maximum = db.prepare('SELECT COALESCE(MAX(resource_version), 0) AS version FROM resources').get() as { version: number };
    db.prepare("UPDATE store_meta SET value = MAX(value, ?) WHERE key = 'resource_version'").run(maximum.version);
    const nextVersion = () => {
      db.prepare("UPDATE store_meta SET value = value + 1 WHERE key = 'resource_version'").run();
      return (db.prepare("SELECT value FROM store_meta WHERE key = 'resource_version'").get() as { value: number }).value;
    };
    const converted = new Set<string>();
    const rows = db.prepare("SELECT * FROM resources WHERE kind = 'Alert' ORDER BY rowid").all() as Array<Record<string, unknown>>;
    for (const row of rows) {
      try {
        for (const column of ['created_at', 'updated_at', 'resource_version']) {
          if (!Number.isSafeInteger(row[column])) throw new Error(`${column} must be an integer`);
        }
        if (row.deleted_at !== null && !Number.isSafeInteger(row.deleted_at)) throw new Error('deleted_at must be an integer or null');
        const raw = JSON.parse(row.spec as string);
        if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('spec must be an object');
        for (const column of ['labels', 'status']) {
          const parsed = JSON.parse(row[column] as string);
          if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error(`${column} must be an object`);
          if (column === 'labels' && Object.values(parsed).some((value) => typeof value !== 'string')) {
            throw new Error('labels must contain only string values');
          }
        }
        // Nullable dedupe_key was valid in the original relational schema.
        const normalized = { ...raw };
        if (normalized.dedupe_key === null) delete normalized.dedupe_key;
        // Preserve unknown historical fields verbatim, but never admit them as authored canonical fields.
        const allowed = ['title', 'description', 'recommended_action', 'status', 'dedupe_key', 'created_by', 'topics'];
        const legacy = Object.fromEntries(Object.entries(normalized).filter(([key]) => allowed.includes(key)));
        const spec = legacyToMessage(legacy);
        spec.legacy_source = { migration_version: 3, row: { ...row } };
        db.prepare("UPDATE resources SET kind = 'AgentMessage', spec = ?, resource_version = ? WHERE id = ?")
          .run(JSON.stringify(spec), nextVersion(), row.id as string);
        converted.add(row.id as string);
      } catch (error) {
        throw new Error(`AgentMessage migration failed for Alert ${row.id}: ${(error as Error).message}`);
      }
    }
    const messages = db.prepare("SELECT id, spec FROM resources WHERE kind = 'AgentMessage' ORDER BY rowid").all() as Array<{ id: string; spec: string }>;
    for (const row of messages) {
      try {
        const spec = agentMessageSpec.parse(JSON.parse(row.spec));
        // Earlier migration revisions retained the old RV, making a surviving
        // desktop feed cursor blind to the conversion. Advance those rows once.
        if (done && !converted.has(row.id) && spec.legacy_source?.row) {
          db.prepare('UPDATE resources SET resource_version = ? WHERE id = ?').run(nextVersion(), row.id);
        }
      }
      catch (error) { throw new Error(`Invalid AgentMessage ${row.id}: ${(error as Error).message}`); }
    }
    // Historical closed messages may share a recurrence key. Only live,
    // unresolved messages compete for that key; reopening is checked likewise.
    db.exec(`DROP INDEX IF EXISTS idx_agent_message_dedupe;
      CREATE UNIQUE INDEX idx_agent_message_dedupe
      ON resources(json_extract(spec, '$.dedupe_key'))
      WHERE kind = 'AgentMessage' AND deleted_at IS NULL
        AND json_extract(spec, '$.status') != 'resolved'
        AND json_extract(spec, '$.dedupe_key') IS NOT NULL`);
    db.prepare(`INSERT INTO resource_migrations (name, version) VALUES ('agent-messages', 3)
      ON CONFLICT(name) DO UPDATE SET version = excluded.version`).run();
    db.exec('COMMIT');
  } catch (error) {
    db.exec('ROLLBACK');
    throw new Error(`AgentMessage migration rolled back: ${(error as Error).message}`);
  }
}
