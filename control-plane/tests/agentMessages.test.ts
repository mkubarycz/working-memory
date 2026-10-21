import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { openStore, type DocumentEnvelope, type Store } from '../src/store';
import { loadKinds } from '../src/kinds/loader';
import { startServer } from '../src/server';
import { ensureSystemImportAgent } from '../src/agentMessageMigration';
import { SYSTEM_IMPORT_AGENT_ID } from '../src/kinds/agent/spec';
import { ControlPlaneClient } from '../../shared/controlPlaneClient';

const directories: string[] = [];
const stores: Store[] = [];
const memory = () => { const store = openStore(':memory:'); ensureSystemImportAgent(store.db); stores.push(store); return store; };
const message = (extra: Record<string, unknown> = {}) => ({ agent_id: SYSTEM_IMPORT_AGENT_ID, title: 'Human review', description: '# Authored\n\n![image](wm-attachment:abc)', category: 'request', recommended_action: 'Review the proposed changes and decide whether to proceed.', ...extra });
const create = (store: Store, spec = message()) => store.createDocument({ kind: 'AgentMessage', spec });

afterEach(() => {
  for (const store of stores.splice(0)) store.close();
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});
beforeAll(async () => { await loadKinds(); });

function legacyDatabase(rows: Array<Record<string, unknown>>) {
  const directory = join(process.cwd(), `.agent-message-test-${randomUUID()}`);
  mkdirSync(directory);
  directories.push(directory);
  const file = join(directory, 'store.db');
  openStore(file).close();
  const db = new DatabaseSync(file);
  db.exec("DELETE FROM resource_migrations; DROP INDEX idx_agent_message_dedupe");
  const insert = db.prepare(`INSERT INTO resources
    (id, kind, slug, labels, spec, status, created_at, updated_at, deleted_at, resource_version)
    VALUES (?, 'Alert', NULL, '{"legacy":"yes"}', ?, '{"history":["raised","closed"]}', 10, 20, ?, ?)`);
  rows.forEach((row, index) => insert.run(
    String(row.id ?? `old-${index}`),
    typeof row.raw === 'string' ? row.raw : JSON.stringify({ description: '**Original**\r\n', ...row.spec as object }),
    (row.deletedAt ?? null) as number | null, index + 1,
  ));
  db.close();
  return file;
}

describe('canonical AgentMessage store', () => {
  it('applies explicit defaults and preserves authored Markdown byte-for-byte', () => {
    const doc = create(memory());
    expect(doc.kind).toBe('AgentMessage');
    expect(doc.spec).toMatchObject({ ...message(), status: 'open', attention: false, severity: 'info', topics: [], relations: [] });
  });
  it('rejects invalid categories, lifecycle, unknown fields and attention outside open', () => {
    const store = memory();
    for (const extra of [{ category: 'alert' }, { status: 'closed' }, { attention: 'yes' }, { execute: true }, { status: 'resolved', attention: true }, { title: '' }, { title: '  ' }, { description: '  ' }, { attention: true, recommended_action: '' }, { attention: true, category: 'completion' }, { provenance: { approved: true } }]) {
      expect(() => create(store, message(extra))).toThrow();
    }
    expect(store.listDocuments({ kind: 'AgentMessage' })).toHaveLength(0);
  });
  it('deduplicates active retries, frees recurrence keys on resolve/delete and never revives historical records', () => {
    const store = memory();
    const spec = message({ dedupe_key: 'human-review' });
    const first = create(store, spec);
    expect(create(store, spec)).toEqual(first);
    expect(() => create(store, { ...spec, description: 'different' })).toThrow(/dedupe_key/);
    const resolved = store.updateDocument({
      id: first.metadata.id, expectedResourceVersion: first.metadata.resourceVersion,
      spec: { ...first.spec, status: 'resolved' },
    });
    const recurrence = create(store, spec);
    expect(recurrence.metadata.id).not.toBe(resolved.metadata.id);
    expect(() => store.updateDocument({
      id: resolved.metadata.id, expectedResourceVersion: resolved.metadata.resourceVersion,
      spec: { ...resolved.spec, status: 'open' },
    })).toThrow(/already active/);
    const deleted = store.deleteDocument({ id: recurrence.metadata.id });
    const next = create(store, spec);
    expect(next.metadata.id).not.toBe(deleted.metadata.id);
    expect(() => store.restoreDocument({ id: deleted.metadata.id })).toThrow(/already active/);
    expect(store.getDocument({ id: deleted.metadata.id })).toBeNull();
    expect(() => store.updateDocument({ id: deleted.metadata.id, expectedResourceVersion: deleted.metadata.resourceVersion, spec: deleted.spec })).toThrow(/No live/);
  });
  it('validates topic/object links, duplicate links, target deletion and restore integrity', () => {
    const store = memory();
    const topic = store.createDocument({ kind: 'Topic', slug: 'human-decision', spec: { title: 'Decision', status: 'open' } });
    const ref = { kind: 'Topic', id: topic.metadata.id };
    for (const extra of [{ topics: ['missing'] }, { relations: [{ ...ref, kind: 'Workstream' }] }, { relations: [ref, ref] }]) {
      expect(() => create(store, message(extra))).toThrow(/relation|Topic/);
    }
    const doc = create(store, message({ topics: ['human-decision'], relations: [ref] }));
    expect(() => store.deleteDocument({ id: topic.metadata.id })).toThrow(/referenced/);
    const legacyNew = store.createDocument({ kind: 'Alert', spec: { description: 'New legacy adapter input', topics: ['human-decision'] } });
    store.deleteDocument({ id: legacyNew.metadata.id });
    store.deleteDocument({ id: doc.metadata.id });
    store.deleteDocument({ id: topic.metadata.id });
    expect(() => store.restoreDocument({ id: doc.metadata.id })).toThrow(/Topic/);
    expect(() => store.restoreDocument({ id: legacyNew.metadata.id })).toThrow(/Topic/);
    expect(store.getDocument({ id: doc.metadata.id })).toBeNull();
  });
  it('aliases legacy creates and historical queries to one canonical record', () => {
    const store = memory();
    const old = store.createDocument({ kind: 'Alert', spec: { description: 'Review', status: 'informational' } });
    expect(old).toMatchObject({ kind: 'AgentMessage', spec: { category: 'completion', status: 'open', attention: false } });
    expect(store.listDocuments({ kind: 'Alert' })).toEqual(store.listDocuments({ kind: 'AgentMessage' }));
    expect(store.listDocuments({ kind: 'AgentMessage' })).toHaveLength(1);
    expect(() => store.createDocument({ kind: 'Alert', spec: { description: 'x', status: 'approval' } })).toThrow(/Unsupported/);
  });
  it('treats empty compatibility keys as absent without allowing new blank bodies', () => {
    const store = memory();
    const spec = { description: 'Legacy caller', dedupe_key: '' };
    const first = store.createDocument({ kind: 'Alert', spec });
    const second = store.createDocument({ kind: 'Alert', spec });
    expect(second.metadata.id).not.toBe(first.metadata.id);
    expect(first.spec.dedupe_key).toBeUndefined();
    expect(first.spec.legacy_source).toEqual({ adapter: 'Alert', spec });
    expect(() => store.createDocument({ kind: 'Alert', spec: { description: ' \r\n\t', dedupe_key: '' } })).toThrow(/nonblank/);
    expect(() => create(store, message({ dedupe_key: '' }))).toThrow();
  });
  it('reserves migration snapshots and enforces canonical validation for delete, restore and batch writes', () => {
    const store = memory();
    expect(() => create(store, message({ legacy_source: { fake: true } }))).toThrow(/reserved/);
    const doc = create(store);
    expect(() => store.updateDocument({
      id: doc.metadata.id, expectedResourceVersion: doc.metadata.resourceVersion,
      spec: { ...doc.spec, legacy_source: { fake: true } },
    })).toThrow(/immutable/);
    const other = store.createDocument({ kind: 'Config', spec: { value: 'original' } });
    expect(() => store.updateDocuments([
      { id: other.metadata.id, expectedResourceVersion: other.metadata.resourceVersion, spec: { value: 'changed' } },
      { id: doc.metadata.id, expectedResourceVersion: doc.metadata.resourceVersion, spec: { ...doc.spec, category: 'unknown' } },
    ])).toThrow();
    expect(store.getDocument({ id: other.metadata.id })?.spec.value).toBe('original');
    store.db.prepare("UPDATE resources SET spec = ? WHERE id = ?").run(JSON.stringify({ ...doc.spec, description: '' }), doc.metadata.id);
    expect(() => store.deleteDocument({ id: doc.metadata.id })).toThrow();
    store.db.prepare('UPDATE resources SET deleted_at = 50 WHERE id = ?').run(doc.metadata.id);
    expect(() => store.restoreDocument({ id: doc.metadata.id })).toThrow();
    expect(store.getDocument({ id: doc.metadata.id })).toBeNull();
  });
  it('records attributed approval decisions as communication with server-owned Unix time, never lifecycle or authorization', () => {
    const store = memory();
    const clock = vi.spyOn(Date, 'now').mockReturnValue(2_000_000_000_000);
    try {
      const input = message({
        category: 'approval', dedupe_key: 'approval-decision',
        decision: { outcome: 'approved', decided_by: 'human', reason: 'Reviewed the proposal' },
      });
      const doc = create(store, input);
      expect(doc.spec).toMatchObject({
        status: 'open', attention: false,
        decision: { outcome: 'approved', decided_by: 'human', reason: 'Reviewed the proposal', decided_at: 2_000_000_000 },
      });
      clock.mockReturnValue(2_000_000_005_000);
      expect(create(store, input)).toEqual(doc);
      const unchanged = store.updateDocument({
        id: doc.metadata.id, expectedResourceVersion: doc.metadata.resourceVersion,
        spec: { ...doc.spec, title: 'Decision remains informational' },
      });
      expect((unchanged.spec.decision as { decided_at: number }).decided_at).toBe(2_000_000_000);
      const revised = store.updateDocument({
        id: unchanged.metadata.id, expectedResourceVersion: unchanged.metadata.resourceVersion,
        spec: { ...unchanged.spec, decision: { outcome: 'rejected', decided_by: 'human', reason: 'New information' } },
      });
      expect(revised.spec).toMatchObject({ status: 'open', decision: { outcome: 'rejected', decided_at: 2_000_000_005 } });
      for (const extra of [
        { category: 'request', decision: { outcome: 'approved', decided_by: 'human' } },
        { category: 'approval', decision: { outcome: 'approved', decided_by: '' } },
        { category: 'approval', decision: { outcome: 'approved', decided_by: 'human', decided_at: 1 } },
        { category: 'approval', decision: { outcome: 'approved', decided_by: 'human', execute: true } },
        { category: 'approval', decision: { approved: true, decided_by: 'human' } },
      ]) expect(() => create(store, message(extra))).toThrow();
      expect(store.listDocuments({ kind: 'Topic' })).toHaveLength(0);
    } finally { clock.mockRestore(); }
  });
});

describe('versioned automatic Alert migration', () => {
  it.each([null, 30])('preserves whitespace-only historical bodies and empty keys with deletedAt=%s', async (deletedAt) => {
    const description = ' \t\r\n ';
    const file = legacyDatabase([
      { spec: { description, dedupe_key: '', status: 'alert' }, deletedAt },
      { spec: { dedupe_key: '', status: 'informational' }, deletedAt },
    ]);
    const store = openStore(file);
    const original = store.getDocument({ id: 'old-0', includeDeleted: true })!;
    expect(original.spec).toMatchObject({ description, title: 'Legacy agent message' });
    expect(original.spec.dedupe_key).toBeUndefined();
    expect(original.metadata).toMatchObject({ createdAt: 10, updatedAt: 20, deletedAt });
    const source = original.spec.legacy_source as { row: { spec: string } };
    expect(JSON.parse(source.row.spec)).toMatchObject({ description, dedupe_key: '' });
    const snapshot = store.listDocuments({ kind: 'AgentMessage', includeDeleted: true });
    store.close();
    const reopened = openStore(file);
    stores.push(reopened);
    expect(reopened.listDocuments({ kind: 'AgentMessage', includeDeleted: true })).toEqual(snapshot);
    const server = await startServer({ port: 0, store: reopened });
    const client = new ControlPlaneClient({ resolveUrl: () => `${server.url}/mcp` });
    try {
      expect(await client.agentMessageRead({ includeDeleted: true })).toHaveLength(2);
      let current = (await client.agentMessageReadPage({ includeDeleted: true })).messages.find((item) => item.id === 'old-0')!;
      expect(current.description).toBe(description);
      if (deletedAt !== null) current = await client.agentMessageRestore({ id: current.id });
      current = await client.agentMessageUpdate({ id: current.id, title: 'Still preserved' });
      expect(current.description).toBe(description);
      current = await client.agentMessageUpdate({ id: current.id, status: 'acknowledged', attention: false });
      expect(current.description).toBe(description);
      const generic = await client.updateDocument({
        id: current.id, expectedResourceVersion: current.resourceVersion, spec: { title: 'Generic edit' },
      });
      expect(generic.error).toBeUndefined();
      expect(generic.document?.spec.description).toBe(description);
      await client.agentMessageUpdate({ id: current.id, status: 'resolved' });
      const legacy = await client.alertUpdate({ id: current.id, status: 'closed', dedupe_key: '' });
      expect(legacy.description).toBe(description);
      expect(legacy.dedupe_key).toBeNull();
      expect((await client.agentMessageRead({ id: current.id }))[0]).toMatchObject({ description, status: 'resolved' });
      await client.agentMessageDelete({ id: current.id });
      expect((await client.agentMessageRestore({ id: current.id })).description).toBe(description);
      const persisted = reopened.getDocument({ id: current.id })!;
      expect(persisted.spec.legacy_source).toEqual(original.spec.legacy_source);
      expect(() => create(reopened, message({ description, legacy_source: original.spec.legacy_source }))).toThrow();
      expect(() => reopened.updateDocument({
        id: persisted.metadata.id, expectedResourceVersion: persisted.metadata.resourceVersion,
        spec: { ...persisted.spec, description: '\t' },
      })).toThrow(/nonblank/);
      expect(() => reopened.updateDocuments([{
        id: persisted.metadata.id, expectedResourceVersion: persisted.metadata.resourceVersion,
        spec: { ...persisted.spec, description: '\n' },
      }])).toThrow(/nonblank/);
      const repaired = await client.agentMessageUpdate({ id: current.id, description: 'Authored replacement' });
      await expect(client.agentMessageUpdate({ id: repaired.id, description })).rejects.toThrow(/nonblank/);
      const invalid = await client.updateDocument({
        id: repaired.id, expectedResourceVersion: repaired.resourceVersion, spec: { description },
      });
      expect(invalid.error).toMatch(/nonblank/);
    } finally { await client.dispose(); await server.close(); }
  });

  it('migrates live/closed/deleted rows losslessly with stable identity, history and timestamps; second open is a no-op', () => {
    const file = legacyDatabase([
      { spec: { status: 'alert', title: '# Title', custom_history: ['a', 'b'] } },
      { spec: { status: 'informational' } },
      { spec: { status: 'closed' }, deletedAt: 30 },
    ]);
    const first = openStore(file);
    const docs = ['old-0', 'old-1', 'old-2'].map((id) => first.getDocument({ id, includeDeleted: true })!);
    expect(docs.map((doc) => [doc.spec.category, doc.spec.status, doc.spec.attention])).toEqual([
      ['request', 'open', true], ['completion', 'open', false], ['request', 'resolved', false],
    ]);
    expect(docs[2].metadata).toMatchObject({ id: 'old-2', createdAt: 10, updatedAt: 20, deletedAt: 30, resourceVersion: 7 });
    expect(docs.every((doc) => doc.spec.agent_id === SYSTEM_IMPORT_AGENT_ID && doc.spec.agent_name === 'System Import')).toBe(true);
    expect((docs[2].spec.legacy_source as { row: { resource_version: number } }).row.resource_version).toBe(3);
    expect(docs[0].spec.description).toBe('**Original**\r\n');
    expect(docs[0].status).toEqual({ history: ['raised', 'closed'] });
    const snapshot = docs[0].spec.legacy_source as { row: { spec: string } };
    expect(JSON.parse(snapshot.row.spec).custom_history).toEqual(['a', 'b']);
    first.close();
    const second = openStore(file);
    expect(['old-0', 'old-1', 'old-2'].map((id) => second.getDocument({ id, includeDeleted: true }))).toEqual(docs);
    expect(second.db.prepare("SELECT count(*) AS n FROM resources WHERE kind = 'Alert'").get()).toMatchObject({ n: 0 });
    second.close();
  });
  it.each([
    [{ spec: { status: 'alert' } }, { raw: '{broken' }],
    [{ spec: { status: 'alert' } }, { spec: { status: 'unsupported' } }],
    [{ spec: { status: 'alert' } }, { spec: { title: 42 } }],
    [{ spec: { status: 'alert' } }, { spec: { description: '' } }],
    [{ spec: { dedupe_key: 'collision' } }, { spec: { dedupe_key: 'collision', status: 'informational' } }],
  ])('rolls back all rows and version marker on malformed data or collisions', (...rows) => {
    const file = legacyDatabase(rows);
    expect(() => openStore(file)).toThrow(/rolled back/);
    const db = new DatabaseSync(file);
    expect(db.prepare("SELECT count(*) AS n FROM resources WHERE kind = 'Alert'").get()).toMatchObject({ n: 2 });
    expect(db.prepare("SELECT count(*) AS n FROM resource_migrations").get()).toMatchObject({ n: 0 });
    db.close();
  });
  it('rolls back an interrupted write and safely retries on next startup', () => {
    const file = legacyDatabase([{ spec: {} }, { spec: {} }]);
    const db = new DatabaseSync(file);
    db.exec("CREATE TRIGGER interrupt_migration BEFORE UPDATE ON resources WHEN OLD.id = 'old-1' BEGIN SELECT RAISE(ABORT, 'interrupted'); END");
    db.close();
    expect(() => openStore(file)).toThrow(/interrupted/);
    const retry = new DatabaseSync(file);
    expect(retry.prepare("SELECT count(*) AS n FROM resources WHERE kind = 'Alert'").get()).toMatchObject({ n: 2 });
    retry.exec('DROP TRIGGER interrupt_migration');
    retry.close();
    const migrated = openStore(file);
    expect(migrated.listDocuments({ kind: 'AgentMessage' })).toHaveLength(2);
    migrated.close();
  });
  it('preserves valid repeated closed/deleted recurrence keys and restores historical missing topic references', () => {
    const file = legacyDatabase([
      { spec: { dedupe_key: 'recurring', status: 'closed', topics: ['gone-topic'] }, deletedAt: 30 },
      { spec: { dedupe_key: 'recurring', status: 'closed' } },
      { spec: { dedupe_key: 'recurring', status: 'alert' } },
      { spec: { dedupe_key: 'recurring', status: 'alert' }, deletedAt: 40 },
    ]);
    const store = openStore(file);
    try {
      expect(store.listDocuments({ kind: 'AgentMessage' })).toHaveLength(2);
      for (const id of ['old-0', 'old-1', 'old-2', 'old-3']) {
        const doc = store.getDocument({ id, includeDeleted: true })!;
        expect(doc.spec.dedupe_key).toBe('recurring');
        const snapshot = doc.spec.legacy_source as { row: { spec: string } };
        expect(JSON.parse(snapshot.row.spec).dedupe_key).toBe('recurring');
      }
      const restored = store.restoreDocument({ id: 'old-0' });
      expect(restored.spec).toMatchObject({ status: 'resolved', topics: ['gone-topic'] });
      expect(restored.metadata.deletedAt).toBeNull();
      expect(() => store.updateDocument({
        id: restored.metadata.id, expectedResourceVersion: restored.metadata.resourceVersion,
        spec: { ...restored.spec, topics: ['another-missing-topic'] },
      })).toThrow(/Topic/);
      expect(() => store.updateDocument({
        id: restored.metadata.id, expectedResourceVersion: restored.metadata.resourceVersion,
        spec: { ...restored.spec, status: 'open' },
      })).toThrow(/already active/);
      const updated = store.updateDocument({
        id: restored.metadata.id, expectedResourceVersion: restored.metadata.resourceVersion,
        spec: { ...restored.spec, title: 'Preserved historical reference' },
      });
      expect(updated.spec.topics).toEqual(['gone-topic']);
      store.deleteDocument({ id: updated.metadata.id });
    } finally { store.close(); }
  });
  it('transactionally upgrades the prior v1 global dedupe index and resource versions', () => {
    const file = legacyDatabase([{ spec: { dedupe_key: 'upgrade', status: 'closed' } }]);
    const first = openStore(file);
    first.db.exec(`UPDATE resource_migrations SET version = 1 WHERE name = 'agent-messages';
      DROP INDEX idx_agent_message_dedupe;
      CREATE UNIQUE INDEX idx_agent_message_dedupe ON resources(json_extract(spec, '$.dedupe_key'))
      WHERE kind = 'AgentMessage' AND json_extract(spec, '$.dedupe_key') IS NOT NULL`);
    first.close();
    const upgraded = openStore(file);
    try {
      const next = create(upgraded, message({ dedupe_key: 'upgrade' }));
      expect(next.metadata.id).not.toBe('old-0');
      expect(upgraded.db.prepare("SELECT version FROM resource_migrations WHERE name = 'agent-messages'").get()).toMatchObject({ version: 5 });
    } finally { upgraded.close(); }
  });
  it('rejects unsupported future migration versions without changing legacy rows or the marker', () => {
    const file = legacyDatabase([{ spec: { dedupe_key: 'future', status: 'closed' } }]);
    const db = new DatabaseSync(file);
    db.exec("INSERT INTO resource_migrations(name,version) VALUES('agent-messages',99)");
    db.close();
    expect(() => openStore(file)).toThrow(/Unsupported agent-messages migration version: 99/);
    const unchanged = new DatabaseSync(file);
    try {
      expect(unchanged.prepare('SELECT kind FROM resources WHERE id = ?').get('old-0')).toMatchObject({ kind: 'Alert' });
      expect(unchanged.prepare("SELECT version FROM resource_migrations WHERE name = 'agent-messages'").get()).toMatchObject({ version: 99 });
    } finally { unchanged.close(); }
  });
  it.each(['fresh', 'prior-v2'])('invalidates a surviving desktop feed cursor after %s conversion without changing authored timestamps', async (revision) => {
    const file = legacyDatabase([{ spec: { status: 'alert' } }, { spec: { status: 'closed' }, deletedAt: 30 }]);
    if (revision === 'prior-v2') {
      const earlier = openStore(file);
      earlier.db.exec(`UPDATE resource_migrations SET version = 2 WHERE name = 'agent-messages';
        UPDATE resources SET resource_version = json_extract(spec, '$.legacy_source.row.resource_version') WHERE kind = 'AgentMessage'`);
      earlier.close();
    }
    const before = new DatabaseSync(file);
    before.exec("UPDATE store_meta SET value = 10 WHERE key = 'resource_version'");
    before.close();
    const store = openStore(file);
    stores.push(store);
    const server = await startServer({ port: 0, store });
    try {
      const notice = await (await fetch(`${server.url}/changes?since=10`)).json();
      const firstVersion = revision === 'fresh' ? 12 : 11;
      expect(notice).toEqual({ resourceVersion: firstVersion + 1, reset: true, changes: [] });
      expect(store.getDocument({ id: 'old-0' })).toMatchObject({
        kind: 'AgentMessage', metadata: { createdAt: 10, updatedAt: 20, resourceVersion: firstVersion },
      });
      const deleted = store.getDocument({ id: 'old-1', includeDeleted: true })!;
      expect(deleted.metadata).toMatchObject({ createdAt: 10, updatedAt: 20, deletedAt: 30, resourceVersion: firstVersion + 1 });
      expect((deleted.spec.legacy_source as { row: { resource_version: number } }).row.resource_version).toBe(2);
    } finally { await server.close(); }
  });
  it('allows migrated actionable orphan references through actual MCP acknowledge/resolve/title edits but rejects new dangling references', async () => {
    const file = legacyDatabase([{ spec: { status: 'alert', topics: ['missing-topic', 'deleted-topic'] } }]);
    const db = new DatabaseSync(file);
    db.prepare(`INSERT INTO resources(id,kind,slug,labels,spec,status,created_at,updated_at,deleted_at,resource_version)
      VALUES('deleted-topic-id','Topic','deleted-topic','{}','{"title":"Deleted topic","status":"open"}','{}',10,20,30,2)`).run();
    db.close();
    const store = openStore(file);
    stores.push(store);
    const original = store.getDocument({ id: 'old-0' })!;
    const server = await startServer({ port: 0, store });
    const client = new Client({ name: 'legacy-orphan-lifecycle', version: '1' });
    await client.connect(new StreamableHTTPClientTransport(new URL(`${server.url}/mcp`)));
    const call = async (name: string, args: Record<string, unknown>) => client.callTool({ name, arguments: args });
    const json = (result: unknown) => JSON.parse((result as { content: Array<{ text: string }> }).content[0].text) as DocumentEnvelope;
    try {
      let current = original;
      for (const lifecycle of ['acknowledge', 'resolve']) {
        current = json(await call(`ws-agent-message-${lifecycle}`, { id: current.metadata.id, expectedResourceVersion: current.metadata.resourceVersion }));
        expect(current.spec.topics).toEqual(['missing-topic', 'deleted-topic']);
        expect(current.spec.legacy_source).toEqual(original.spec.legacy_source);
      }
      expect(current.spec.status).toBe('resolved');
      current = json(await call('ws-agent-message-update', {
        id: current.metadata.id, expectedResourceVersion: current.metadata.resourceVersion, spec: { title: 'Historical references remain intact' },
      }));
      expect(current.spec.topics).toEqual(['missing-topic', 'deleted-topic']);
      expect(await call('ws-agent-message-update', {
        id: current.metadata.id, expectedResourceVersion: current.metadata.resourceVersion, spec: { topics: ['missing-topic', 'new-missing-topic'] },
      })).toMatchObject({ isError: true });
      expect(store.getDocument({ id: current.metadata.id })?.spec.topics).toEqual(['missing-topic', 'deleted-topic']);
      expect(store.getDocument({ id: current.metadata.id })?.spec.description).toBe('**Original**\r\n');
    } finally { await client.close(); await server.close(); }
  });
});

describe('AgentMessage MCP over isolated HTTP', () => {
  it.each(['open', 'acknowledged', 'resolved'])('a real title-only MCP patch preserves %s lifecycle and all unrelated source fields byte-identically', async (status) => {
    const store = memory();
    const topic = store.createDocument({ kind: 'Topic', slug: 'source-topic', spec: { title: 'Source topic', status: 'open' } });
    const original = create(store, message({
      category: 'approval', status, attention: status === 'open', severity: 'warning', created_by: 'review-agent',
      description: '# Source\r\n\n**Keep this exact Markdown**\n',
      topics: ['source-topic'], relations: [{ kind: 'Topic', id: topic.metadata.id }],
      provenance: { agent: 'reviewer', run_id: 'run-123', source: 'test' },
      decision: { outcome: 'approved', decided_by: 'human', reason: 'Communication, not authority' },
    }));
    const server = await startServer({ port: 0, store });
    const client = new Client({ name: `title-patch-${status}`, version: '1' });
    await client.connect(new StreamableHTTPClientTransport(new URL(`${server.url}/mcp`)));
    try {
      const response = await client.callTool({
        name: 'ws-agent-message-update',
        arguments: { id: original.metadata.id, expectedResourceVersion: original.metadata.resourceVersion, spec: { title: 'Changed title only' } },
      });
      expect(response.isError).not.toBe(true);
      const updated = JSON.parse((response.content as Array<{ text: string }>)[0].text) as DocumentEnvelope;
      expect(updated.spec).toEqual({ ...original.spec, title: 'Changed title only' });
      expect(updated.metadata.resourceVersion).toBeGreaterThan(original.metadata.resourceVersion);
      expect(store.getDocument({ id: topic.metadata.id })?.spec.status).toBe('open');
    } finally { await client.close(); await server.close(); }
  });
  it('keeps mixed legacy lists usable with explicit incompatibility metadata and preserves resolved completion categories', async () => {
    const store = memory();
    const request = create(store, message({ attention: true }));
    const completion = create(store, message({ category: 'completion', status: 'resolved' }));
    const incompatible = [
      create(store, message({ category: 'approval' })),
      create(store, message({ category: 'error' })),
      create(store, message({ status: 'acknowledged' })),
    ];
    const server = await startServer({ port: 0, store });
    const client = new Client({ name: 'legacy-mixed-list-test', version: '1' });
    await client.connect(new StreamableHTTPClientTransport(new URL(`${server.url}/mcp`)));
    const call = async (name: string, args: Record<string, unknown>) => client.callTool({ name, arguments: args });
    const json = (result: unknown) => JSON.parse((result as { content: Array<{ text: string }> }).content[0].text);
    try {
      const list = json(await call('ws-alert-read', {}));
      expect(list.count).toBe(2);
      expect(list.alerts.map((alert: { id: string }) => alert.id).sort()).toEqual([request.metadata.id, completion.metadata.id].sort());
      expect(list.incompatibleMessageIds.sort()).toEqual(incompatible.map((doc) => doc.metadata.id).sort());
      expect(list.warnings).toHaveLength(3);
      expect(list.warnings.every((warning: { message: string }) => warning.message.includes('cannot be represented'))).toBe(true);
      expect(await call('ws-alert-read', { id: incompatible[0].metadata.id })).toMatchObject({ isError: true });
      const legacy = json(await call('ws-alert-read', { id: completion.metadata.id }));
      expect(legacy.alerts[0].status).toBe('closed');
      await call('ws-alert-update', { id: completion.metadata.id, title: 'Historical completion' });
      expect(store.getDocument({ id: completion.metadata.id })?.spec).toMatchObject({ category: 'completion', status: 'resolved' });
      await call('ws-alert-update', { id: completion.metadata.id, status: 'closed' });
      expect(store.getDocument({ id: completion.metadata.id })?.spec).toMatchObject({ category: 'completion', status: 'resolved' });
    } finally { await client.close(); await server.close(); }
  });
  it('pages stable creation order, exposes deleted history through canonical/generic aliases, and rejects stale snapshots', async () => {
    const store = memory();
    const first = create(store, message({ title: 'First' }));
    const second = create(store, message({ title: 'Second' }));
    const third = create(store, message({ title: 'Third' }));
    store.deleteDocument({ id: second.metadata.id });
    const server = await startServer({ port: 0, store });
    const client = new Client({ name: 'message-paging-test', version: '1' });
    await client.connect(new StreamableHTTPClientTransport(new URL(`${server.url}/mcp`)));
    const call = async (name: string, args: Record<string, unknown>) => client.callTool({ name, arguments: args });
    const json = (result: unknown) => JSON.parse((result as { content: Array<{ text: string }> }).content[0].text);
    try {
      const page = json(await call('ws-agent-message-list', { includeDeleted: true, limit: 1, offset: 0 }));
      expect(page).toMatchObject({ count: 1, totalCount: 3, nextOffset: 1 });
      expect(page.messages[0].metadata.id).toBe(third.metadata.id);
      const history = json(await call('ws-agent-message-read', { includeDeleted: true, limit: 1, offset: 1, expectedSnapshotVersion: page.snapshotVersion }));
      expect(history.messages[0].metadata.id).toBe(second.metadata.id);
      expect(history.messages[0].metadata.deletedAt).not.toBeNull();
      const generic = json(await call('wm-document-read', { kind: 'Alert', includeDeleted: true, limit: 1, offset: 1 }));
      expect(generic.documents).toEqual(history.messages);
      const live = json(await call('ws-agent-message-list', {}));
      expect(live.messages.map((doc: DocumentEnvelope) => doc.metadata.id)).toEqual([third.metadata.id, first.metadata.id]);
      store.updateDocument({ id: first.metadata.id, expectedResourceVersion: first.metadata.resourceVersion, spec: { ...first.spec, title: 'Updated oldest' } });
      expect(await call('ws-agent-message-list', { offset: 1, expectedSnapshotVersion: page.snapshotVersion })).toMatchObject({ isError: true });
      const reordered = json(await call('ws-agent-message-list', { includeDeleted: true }));
      expect(reordered.messages.map((doc: DocumentEnvelope) => doc.metadata.id)).toEqual([third.metadata.id, second.metadata.id, first.metadata.id]);
    } finally { await client.close(); await server.close(); }
  });
  it('uses one canonical record across CRUD, legacy aliases, lifecycle, generic validation and delete/restore', async () => {
    const store = memory();
    const topic = store.createDocument({ kind: 'Topic', slug: 'approval-topic', spec: { title: 'Approval topic', status: 'open' } });
    const server = await startServer({ port: 0, store });
    const client = new Client({ name: 'agent-message-test', version: '1' });
    await client.connect(new StreamableHTTPClientTransport(new URL(`${server.url}/mcp`)));
    const call = async (name: string, args: Record<string, unknown>) => client.callTool({ name, arguments: args });
    const json = (result: unknown) => JSON.parse((result as { content: Array<{ text: string }> }).content[0].text);
    try {
      const tools = (await client.listTools()).tools;
      expect(tools.find((tool) => tool.name === 'ws-agent-message-create')?.description).toMatch(/NEVER authority/);
      expect(tools.map((tool) => tool.name)).toEqual(expect.arrayContaining([
        'ws-agent-message-list', 'ws-agent-message-acknowledge', 'ws-agent-message-resolve', 'ws-agent-message-reopen', 'ws-agent-message-restore',
      ]));
      expect(await call('ws-agent-message-create', message({ execute: true }))).toMatchObject({ isError: true });
      expect(await call('ws-agent-message-create', message({ category: 'approval', approved: true }))).toMatchObject({ isError: true });
      expect(await call('wm-document-create', {
        kind: 'AgentMessage', spec: message({ category: 'approval', approved: true }),
      })).toMatchObject({ isError: true });
      expect(store.listDocuments({ kind: 'AgentMessage' })).toHaveLength(0);
      expect(await call('ws-alert-create', { description: 'Do not coerce', category: 'approval' })).toMatchObject({ isError: true });
      const created = json(await call('ws-agent-message-create', message({
        category: 'approval', attention: true, severity: 'warning', created_by: 'review-agent',
        topics: ['approval-topic'], relations: [{ kind: 'Topic', id: topic.metadata.id }],
      }))) as DocumentEnvelope;
      expect(json(await call('wm-document-read', { kind: 'Alert' })).documents[0].metadata.id).toBe(created.metadata.id);
      expect(await call('ws-alert-read', { id: created.metadata.id })).toMatchObject({ isError: true });
      expect(await call('wm-document-update', { id: created.metadata.id, expectedResourceVersion: created.metadata.resourceVersion, spec: { category: 'informational' } })).toMatchObject({ isError: true });
      let current = json(await call('ws-agent-message-acknowledge', { id: created.metadata.id, expectedResourceVersion: created.metadata.resourceVersion }));
      expect(current.spec).toMatchObject({ status: 'acknowledged', attention: false, category: 'approval' });
      expect(await call('ws-agent-message-resolve', { id: created.metadata.id, expectedResourceVersion: created.metadata.resourceVersion })).toMatchObject({ isError: true });
      current = json(await call('ws-agent-message-resolve', { id: current.metadata.id, expectedResourceVersion: current.metadata.resourceVersion }));
      expect(current.spec.status).toBe('resolved');
      await call('ws-agent-message-delete', { id: current.metadata.id });
      expect(await call('ws-agent-message-update', { id: current.metadata.id, expectedResourceVersion: current.metadata.resourceVersion, spec: { title: 'revive?' } })).toMatchObject({ isError: true });
      current = json(await call('ws-agent-message-restore', { id: current.metadata.id }));
      expect(current.metadata.deletedAt).toBeNull();
      current = json(await call('ws-agent-message-update', {
        id: current.metadata.id, expectedResourceVersion: current.metadata.resourceVersion,
        spec: { decision: { outcome: 'approved', decided_by: 'reviewer', reason: 'Reviewed the design' } },
      }));
      expect(current.spec).toMatchObject({
        category: 'approval', status: 'resolved', attention: false, severity: 'warning', created_by: 'review-agent',
        recommended_action: created.spec.recommended_action,
        topics: ['approval-topic'], relations: [{ kind: 'Topic', id: topic.metadata.id }],
        decision: { outcome: 'approved', decided_by: 'reviewer', reason: 'Reviewed the design' },
      });
      expect(current.spec.decision.decided_at).toEqual(expect.any(Number));
      expect(store.getDocument({ id: topic.metadata.id })?.spec.status).toBe('open');
      const legacy = json(await call('ws-alert-create', { description: 'Old human request', dedupe_key: 'legacy-recurrence' }));
      expect(store.getDocument({ id: legacy.id })?.kind).toBe('AgentMessage');
      const updated = json(await call('ws-alert-update', { id: legacy.id, status: 'closed' }));
      expect(updated.status).toBe('closed');
      expect(store.getDocument({ id: legacy.id })?.spec.status).toBe('resolved');
      const recurrence = json(await call('ws-alert-create', { description: 'Old human request', dedupe_key: 'legacy-recurrence' }));
      expect(recurrence.id).not.toBe(legacy.id);
      expect(await call('ws-alert-update', { id: legacy.id, status: 'alert' })).toMatchObject({ isError: true });
      expect(store.getDocument({ id: legacy.id })?.spec.status).toBe('resolved');
      await call('ws-alert-delete', { id: recurrence.id });
      expect(await call('ws-alert-update', { id: recurrence.id, status: 'alert' })).toMatchObject({ isError: true });
      expect(store.getDocument({ id: recurrence.id })).toBeNull();
    } finally { await client.close(); await server.close(); }
  });
});
