import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '../../tests/authenticatedFixture';
import { openStore, type DocumentEnvelope } from '../src/store';
import { startServer } from '../../tests/authenticatedFixture';
import { loadKinds } from '../src/kinds/loader';

const cleanup: Array<() => Promise<void>> = [];
beforeAll(async () => { await loadKinds(); });
afterEach(async () => { for (const close of cleanup.splice(0)) await close(); });
function text(result: unknown): string { return (result as { content: Array<{ text?: string }> }).content.map((item) => item.text ?? '').join(''); }
function json<T>(result: unknown): T { return JSON.parse(text(result)) as T; }
function error(result: unknown): boolean { return (result as { isError?: boolean }).isError === true; }
async function connect() {
  const store = openStore(':memory:');
  const type = store.createDocument({ kind: 'TopicType', spec: { label: 'Topic' } }).metadata.id;
  const server = await startServer({ port: 0, store });
  const client = new Client({ name: 'document-id-tests', version: '1' });
  await client.connect(new StreamableHTTPClientTransport(new URL(`${server.url}/mcp`)));
  cleanup.push(async () => { await client.close(); await server.close(); store.close(); });
  const call = (name: string, args: Record<string, unknown>) => client.callTool({ name, arguments: args });
  const create = async (title: string) => json<DocumentEnvelope>(await call('wm-document-create', { kind: 'Topic', spec: { title } }));
  return { store, client, type, call, create };
}
describe('generic ID-only document tools', () => {
  it('creates ID-only envelopes and returns a uniform list/single read shape with kind filtering', async () => {
    const { client, type, call, create } = await connect();
    const created = await create('Demo');
    expect(created.metadata).not.toHaveProperty('slug');
    expect(created.metadata.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(created.spec).toEqual({ title: 'Demo', body: '', status: 'open', topicType: type, parents: [], workstreams: [], focusedWorkstreams: [] });
    const got = json<{ count: number; documents: DocumentEnvelope[] }>(await call('wm-document-read', { id: created.metadata.id }));
    expect(got).toEqual({ count: 1, documents: [created] });
    expect(json(await call('wm-document-read', { id: created.metadata.id, kind: 'Config' }))).toEqual({ count: 0, documents: [] });
    expect(json(await call('wm-document-read', { id: 'Demo' }))).toEqual({ count: 0, documents: [] });
    const schemas = (await client.listTools()).tools.filter((tool) => ['wm-document-create', 'wm-document-read', 'wm-document-update'].includes(tool.name));
    for (const tool of schemas) {
      expect(tool.inputSchema.properties).not.toHaveProperty('slug');
      expect(tool.inputSchema.additionalProperties).toBe(false);
    }
  });

  it('rejects obsolete locators, unknown kinds/fields and invalid references without writing', async () => {
    const { store, call, type } = await connect();
    const before = store.getResourceVersion();
    for (const args of [
      { kind: 'Topic', slug: 'old-name', spec: { title: 'Bad' } },
      { kind: 'unknown', spec: {} },
      { kind: 'Topic', spec: { topicType: type } },
      { kind: 'Topic', spec: { title: 'Bad', bogus: true } },
      { kind: 'Topic', spec: { title: 'Bad', topicType: 'missing' } },
      { kind: 'Topic', spec: { title: 'Bad', workstreams: ['missing'] } },
    ]) expect(error(await call('wm-document-create', args))).toBe(true);
    expect(error(await call('wm-document-read', { slug: 'old-name' }))).toBe(true);
    expect(store.getResourceVersion()).toBe(before);
  });

  it('supports newest-first lists, case-insensitive search, kind filters and pagination', async () => {
    const { store, call, create } = await connect();
    const alpha = await create('Alpha Widget'), beta = await create('Beta Gadget');
    store.createDocument({ kind: 'legacy', spec: {} });
    const read = async (args: Record<string, unknown>) => json<{ documents: DocumentEnvelope[] }>(await call('wm-document-read', args)).documents;
    expect((await read({ kind: 'Topic' })).map((doc) => doc.metadata.id)).toEqual([beta.metadata.id, alpha.metadata.id]);
    expect((await read({ query: 'gAdGeT' }))[0].metadata.id).toBe(beta.metadata.id);
    expect((await read({ kind: 'Topic', offset: 1, limit: 1 }))[0].metadata.id).toBe(alpha.metadata.id);
    expect(await read({ query: 'no match' })).toEqual([]);
  });

  it('shallow-merges specs with CAS, replaces labels and rejects invalid/no-op updates', async () => {
    const { call, create } = await connect();
    const initial = await create('Before');
    const updated = json<DocumentEnvelope>(await call('wm-document-update', {
      id: initial.metadata.id, expectedResourceVersion: initial.metadata.resourceVersion, spec: { body: 'Authored' }, labels: { area: 'core' },
    }));
    expect(updated.spec).toMatchObject({ title: 'Before', body: 'Authored' });
    expect(updated.metadata.labels).toEqual({ area: 'core' });
    expect(updated.metadata.resourceVersion).toBeGreaterThan(initial.metadata.resourceVersion);
    for (const patch of [
      { expectedResourceVersion: initial.metadata.resourceVersion, spec: { title: 'Stale' } },
      { spec: { bogus: true } }, { spec: { parents: ['missing'] } }, {}, { slug: 'renamed' },
    ]) expect(error(await call('wm-document-update', { id: initial.metadata.id, expectedResourceVersion: updated.metadata.resourceVersion, ...patch }))).toBe(true);
    const relabeled = json<DocumentEnvelope>(await call('wm-document-update', { id: initial.metadata.id, expectedResourceVersion: updated.metadata.resourceVersion, labels: {} }));
    expect(relabeled.metadata.labels).toEqual({});
    expect(relabeled.spec).toEqual(updated.spec);
    expect(error(await call('wm-document-update', { id: 'missing', expectedResourceVersion: 1, spec: {} }))).toBe(true);
  });

  it('deletes and restores by ID including unregistered legacy kinds, with optional CAS', async () => {
    const { store, call, create } = await connect();
    const doc = await create('Keep');
    expect(error(await call('wm-document-delete', { id: doc.metadata.id, slug: 'obsolete' }))).toBe(true);
    expect(error(await call('wm-document-delete', { id: doc.metadata.id, expectedResourceVersion: -1 }))).toBe(true);
    const deleted = json<DocumentEnvelope>(await call('wm-document-delete', { id: doc.metadata.id }));
    expect(deleted.metadata.deletedAt).not.toBeNull();
    expect(json(await call('wm-document-read', { id: doc.metadata.id }))).toEqual({ count: 0, documents: [] });
    expect(json<{ count: number }>(await call('wm-document-read', { id: doc.metadata.id, includeDeleted: true })).count).toBe(1);
    const restored = json<DocumentEnvelope>(await call('wm-document-delete', { id: doc.metadata.id, restore: true }));
    expect(restored.metadata.deletedAt).toBeNull();
    expect(restored.spec).toEqual(doc.spec);
    const legacy = store.createDocument({ kind: 'unregistered', spec: { arbitrary: true } });
    expect(error(await call('wm-document-delete', { id: legacy.metadata.id }))).toBe(false);
    expect(error(await call('wm-document-delete', { id: legacy.metadata.id, restore: true }))).toBe(false);
  });
});
