import { DatabaseSync, type SQLInputValue } from 'node:sqlite';
import type { RequestContext, ResourceEnvelope } from './types.js';

interface PersistedMutation {
  kind: string;
  id: string;
  spec: Record<string, unknown>;
  status: Record<string, unknown>;
  relationships: Record<string, unknown>;
}

export class ResourceStore {
  readonly database: DatabaseSync;

  constructor(path: string) {
    this.database = new DatabaseSync(path);
    this.database.exec(`
      PRAGMA foreign_keys = ON;
      PRAGMA journal_mode = WAL;
      CREATE TABLE IF NOT EXISTS resources (
        id TEXT PRIMARY KEY,
        kind TEXT NOT NULL,
        spec TEXT NOT NULL,
        status TEXT NOT NULL,
        relationships TEXT NOT NULL,
        resource_version INTEGER NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS resources_kind_idx ON resources(kind);
      CREATE TABLE IF NOT EXISTS audit_events (
        id TEXT PRIMARY KEY,
        transaction_id TEXT NOT NULL,
        action TEXT NOT NULL,
        resource_kind TEXT NOT NULL,
        resource_id TEXT NOT NULL,
        actor TEXT,
        before_value TEXT,
        after_value TEXT,
        occurred_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS domain_events (
        id TEXT PRIMARY KEY,
        transaction_id TEXT NOT NULL,
        event_type TEXT NOT NULL,
        resource_kind TEXT NOT NULL,
        resource_id TEXT NOT NULL,
        payload TEXT NOT NULL,
        occurred_at TEXT NOT NULL
      );
    `);
  }

  query(kind: string, specEquals: Record<string, unknown> = {}): ResourceEnvelope[] {
    const rows = this.database.prepare(
      'SELECT * FROM resources WHERE kind = ? ORDER BY created_at, id',
    ).all(kind).map(toEnvelope);
    return rows.filter((row) => Object.entries(specEquals).every(
      ([key, value]) => JSON.stringify(row.spec[key]) === JSON.stringify(value),
    ));
  }

  get(kind: string, id: string): ResourceEnvelope | undefined {
    const row = this.database.prepare(
      'SELECT * FROM resources WHERE kind = ? AND id = ?',
    ).get(kind, id);
    return row ? toEnvelope(row) : undefined;
  }

  create(input: PersistedMutation, context: RequestContext): ResourceEnvelope {
    return this.transaction(() => {
      const now = new Date().toISOString();
      this.database.prepare(`
        INSERT INTO resources
          (id, kind, spec, status, relationships, resource_version, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, 1, ?, ?)
      `).run(
        input.id,
        input.kind,
        json(input.spec),
        json(input.status),
        json(input.relationships),
        now,
        now,
      );
      const created = this.get(input.kind, input.id)!;
      this.appendEvents('created', undefined, created, context);
      return created;
    });
  }

  update(
    input: PersistedMutation & { expectedResourceVersion: number },
    context: RequestContext,
  ): ResourceEnvelope {
    return this.transaction(() => {
      const before = this.get(input.kind, input.id);
      if (!before) throw new Error(`${input.kind} "${input.id}" was not found.`);
      const result = this.database.prepare(`
        UPDATE resources
        SET spec = ?, status = ?, relationships = ?,
            resource_version = resource_version + 1, updated_at = ?
        WHERE kind = ? AND id = ? AND resource_version = ?
      `).run(
        json(input.spec),
        json(input.status),
        json(input.relationships),
        new Date().toISOString(),
        input.kind,
        input.id,
        input.expectedResourceVersion,
      );
      if (result.changes !== 1) throw new Error('Resource version conflict. Re-read and retry.');
      const updated = this.get(input.kind, input.id)!;
      this.appendEvents('updated', before, updated, context);
      return updated;
    });
  }

  delete(
    kind: string,
    id: string,
    expectedResourceVersion: number,
    context: RequestContext,
  ): ResourceEnvelope {
    return this.transaction(() => {
      const before = this.get(kind, id);
      if (!before) throw new Error(`${kind} "${id}" was not found.`);
      const result = this.database.prepare(
        'DELETE FROM resources WHERE kind = ? AND id = ? AND resource_version = ?',
      ).run(kind, id, expectedResourceVersion);
      if (result.changes !== 1) throw new Error('Resource version conflict. Re-read and retry.');
      this.appendEvents('deleted', before, undefined, context);
      return before;
    });
  }

  close(): void {
    this.database.close();
  }

  private transaction<T>(operation: () => T): T {
    this.database.exec('BEGIN IMMEDIATE');
    try {
      const result = operation();
      this.database.exec('COMMIT');
      return result;
    } catch (error) {
      this.database.exec('ROLLBACK');
      throw error;
    }
  }

  private appendEvents(
    action: 'created' | 'updated' | 'deleted',
    before: ResourceEnvelope | undefined,
    after: ResourceEnvelope | undefined,
    context: RequestContext,
  ): void {
    const resource = after ?? before!;
    const now = new Date().toISOString();
    this.database.prepare(`
      INSERT INTO audit_events
        (id, transaction_id, action, resource_kind, resource_id, actor,
         before_value, after_value, occurred_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      crypto.randomUUID(),
      context.transactionId,
      action,
      resource.kind,
      resource.metadata.id,
      context.actor ?? null,
      before ? json(before) : null,
      after ? json(after) : null,
      now,
    );
    this.database.prepare(`
      INSERT INTO domain_events
        (id, transaction_id, event_type, resource_kind, resource_id, payload, occurred_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(
      crypto.randomUUID(),
      context.transactionId,
      `${resource.kind}.${action}`,
      resource.kind,
      resource.metadata.id,
      json({ before, after }),
      now,
    );
  }
}

function json(value: unknown): string {
  return JSON.stringify(value);
}

function toEnvelope(value: unknown): ResourceEnvelope {
  const row = value as Record<string, SQLInputValue>;
  return {
    kind: String(row.kind),
    metadata: {
      id: String(row.id),
      createdAt: String(row.created_at),
      updatedAt: String(row.updated_at),
      resourceVersion: Number(row.resource_version),
    },
    spec: JSON.parse(String(row.spec)),
    status: JSON.parse(String(row.status)),
    relationships: JSON.parse(String(row.relationships)),
  };
}
