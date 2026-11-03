import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
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
