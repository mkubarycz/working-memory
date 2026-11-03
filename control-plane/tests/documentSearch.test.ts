import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { openStore, type Store } from '../src/store';
import { loadKinds } from '../src/kinds/loader';
import { queryDocuments, searchDocuments } from '../src/documentSearch';
import { clearKinds, getKind } from '../src/kinds/registry';
import { ControlPlaneClient, startServer } from '../../tests/authenticatedFixture';
import { InstanceFeatureStore } from '../src/instanceFeatures';

const stores: Store[] = [];
beforeAll(async () => { await loadKinds(); });
afterEach(() => { for (const store of stores.splice(0)) store.close(); });
function fixture(path = ':memory:') {
  const store = openStore(path);
  stores.push(store);
  return store;
}

describe('indexed document search', () => {
  it('lets legacy connections write without custom functions and repairs their queued projections', () => {
    const directory = mkdtempSync(join(tmpdir(), 'wm-search-rollback-'));
    const path = join(directory, 'store.sqlite');
    const store = openStore(path);
    const original = store.createDocument({ kind: 'Topic', spec: { title: 'Before rollback', body: 'oldneedle' } });
    const removed = store.createDocument({ kind: 'Topic', spec: { title: 'Removed', body: 'deleteneedle' } });
    const legacy = new DatabaseSync(path);
    try {
      expect(new InstanceFeatureStore(store.db).read().search).toBe(false);
      expect(legacy.prepare("SELECT 1 FROM pragma_function_list WHERE name = 'wm_search_text'").get()).toBeUndefined();
      expect(legacy.prepare("SELECT sql FROM sqlite_master WHERE type = 'trigger' AND name LIKE 'document_search_%'")
        .all().every(row => !String(row.sql).includes('wm_search_text'))).toBe(true);
      legacy.prepare("UPDATE resources SET spec = json_set(spec, '$.body', 'updatedneedle') WHERE id = ?").run(original.metadata.id);
      legacy.prepare(`INSERT INTO resources(id,kind,labels,spec,status,created_at,updated_at,deleted_at,resource_version)
        VALUES ('legacy-created','Topic','{}',?,'{}',1,1,NULL,100)`)
        .run(JSON.stringify({ title: 'Legacy writer', body: 'createdneedle' }));
      legacy.prepare('DELETE FROM resources WHERE id = ?').run(removed.metadata.id);
      expect(searchDocuments(store.db, { queries: ['oldneedle', 'deleteneedle'] }).count).toBe(0);
      expect(searchDocuments(store.db, { queries: ['updatedneedle', 'createdneedle'] }).count).toBe(2);
      expect(store.db.prepare('SELECT count(*) AS count FROM document_search_dirty').get()?.count).toBe(0);
      legacy.exec("BEGIN; UPDATE resources SET spec = json_set(spec, '$.body', 'rolledbackneedle') WHERE id = 'legacy-created'; ROLLBACK;");
      expect(searchDocuments(store.db, { queries: ['rolledbackneedle'] }).count).toBe(0);
      legacy.prepare("UPDATE resources SET spec = json_set(spec, '$.body', 'restartneedle') WHERE id = 'legacy-created'").run();
      const restarted = openStore(path);
      try {
        expect(searchDocuments(restarted.db, { queries: ['restartneedle'] }).count).toBe(1);
        expect(searchDocuments(restarted.db, { queries: ['createdneedle'] }).count).toBe(0);
      } finally { restarted.close(); }
    } finally { legacy.close(); store.close(); rmSync(directory, { recursive: true, force: true }); }
  });

  it('replaces experimental function-dependent triggers before allowing a legacy rollback', () => {
    const directory = mkdtempSync(join(tmpdir(), 'wm-search-trigger-upgrade-'));
    const path = join(directory, 'store.sqlite');
    const previous = openStore(path);
    const doc = previous.createDocument({ kind: 'Topic', spec: { title: 'Upgrade', body: 'Original authored text' } });
    previous.close();
    const experimental = new DatabaseSync(path);
    try {
      experimental.exec(`DROP TRIGGER document_search_update;
        CREATE TRIGGER document_search_update AFTER UPDATE ON resources BEGIN
          SELECT wm_search_text(NEW.kind, NEW.id, NEW.spec);
        END;
        UPDATE store_meta SET value = 2 WHERE key = 'document_search_version';`);
      expect(() => experimental.prepare("UPDATE resources SET spec = json_set(spec, '$.body', 'blocked') WHERE id = ?")
        .run(doc.metadata.id)).toThrow('no such function');
    } finally { experimental.close(); }
    const upgraded = openStore(path);
    const legacy = new DatabaseSync(path);
    try {
      expect(upgraded.getDocument({ id: doc.metadata.id })).toEqual(doc);
      legacy.prepare("UPDATE resources SET spec = json_set(spec, '$.body', 'rollbackneedle') WHERE id = ?").run(doc.metadata.id);
      expect(searchDocuments(upgraded.db, { queries: ['rollbackneedle'] }).count).toBe(1);
    } finally { legacy.close(); upgraded.close(); rmSync(directory, { recursive: true, force: true }); }
  });

  it('caps SQL excerpts even when a matching snippet contains a multi-megabyte token', () => {
    const store = fixture();
    store.createDocument({ kind: 'Topic', spec: { title: 'Bounded snippet', body: `needle ${'x'.repeat(2_000_000)}` } });
    const result = searchDocuments(store.db, { queries: ['needle'] });
    expect(result.count).toBe(1);
    expect(Array.from(result.results[0].excerpt).length).toBeLessThanOrEqual(1200);
    expect(JSON.stringify(result).length).toBeLessThan(2000);
  });

  it('uses stored projections for literal filtering and bounded reads without reprojecting every document', () => {
    const store = fixture();
    for (let index = 0; index < 25; index++) store.createDocument({ kind: 'Topic', spec: { title: `Release WM 1.5 ${index}`, body: 'Stored evidence' } });
    const kind = getKind('Topic');
    if (!kind?.descriptor.fts) throw new Error('Topic search projection is unavailable.');
    const projection = vi.spyOn(kind.descriptor, 'fts');
    try {
      const result = queryDocuments(store.db, { kind: 'Topic', query: 'WM 1.5', limit: 2 }, () => true);
      expect(result.total).toBe(25);
      expect(result.count).toBe(2);
      expect(result.documents[0].body).toContain('Stored evidence');
      expect(projection).not.toHaveBeenCalled();
    } finally { projection.mockRestore(); }
  });
  it('ranks titles, stems words and matches alternative phrases without listing the store', () => {
    const store = fixture();
    const prose = store.createDocument({ kind: 'Topic', spec: { title: 'Unrelated title', body: 'The reminders feature.' } });
    const title = store.createDocument({ kind: 'Topic', spec: { title: 'Reminder', body: 'Scheduling work.' } });
    store.createDocument({ kind: 'Topic', spec: { title: 'Unrelated', body: 'Nothing relevant.' } });
    const result = searchDocuments(store.db, { queries: ['reminding', 'not present'] });
    expect(result.results.map(hit => hit.id)).toEqual([title.metadata.id, prose.metadata.id]);
    expect(result.results[0].score).toBeGreaterThan(result.results[1].score);
    expect(result.results[1].excerpt).toContain('reminders');
    expect(searchDocuments(store.db, { queries: ['no matches here'] }).results).toEqual([]);
    expect(searchDocuments(store.db, { queries: ['Reminder'], limit: 1 }).count).toBe(1);
    store.createDocument({ kind: 'Topic', spec: { title: 'Café', body: 'Crème brûlée' } });
    expect(searchDocuments(store.db, { queries: ['cafe'] }).count).toBe(1);
  });

  it('updates, soft-deletes and restores transactionally, including direct resource writes', () => {
    const store = fixture();
    const doc = store.createDocument({ kind: 'Topic', spec: { title: 'firstterm', body: 'original' } });
    store.updateDocument({ id: doc.metadata.id, expectedResourceVersion: doc.metadata.resourceVersion,
      spec: { title: 'secondterm', body: 'updated' } });
    expect(searchDocuments(store.db, { queries: ['firstterm'] }).count).toBe(0);
    expect(searchDocuments(store.db, { queries: ['secondterm'] }).count).toBe(1);
    store.db.exec('BEGIN IMMEDIATE');
    store.db.prepare("UPDATE resources SET spec = json_set(spec, '$.title', 'rolledback') WHERE id = ?").run(doc.metadata.id);
    store.db.exec('ROLLBACK');
    expect(searchDocuments(store.db, { queries: ['rolledback'] }).count).toBe(0);
    expect(searchDocuments(store.db, { queries: ['secondterm'] }).count).toBe(1);
    store.deleteDocument({ id: doc.metadata.id });
    expect(searchDocuments(store.db, { queries: ['secondterm'] }).count).toBe(0);
    store.restoreDocument({ id: doc.metadata.id });
    expect(searchDocuments(store.db, { queries: ['secondterm'] }).count).toBe(1);
  });

  it('filters unreadable kinds before limiting and never indexes Config values', () => {
    const store = fixture();
    store.createDocument({ kind: 'Config', spec: { name: 'configuration', data: { publickey: 'superprivatevalue' } } });
    store.createDocument({ kind: 'Topic', spec: { title: 'configuration notes', body: 'publickey' } });
    expect(searchDocuments(store.db, { queries: ['superprivatevalue'] }).count).toBe(0);
    expect(searchDocuments(store.db, { queries: ['publickey'], kinds: ['Config'] }).count).toBe(1);
    const result = searchDocuments(store.db, { queries: ['configuration'], limit: 1 }, kind => kind === 'Topic');
    expect(result.results).toHaveLength(1);
    expect(result.results[0].kind).toBe('Topic');
    expect(searchDocuments(store.db, { queries: ['configuration'] }, () => false).count).toBe(0);
  });

  it('quotes user input instead of accepting FTS syntax and rejects invalid bounds', () => {
    const store = fixture();
    for (const input of [{ queries: [] }, { queries: ['!!!'] }, { queries: ['x'], limit: 101 }, { queries: ['x'.repeat(501)] }]) {
      expect(() => searchDocuments(store.db, input)).toThrow();
    }
    expect(() => searchDocuments(store.db, { queries: ['" OR * - NEAR(foo)'] })).not.toThrow();
    expect(store.db.prepare('SELECT count(*) AS count FROM resources').get()).toHaveProperty('count');
  });

  it('backfills an existing database once without changing authored documents or versions', () => {
    const directory = mkdtempSync(join(tmpdir(), 'wm-search-upgrade-'));
    const path = join(directory, 'store.sqlite');
    try {
      const store = openStore(path);
      const doc = store.createDocument({ kind: 'Topic', spec: { title: 'upgradeterm', body: '# Authored\r\n\n**Markdown**' } });
      store.db.exec(`DROP TRIGGER document_search_insert; DROP TRIGGER document_search_update;
        DROP TRIGGER document_search_delete; DROP TABLE document_search;`);
      store.close();
      for (let attempt = 0; attempt < 2; attempt++) {
        const upgraded = openStore(path);
        try {
          expect(upgraded.getDocument({ id: doc.metadata.id })).toEqual(doc);
          expect(searchDocuments(upgraded.db, { queries: ['upgradeterm'] }).count).toBe(1);
        } finally { upgraded.close(); }
      }
    } finally { rmSync(directory, { recursive: true, force: true }); }
  });

  it('exposes ranked search through authenticated MCP and the typed client', async () => {
    const store = fixture();
    new InstanceFeatureStore(store.db).write({ search: true });
    const doc = store.createDocument({ kind: 'Topic', spec: { title: 'Authentication', body: 'OAuth sign in reliability' } });
    const server = await startServer({ port: 0, store });
    const client = new ControlPlaneClient({ resolveUrl: () => `${server.url}/mcp` });
    try {
      expect(await client.searchDocuments({ queries: ['sign in'], kinds: ['Topic'] })).toMatchObject({
        count: 1, results: [{ id: doc.metadata.id, title: 'Authentication', kind: 'Topic' }],
      });
    } finally { await client.dispose(); await server.close(); }
  });

  it('repairs older projections without changing authored resources', () => {
    const store = fixture();
    const doc = store.createDocument({ kind: 'Workstream', spec: { title: 'WM 1.5', status: 'progress' } });
    store.db.prepare("UPDATE document_search SET body = '' WHERE id = ?").run(doc.metadata.id);
    store.db.prepare("UPDATE store_meta SET value = 1 WHERE key = 'document_search_version'").run();
    expect(searchDocuments(store.db, { queries: ['WM 1.5'] }).results[0].excerpt).toBe('WM 1.5');
    expect(store.getDocument({ id: doc.metadata.id })).toEqual(doc);
  });

  it('does not mark fallback projections current before kinds have registered', async () => {
    clearKinds();
    const store = fixture();
    try {
      store.createDocument({ kind: 'CommandJournal', spec: { request: { userText: 'journalneedle' } } });
      await loadKinds();
      expect(searchDocuments(store.db, { queries: ['journalneedle'] }).count).toBe(1);
    } finally { await loadKinds(); }
  });

  it('queries membership, lifecycle and literal version text without loading all documents', () => {
    const store = fixture();
    const ws = store.createDocument({ kind: 'Workstream', spec: { title: 'WM 1.5', status: 'progress' } });
    const topic = store.createDocument({ kind: 'Topic', spec: { title: 'Windows spell checking', body: 'No release version in this body.',
      status: 'open', workstreams: [ws.metadata.id], parents: ['parent'], topicType: 'case' } });
    store.createDocument({ kind: 'Topic', spec: { title: 'Other', body: 'WM 1.5', status: 'closed', workstreams: [] } });
    const result = queryDocuments(store.db, { workstream: ws.metadata.id, status: 'open', parent: 'parent', topicType: 'case' }, () => true);
    expect(result.total).toBe(1);
    expect(result.documents[0]).toMatchObject({ id: topic.metadata.id, workstreams: [ws.metadata.id], status: 'open' });
    expect(queryDocuments(store.db, { kind: 'Workstream', query: 'WM 1.5' }, () => true).total).toBe(1);
    expect(() => queryDocuments(store.db, { kind: 'Workstream', workstream: ws.metadata.id }, () => true)).toThrow();
  });

  it('bounds pages and bodies, detects changed snapshots, and filters permissions before counting', () => {
    const store = fixture();
    for (let i = 0; i < 25; i++) store.createDocument({ kind: 'Topic', spec: { title: `Topic ${i}`, body: 'Long authored body', status: 'open' } });
    store.createDocument({ kind: 'Config', spec: { name: 'Secret', data: { password: 'do-not-expose' } } });
    const first = queryDocuments(store.db, { limit: 20, bodyLimit: 8 }, kind => kind === 'Topic');
    expect(first).toMatchObject({ count: 20, total: 25, nextOffset: 20 });
    expect(first.documents.every(doc => doc.body.length <= 8 && doc.nextBodyOffset === 8)).toBe(true);
    const last = queryDocuments(store.db, { limit: 20, offset: 20, expectedVersion: first.version }, kind => kind === 'Topic');
    expect(last).toMatchObject({ count: 5, total: 25, nextOffset: null });
    expect(queryDocuments(store.db, {}, () => false).total).toBe(0);
    expect(queryDocuments(store.db, { query: 'do-not-expose' }, () => true).total).toBe(0);
    store.createDocument({ kind: 'Topic', spec: { title: 'Changed', body: '' } });
    expect(() => queryDocuments(store.db, { expectedVersion: first.version }, () => true)).toThrow('Documents changed');
  });

  it('exposes structured reads through MCP without requiring write permissions', async () => {
    const store = fixture();
    new InstanceFeatureStore(store.db).write({ search: true });
    const doc = store.createDocument({ kind: 'Topic', spec: { title: 'Azure capacity', body: 'Capacity queries', workstreams: ['release'] } });
    const server = await startServer({ port: 0, store });
    const client = new ControlPlaneClient({ resolveUrl: () => `${server.url}/mcp` });
    try {
      expect(await client.callTool('wm-document-query', { workstream: 'release' })).toMatchObject({
        ok: true, result: { total: 1, documents: [{ id: doc.metadata.id }] },
      });
      expect(await client.callTool('wm-document-query', { kind: 'Config' })).toMatchObject({ ok: false });
    } finally { await client.dispose(); await server.close(); }
  });

  it('slices large evidence in SQLite and pages by Unicode code points without splitting characters', () => {
    const store = fixture();
    const body = 'A\u{1f600}BC'.repeat(30_000);
    const doc = store.createDocument({ kind: 'Topic', spec: { title: 'Large body', body } });
    const prepare = vi.spyOn(store.db, 'prepare');
    try {
      const first = queryDocuments(store.db, { id: doc.metadata.id, bodyOffset: 11, bodyLimit: 2 }, () => true);
      expect(first.documents[0]).toMatchObject({ body: 'A\u{1f600}', bodyLength: 120_011, nextBodyOffset: 13 });
      const next = queryDocuments(store.db, { id: doc.metadata.id, bodyOffset: 13, bodyLimit: 2 }, () => true);
      expect(next.documents[0]).toMatchObject({ body: 'BC', bodyOffset: 13, nextBodyOffset: 15 });
      expect(JSON.stringify(first).length).toBeLessThan(1_000);
      expect(prepare.mock.calls.some(([sql]) => sql.includes('substr(evidence, ?, ?) AS body'))).toBe(true);
    } finally { prepare.mockRestore(); }
  });

  it('includes exact AgentMessage scheduling, recommendation and relationship facts without opaque metadata', () => {
    const store = fixture();
    const agent = store.createDocument({ kind: 'Agent', spec: { name: 'Search evidence tests' } });
    const message = store.createDocument({ kind: 'AgentMessage', spec: {
      agent_id: agent.metadata.id, title: 'Review release', description: 'Authored reminder text.',
      category: 'reminder', due_at: 1_950_000_000, recommended_action: 'Review the release checklist.',
      topics: [], relations: [],
    } });
    const result = queryDocuments(store.db, { id: message.metadata.id }, () => true);
    const evidence = result.documents[0].body;
    expect(JSON.parse(evidence.split('\n')[0])).toMatchObject({
      category: 'reminder', due_at: 1_950_000_000, severity: 'info', attention: false,
      recommended_action: 'Review the release checklist.', agent_id: agent.metadata.id,
      agent_name: 'Search evidence tests', topics: [], relations: [],
    });
    expect(evidence).toContain('Authored reminder text.');
    expect(evidence).not.toContain('legacy_source');
    expect(store.getDocument({ id: message.metadata.id })).toEqual(message);
    store.db.prepare("UPDATE document_search SET body = 'Old prose-only projection' WHERE id = ?").run(message.metadata.id);
    store.db.prepare("UPDATE store_meta SET value = 2 WHERE key = 'document_search_version'").run();
    expect(queryDocuments(store.db, { kind: 'AgentMessage', query: 'release checklist' }, () => true).documents[0].id).toBe(message.metadata.id);
    for (const phrase of ['release checklist', '1950000000', agent.metadata.id]) {
      expect(searchDocuments(store.db, { queries: [phrase] }).results.some(hit => hit.id === message.metadata.id)).toBe(true);
    }
    expect(store.getDocument({ id: message.metadata.id })).toEqual(message);
  });

  it.each(['normal', 'closed', 'disabled', 'conflict'])('enforces atomic Search membership at the write boundary: %s', async mode => {
    const store = fixture();
    const flags = new InstanceFeatureStore(store.db);
    flags.write({ search: true });
    const workstream = store.createDocument({ kind: 'Workstream', spec: { title: 'Target', status: 'progress' } });
    const type = store.createDocument({ kind: 'TopicType', spec: { label: 'Case', icon: 'notebook', description: 'Cases' } });
    const topic = store.createDocument({ kind: 'Topic', spec: {
      title: 'Membership', body: 'Authored body', status: 'open', workstreams: ['existing'],
      parents: ['parent'], focusedWorkstreams: ['existing'], topicType: type.metadata.id,
    } });
    const update = store.updateDocument.bind(store);
    const spy = vi.spyOn(store, 'updateDocument').mockImplementation((input, preconditions) => {
      if (mode === 'closed') update({ id: workstream.metadata.id, expectedResourceVersion: workstream.metadata.resourceVersion,
        spec: { ...workstream.spec, status: 'closed' } });
      if (mode === 'disabled') flags.write({ search: false });
      if (mode === 'conflict') update({ id: topic.metadata.id, expectedResourceVersion: topic.metadata.resourceVersion,
        spec: { ...topic.spec, body: 'Concurrent edit' } });
      return update(input, preconditions);
    });
    const server = await startServer({ port: 0, store });
    const client = new ControlPlaneClient({ resolveUrl: () => `${server.url}/mcp` });
    try {
      const result = await client.callTool('wm-search-add-topic', {
        id: topic.metadata.id, workstreamId: workstream.metadata.id, expectedResourceVersion: topic.metadata.resourceVersion,
      });
      const saved = store.getDocument({ id: topic.metadata.id })!;
      if (mode === 'normal') {
        expect(result.ok).toBe(true);
        expect(saved.spec).toEqual({ ...topic.spec, workstreams: ['existing', workstream.metadata.id] });
        const version = store.getResourceVersion();
        expect(await client.callTool('wm-search-add-topic', { id: topic.metadata.id, workstreamId: workstream.metadata.id,
          expectedResourceVersion: saved.metadata.resourceVersion })).toMatchObject({ ok: true });
        expect(store.getResourceVersion()).toBe(version);
      } else {
        expect(result).toMatchObject({ ok: false, error: expect.stringMatching(
          mode === 'closed' ? /no longer open/ : mode === 'disabled' ? /turned off/ : /Conflict/,
        ) });
        expect(saved.spec).toEqual({ ...topic.spec, ...(mode === 'conflict' ? { body: 'Concurrent edit' } : {}) });
      }
    } finally { spy.mockRestore(); await client.dispose(); await server.close(); }
  });

  it('blocks both search tools by default and rechecks the flag on existing MCP sessions', async () => {
    const store = fixture();
    const doc = store.createDocument({ kind: 'Topic', spec: { title: 'Flag test', body: 'Retained markdown' } });
    const flags = new InstanceFeatureStore(store.db);
    const server = await startServer({ port: 0, store });
    const client = new ControlPlaneClient({ resolveUrl: () => `${server.url}/mcp` });
    try {
      for (const enabled of [false, true, false]) {
        flags.write({ search: enabled });
        const query = await client.callTool('wm-document-query', { kind: 'Topic' });
        const search = await client.callTool('wm-document-search', { queries: ['Flag test'] });
        if (enabled) {
          expect(query).toMatchObject({ ok: true, result: { count: 1 } });
          expect(search).toMatchObject({ ok: true, result: { count: 1 } });
        } else {
          expect(query).toMatchObject({ ok: false, error: expect.stringContaining('Search is turned off') });
          expect(search).toMatchObject({ ok: false, error: expect.stringContaining('Search is turned off') });
        }
      }
      expect(store.getDocument({ id: doc.metadata.id })).toEqual(doc);
    } finally { await client.dispose(); await server.close(); }
  });
});
