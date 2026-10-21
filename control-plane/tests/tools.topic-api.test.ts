import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { openStore, type Store } from '../src/store';
import { startServer } from '../src/server';
import { loadKinds } from '../src/kinds/loader';
import { validateSpec } from '../src/kinds/registry';
import type { ITopic } from '../src/kinds/topic/topic';

const cleanup: Array<() => Promise<void>> = [];
beforeAll(async () => { await loadKinds(); });
afterEach(async () => { vi.restoreAllMocks(); for (const close of cleanup.splice(0)) await close(); });

function text(result: unknown): string {
  return (result as { content: Array<{ text?: string }> }).content.map((item) => item.text ?? '').join('');
}
function json<T>(result: unknown): T { return JSON.parse(text(result)) as T; }
function error(result: unknown): boolean { return (result as { isError?: boolean }).isError === true; }

async function connect() {
  const store = openStore(':memory:');
  const type = store.createDocument({ kind: 'TopicType', spec: { label: 'Topic', icon: 'symbol-key' } }).metadata.id;
  const server = await startServer({ port: 0, store });
  const client = new Client({ name: 'topic-id-tests', version: '1' });
  await client.connect(new StreamableHTTPClientTransport(new URL(`${server.url}/mcp`)));
  cleanup.push(async () => { await client.close(); await server.close(); store.close(); });
  const call = (name: string, args: Record<string, unknown>) => client.callTool({ name, arguments: args });
  const workstream = (title: string) => store.createDocument({ kind: 'Workstream', spec: { title, status: 'progress' } }).metadata.id;
  const seed = (title: string, extra: Record<string, unknown> = {}) => store.createDocument({
    kind: 'Topic', spec: validateSpec('Topic', { title, topicType: type, ...extra }),
  }).metadata.id;
  const read = async (id: string) => json<{ topics: ITopic[] }>(await call('ws-topic-read', { id })).topics[0];
  return { store, client, type, call, workstream, seed, read };
}

describe('Topic ID-only domain API', () => {
  it('exposes strict ID-only schemas and no create-time locator', async () => {
    const { client, call } = await connect();
    const tools = (await client.listTools()).tools;
    for (const name of ['ws-topic-read', 'ws-topic-update', 'ws-topic-delete', 'ws-topic-transfer', 'ws-topic-close-tree']) {
      const schema = tools.find((tool) => tool.name === name)!.inputSchema;
      expect(schema.properties).toHaveProperty('id');
      expect(schema.properties).not.toHaveProperty('slug');
      expect(schema.additionalProperties).toBe(false);
    }
    const create = tools.find((tool) => tool.name === 'ws-topic-create')!.inputSchema;
    expect(create.properties).not.toHaveProperty('id');
    expect(create.properties).not.toHaveProperty('slug');
    expect(error(await call('ws-topic-read', { slug: 'old-name' }))).toBe(true);
    expect(error(await call('ws-topic-create', { title: 'Bad', slug: 'old-name' }))).toBe(true);
  });

  it('creates distinct IDs for duplicate titles, applies defaults, and permits unassigned topics', async () => {
    const { call, type } = await connect();
    const a = json<ITopic>(await call('ws-topic-create', { title: 'Same title' }));
    const b = json<ITopic>(await call('ws-topic-create', { title: 'Same title' }));
    expect(a).toMatchObject({ title: 'Same title', status: 'open', body: '', topicType: type, parents: [], workstreams: [], focusedWorkstreams: [] });
    expect(a.id).not.toBe(b.id);
    expect(a).not.toHaveProperty('slug');
    expect(a.resourceVersion).toBeGreaterThan(0);
  });

  it('reads by ID, query, workstream and pages; names never resolve as IDs', async () => {
    const { call, workstream, seed } = await connect();
    const ws = workstream('Release');
    const a = seed('Alpha Widget', { workstreams: [ws] });
    const b = seed('Beta Gadget');
    expect(json<{ topics: ITopic[] }>(await call('ws-topic-read', { id: a })).topics[0].id).toBe(a);
    expect(json<{ topics: ITopic[] }>(await call('ws-topic-read', { id: 'Alpha Widget' })).topics).toEqual([]);
    expect(json<{ topics: ITopic[] }>(await call('ws-topic-read', { workstream: ws })).topics.map((topic) => topic.id)).toEqual([a]);
    expect(json<{ topics: ITopic[] }>(await call('ws-topic-read', { query: 'gAdGeT' })).topics[0].id).toBe(b);
    expect(json<{ topics: ITopic[] }>(await call('ws-topic-read', { limit: 1 })).topics[0].id).toBe(b);
  });

  it('inherits parent memberships and validates all reference IDs', async () => {
    const { call, workstream, seed } = await connect();
    const ws = workstream('One');
    const parent = seed('Parent', { workstreams: [ws] });
    const child = json<ITopic>(await call('ws-topic-create', { title: 'Child', parents: [parent] }));
    expect(child.workstreams).toEqual([ws]);
    for (const fields of [{ parents: ['missing'] }, { workstreams: ['missing'] }, { topicType: 'missing' }, { focusedWorkstreams: [ws] }]) {
      expect(error(await call('ws-topic-create', { title: 'Invalid', ...fields }))).toBe(true);
    }
    expect(error(await call('ws-topic-update', { id: parent, parents: [child.id] }))).toBe(true);
    expect(error(await call('ws-topic-update', { id: parent, parents: ['missing'] }))).toBe(true);
  });

  it('updates, clears stale focus, and deletes/restores by immutable ID', async () => {
    const { call, workstream, read } = await connect();
    const ws = workstream('Focus');
    const initial = json<ITopic>(await call('ws-topic-create', { title: 'Before', workstreams: [ws], focusedWorkstreams: [ws] }));
    const updated = json<ITopic>(await call('ws-topic-update', { id: initial.id, title: 'After', workstreams: [] }));
    expect(updated).toMatchObject({ id: initial.id, title: 'After', workstreams: [], focusedWorkstreams: [] });
    expect(error(await call('ws-topic-update', { id: initial.id, expectedResourceVersion: initial.resourceVersion, title: 'Stale' }))).toBe(true);
    expect(error(await call('ws-topic-update', { id: initial.id, status: 'invalid' }))).toBe(true);
    expect(error(await call('ws-topic-delete', { id: 'missing' }))).toBe(true);
    expect(error(await call('ws-topic-delete', { id: initial.id }))).toBe(false);
    expect(await read(initial.id)).toBeUndefined();
    expect(error(await call('ws-topic-delete', { id: initial.id, restore: true }))).toBe(false);
    expect((await read(initial.id)).title).toBe('After');
  });

  it('copies and moves the source-membership descendant closure atomically', async () => {
    const { call, workstream, seed, read } = await connect();
    const source = workstream('Source'), target = workstream('Target'), moved = workstream('Moved');
    const root = seed('Root', { workstreams: [source], focusedWorkstreams: [source] });
    const child = seed('Child', { parents: [root], workstreams: [source] });
    const unrelated = seed('Unrelated', { parents: [root] });
    const copied = json<ITopic[]>(await call('ws-topic-transfer', { id: root, sourceWorkstream: source, targetWorkstream: target }));
    expect(copied.map((topic) => topic.id)).toEqual([root, child]);
    expect((await read(root)).workstreams).toEqual([source, target]);
    expect((await read(unrelated)).workstreams).toEqual([]);
    await call('ws-topic-transfer', { id: root, sourceWorkstream: source, targetWorkstream: moved, move: true });
    expect((await read(root))).toMatchObject({ workstreams: [target, moved], focusedWorkstreams: [] });
    expect(error(await call('ws-topic-transfer', { id: root, sourceWorkstream: moved, targetWorkstream: 'missing' }))).toBe(true);
  });

  it('dry-runs deterministic close plans, counts no-ops and skips shared descendants transitively', async () => {
    const { call, seed, read } = await connect();
    const root = seed('Root'), outside = seed('Outside');
    const own = seed('Own', { parents: [root], status: 'closed' });
    const shared = seed('Shared', { parents: [root, outside] });
    const below = seed('Below', { parents: [shared] });
    const plan = json<Record<string, unknown>>(await call('ws-topic-close-tree', { id: root, dryRun: true }));
    expect(plan).toMatchObject({ matchedIds: [root, own], closedIds: [root], alreadyClosedIds: [own], skippedSharedCount: 2 });
    expect((await read(root)).status).toBe('open');
    expect(json<Record<string, unknown>>(await call('ws-topic-close-tree', { id: root }))).toMatchObject({ closedCount: 1, alreadyClosedCount: 1 });
    const forced = json<{ matchedIds: string[] }>(await call('ws-topic-close-tree', { id: root, includeSharedDescendants: true }));
    expect(new Set(forced.matchedIds)).toEqual(new Set([root, own, shared, below]));
    expect(json<Record<string, unknown>>(await call('ws-topic-close-tree', { id: root, includeSharedDescendants: true }))).toMatchObject({ closedCount: 0, alreadyClosedCount: 4 });
  });

  it('rejects cycles without any writes', async () => {
    const { store, call, seed } = await connect();
    const root = seed('Root'), child = seed('Child', { parents: [root] });
    const doc = store.getDocument({ id: root })!;
    store.updateDocument({ id: root, expectedResourceVersion: doc.metadata.resourceVersion, spec: { ...doc.spec, parents: [child] } });
    const version = store.getResourceVersion();
    expect(text(await call('ws-topic-close-tree', { id: root }))).toContain('cycle detected');
    expect(store.getResourceVersion()).toBe(version);
  });

  it('rolls back a large close batch on conflict and closes more than 500 nodes on retry', async () => {
    const { store, call, seed } = await connect();
    const root = seed('Root');
    for (let i = 0; i < 510; i++) seed(`Child ${i}`, { parents: [root] });
    const original = store.updateDocuments;
    const spy = vi.spyOn(store, 'updateDocuments').mockImplementation((inputs) => original(inputs.map((input, i) => i === inputs.length - 1 ? { ...input, expectedResourceVersion: -1 } : input)));
    const version = store.getResourceVersion();
    expect(error(await call('ws-topic-close-tree', { id: root }))).toBe(true);
    expect(store.getResourceVersion()).toBe(version);
    expect(store.listDocuments({ kind: 'Topic' }).every((topic) => topic.spec.status === 'open')).toBe(true);
    spy.mockRestore();
    expect(json<Record<string, unknown>>(await call('ws-topic-close-tree', { id: root }))).toMatchObject({ closedCount: 511 });
  });

  it('handles 5000-node linear trees iteratively and rejects 5001 without writing', async () => {
    const { store, call, seed } = await connect();
    const root = seed('Root');
    let parent = root;
    for (let i = 1; i < 5000; i++) parent = seed(`Node ${i}`, { parents: [parent] });
    const version = store.getResourceVersion();
    expect(json<Record<string, unknown>>(await call('ws-topic-close-tree', { id: root, dryRun: true }))).toMatchObject({ matchedCount: 5000 });
    expect(store.getResourceVersion()).toBe(version);
    seed('Too many', { parents: [parent] });
    expect(text(await call('ws-topic-close-tree', { id: root, dryRun: true }))).toContain('5000');
  });
});
