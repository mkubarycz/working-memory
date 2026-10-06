import { describe, it, expect, beforeAll } from 'vitest';
import { startServer } from '../src/server';
import { openStore, type Store } from '../src/store';
import { clearKinds, validateSpec } from '../src/kinds/registry';
import { loadKinds } from '../src/kinds/loader';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

let sqliteAvailable = true;
try {
  await import('node:sqlite');
} catch {
  sqliteAvailable = false;
}

interface TextContent {
  type: string;
  text?: string;
}

function textOf(res: unknown): string {
  const content = (res as { content: TextContent[] }).content;
  return content.find((c) => c.type === 'text')?.text ?? '';
}

function jsonOf<T>(res: unknown): T {
  return JSON.parse(textOf(res)) as T;
}

function isErrorResult(res: unknown): boolean {
  return (res as { isError?: boolean }).isError === true;
}

/** The legacy topic shape the ws-topic-* API maps documents to. */
interface ITopic {
  id: string;
  slug: string | null;
  title: string;
  body: string;
  status: string;
  topicType: string;
  parents: string[];
  workstreams: string[];
  focusedWorkstreams: string[];
  created_at: number;
  updated_at: number;
  resourceVersion: number;
}

interface TopicList {
  count: number;
  topics: ITopic[];
}

let clientSeq = 0;

/** Stand up an ephemeral server + connected MCP client over the given store. */
async function connect(store: Store): Promise<{
  client: Client;
  close: () => Promise<void>;
}> {
  const server = await startServer({ port: 0, store });
  const client = new Client({ name: `wm-cp-topic-api-${++clientSeq}`, version: '0.0.0' });
  const transport = new StreamableHTTPClientTransport(new URL(`${server.url}/mcp`));
  await client.connect(transport);
  return {
    client,
    close: async () => {
      await client.close();
      await server.close();
      store.close();
    },
  };
}

(sqliteAvailable ? describe : describe.skip)('control-plane Topic ws-topic-* API', () => {
  beforeAll(async () => {
    // Populate the kind registry (Topic's registerApi is what wires ws-topic-*).
    clearKinds();
    await loadKinds();
  });

  it('exposes ws-topic-* tools alongside the generic wm-document-* and ws-* tools', async () => {
    const { client, close } = await connect(openStore(':memory:'));
    try {
      const names = (await client.listTools()).tools.map((t) => t.name);
      // Generic CRUD is still present …
      expect(names).toContain('wm-document-create');
      expect(names).toContain('wm-document-read');
      // … the Workstream kind's API is present …
      expect(names).toEqual(expect.arrayContaining(['ws-workstream-create', 'ws-workstream-read']));
      // … PLUS the Topic kind's domain API (registered via its registerApi).
      expect(names).toEqual(
        expect.arrayContaining([
          'ws-topic-create',
          'ws-topic-read',
          'ws-topic-update',
          'ws-topic-delete',
          'ws-topic-transfer',
          'ws-topic-close-tree',
        ]),
      );
      const closeTree = (await client.listTools()).tools.find((tool) => tool.name === 'ws-topic-close-tree');
      expect(closeTree?.description).toContain('instead of many ws-topic-update calls');
      expect(closeTree?.inputSchema).toMatchObject({
        required: ['slug'],
        properties: {
          includeSharedDescendants: { type: 'boolean', default: false },
          dryRun: { type: 'boolean', default: false },
        },
      });
    } finally {
      await close();
    }
  });

  it('closes a deterministic tree, reports no-ops, and supports exact dry runs', async () => {
    const { client, close } = await connect(openStore(':memory:'));
    try {
      await client.callTool({ name: 'ws-workstream-create', arguments: { slug: 'tree-work', title: 'Tree' } });
      const create = (slug: string, parents: string[] = [], status = 'open') => client.callTool({
        name: 'ws-topic-create', arguments: { slug, title: slug, parents, status, workstreams: ['tree-work'] },
      });
      await create('solo');
      await create('root');
      await create('z-child', ['root']);
      await create('a-child', ['root'], 'closed');
      await create('grandchild', ['a-child']);

      const solo = jsonOf<any>(await client.callTool({
        name: 'ws-topic-close-tree', arguments: { slug: 'solo' },
      }));
      expect(solo).toMatchObject({ matchedCount: 1, closedCount: 1, alreadyClosedCount: 0, matchedSlugs: ['solo'] });

      const dryRun = jsonOf<any>(await client.callTool({
        name: 'ws-topic-close-tree', arguments: { slug: 'root', dryRun: true },
      }));
      expect(dryRun).toMatchObject({
        dryRun: true,
        matchedSlugs: ['root', 'a-child', 'z-child', 'grandchild'],
        closedSlugs: ['root', 'z-child', 'grandchild'],
        alreadyClosedSlugs: ['a-child'],
      });
      const before = jsonOf<TopicList>(await client.callTool({
        name: 'ws-topic-read', arguments: { slug: 'root' },
      })).topics[0];
      expect(before.status).toBe('open');

      const closed = jsonOf<any>(await client.callTool({
        name: 'ws-topic-close-tree', arguments: { slug: 'root' },
      }));
      expect(closed).toMatchObject({ matchedCount: 4, closedCount: 3, alreadyClosedCount: 1 });
      const repeated = jsonOf<any>(await client.callTool({
        name: 'ws-topic-close-tree', arguments: { slug: 'root' },
      }));
      expect(repeated).toMatchObject({ matchedCount: 4, closedCount: 0, alreadyClosedCount: 4 });

      const missing = await client.callTool({
        name: 'ws-topic-close-tree', arguments: { slug: 'missing' },
      });
      expect(isErrorResult(missing)).toBe(true);
      expect(textOf(missing)).toContain('Unknown topic slug');
    } finally {
      await close();
    }
  });

  it('skips shared descendants to a fixed point unless explicitly included', async () => {
    const { client, close } = await connect(openStore(':memory:'));
    try {
      await client.callTool({ name: 'ws-workstream-create', arguments: { slug: 'shared-work', title: 'Shared' } });
      const create = (slug: string, parents: string[] = []) => client.callTool({
        name: 'ws-topic-create', arguments: { slug, title: slug, parents, workstreams: ['shared-work'] },
      });
      await create('root');
      await create('outside');
      await create('shared-child', ['root', 'outside']);
      await create('below-shared', ['shared-child']);
      await create('private-child', ['root']);

      const safe = jsonOf<any>(await client.callTool({
        name: 'ws-topic-close-tree', arguments: { slug: 'root' },
      }));
      expect(safe.matchedSlugs).toEqual(['root', 'private-child']);
      expect(safe.skippedSharedSlugs).toEqual(['shared-child', 'below-shared']);

      const forced = jsonOf<any>(await client.callTool({
        name: 'ws-topic-close-tree', arguments: { slug: 'root', includeSharedDescendants: true },
      }));
      expect(forced.matchedSlugs).toEqual(['root', 'private-child', 'shared-child', 'below-shared']);
      expect(forced.skippedSharedCount).toBe(0);
      expect(forced.closedSlugs).toEqual(['shared-child', 'below-shared']);
    } finally {
      await close();
    }
  });

  it('rejects cycles before writing', async () => {
    const store = openStore(':memory:');
    const { client, close } = await connect(store);
    try {
      await client.callTool({ name: 'ws-workstream-create', arguments: { slug: 'cycle-work', title: 'Cycle' } });
      await client.callTool({ name: 'ws-topic-create', arguments: {
        slug: 'root', title: 'root', parents: ['child'], workstreams: ['cycle-work'],
      } });
      await client.callTool({ name: 'ws-topic-create', arguments: {
        slug: 'child', title: 'child', parents: ['root'], workstreams: ['cycle-work'],
      } });
      const result = await client.callTool({ name: 'ws-topic-close-tree', arguments: { slug: 'root' } });
      expect(isErrorResult(result)).toBe(true);
      expect(textOf(result)).toContain('cycle detected');
      expect(store.getDocument({ slug: 'root', kind: 'Topic' })?.spec.status).toBe('open');
      expect(store.getDocument({ slug: 'child', kind: 'Topic' })?.spec.status).toBe('open');
    } finally {
      await close();
    }
  });

  it('rejects cycle-forming and unknown parents during topic updates', async () => {
    const store = openStore(':memory:');
    const { client, close } = await connect(store);
    try {
      await client.callTool({ name: 'ws-workstream-create', arguments: { slug: 'reparent-work', title: 'Reparent' } });
      await client.callTool({ name: 'ws-topic-create', arguments: {
        slug: 'root', title: 'root', workstreams: ['reparent-work'],
      } });
      await client.callTool({ name: 'ws-topic-create', arguments: {
        slug: 'child', title: 'child', parents: ['root'], workstreams: ['reparent-work'],
      } });

      const cycle = await client.callTool({
        name: 'ws-topic-update',
        arguments: { slug: 'root', parents: ['child'] },
      });
      expect(isErrorResult(cycle)).toBe(true);
      expect(textOf(cycle)).toContain('would create a cycle');
      expect(store.getDocument({ slug: 'root', kind: 'Topic' })?.spec.parents).toEqual([]);

      const missing = await client.callTool({
        name: 'ws-topic-update',
        arguments: { slug: 'child', parents: ['missing'] },
      });
      expect(isErrorResult(missing)).toBe(true);
      expect(textOf(missing)).toContain('Unknown parent topic slug');
    } finally {
      await close();
    }
  });

  it('atomically closes more than 500 descendants and rolls the batch back on conflict', async () => {
    const base = openStore(':memory:');
    base.createDocument({
      kind: 'Workstream', slug: 'bulk-work',
      spec: validateSpec('Workstream', { title: 'Bulk', status: 'progress' }),
    });

    for (let index = 0; index < 602; index += 1) {
      const slug = index === 0 ? 'bulk-root' : `bulk-node-${String(index).padStart(4, '0')}`;
      const parent = index === 0 ? [] : [index === 1 ? 'bulk-root' : `bulk-node-${String(index - 1).padStart(4, '0')}`];
      base.createDocument({
        kind: 'Topic', slug,
        spec: validateSpec('Topic', { title: slug, parents: parent, workstreams: ['bulk-work'] }),
      });
    }
    const originalUpdateDocuments = base.updateDocuments.bind(base);
    let forceConflict = true;
    const store = new Proxy(base, {
      get(target, property, receiver) {
        if (property !== 'updateDocuments') return Reflect.get(target, property, receiver);
        return (inputs: Parameters<Store['updateDocuments']>[0]) => {
          if (forceConflict) {
            forceConflict = false;
            const last = base.getDocument({ slug: 'bulk-node-0601', kind: 'Topic' })!;
            base.updateDocument({
              id: last.metadata.id,
              expectedResourceVersion: last.metadata.resourceVersion,
              spec: { ...last.spec, body: 'concurrent edit' },
            });
          }
          return originalUpdateDocuments(inputs);
        };
      },
    }) as Store;
    const { client, close } = await connect(store);
    try {
      const conflicted = await client.callTool({
        name: 'ws-topic-close-tree', arguments: { slug: 'bulk-root' },
      });
      expect(isErrorResult(conflicted)).toBe(true);
      expect(textOf(conflicted)).toContain('no topics were closed');
      expect(base.listDocuments({ kind: 'Topic' }).every((document) => document.spec.status === 'open')).toBe(true);

      const result = jsonOf<any>(await client.callTool({
        name: 'ws-topic-close-tree', arguments: { slug: 'bulk-root' },
      }));
      expect(result).toMatchObject({ matchedCount: 602, closedCount: 602 });
      expect(base.listDocuments({ kind: 'Topic' }).every((document) => document.spec.status === 'closed')).toBe(true);
    } finally {
      await close();
    }
  });

  it('dry-runs a 5000-node linear tree iteratively and rejects 5001 before writing', async () => {
    const store = openStore(':memory:');
    store.createDocument({
      kind: 'Workstream', slug: 'limit-work',
      spec: validateSpec('Workstream', { title: 'Limit', status: 'progress' }),
    });
    for (let index = 0; index < 5_001; index += 1) {
      const slug = `limit-node-${String(index).padStart(4, '0')}`;
      store.createDocument({
        kind: 'Topic',
        slug,
        spec: validateSpec('Topic', {
          title: slug,
          parents: index === 0 ? [] : [`limit-node-${String(index - 1).padStart(4, '0')}`],
          workstreams: ['limit-work'],
        }),
      });
    }
    const { client, close } = await connect(store);
    try {
      const exactLimit = jsonOf<any>(await client.callTool({
        name: 'ws-topic-close-tree',
        arguments: { slug: 'limit-node-0001', dryRun: true },
      }));
      expect(exactLimit).toMatchObject({
        dryRun: true,
        matchedCount: 5_000,
        closedCount: 5_000,
      });
      expect(exactLimit.matchedSlugs).toHaveLength(5_000);

      const overLimit = await client.callTool({
        name: 'ws-topic-close-tree',
        arguments: { slug: 'limit-node-0000', dryRun: true },
      });
      expect(isErrorResult(overLimit)).toBe(true);
      expect(textOf(overLimit)).toContain('contains 5001 topics');
      expect(textOf(overLimit)).toContain('limit of 5000');
      expect(store.listDocuments({ kind: 'Topic' }).every((document) => document.spec.status === 'open')).toBe(true);
    } finally {
      await close();
    }
  });

  it('atomically copies or moves a topic and its descendant closure between workstreams', async () => {
    const { client, close } = await connect(openStore(':memory:'));
    try {
      const createWorkstream = (slug: string) => client.callTool({
        name: 'ws-workstream-create', arguments: { slug, title: slug },
      });
      await Promise.all(['source', 'target', 'moved', 'private'].map(createWorkstream));
      const create = (slug: string, parents: string[] = [], workstreams = ['source'], focusedWorkstreams: string[] = []) =>
        client.callTool({ name: 'ws-topic-create', arguments: { slug, title: slug, parents, workstreams, focusedWorkstreams } });
      await create('root', ['cycle'], ['source'], ['source']);
      await create('child', ['root']);
      await create('grandchild', ['child']);
      await create('multi-parent', ['root', 'child']);
      await create('cycle', ['grandchild']);
      await create('unrelated');
      await create('out-of-scope-child', ['root'], ['private']);

      const copied = jsonOf<ITopic[]>(await client.callTool({
        name: 'ws-topic-transfer',
        arguments: { slug: 'root', sourceWorkstream: 'source', targetWorkstream: 'target', move: false },
      }));
      expect(copied.map((topic) => topic.slug).sort()).toEqual(
        ['root', 'child', 'multi-parent', 'grandchild', 'cycle'].sort(),
      );
      expect(copied.every((topic) => topic.workstreams.includes('source') && topic.workstreams.includes('target'))).toBe(true);
      expect(copied.find((topic) => topic.slug === 'root')?.focusedWorkstreams).toEqual(['source']);

      const outOfScopeChild = jsonOf<TopicList>(await client.callTool({
        name: 'ws-topic-read', arguments: { slug: 'out-of-scope-child' },
      })).topics[0];
      expect(outOfScopeChild?.workstreams).toEqual(['private']);

      const moved = jsonOf<ITopic[]>(await client.callTool({
        name: 'ws-topic-transfer',
        arguments: { slug: 'root', sourceWorkstream: 'source', targetWorkstream: 'moved', move: true },
      }));
      expect(moved).toHaveLength(5);
      expect(moved.every((topic) => !topic.workstreams.includes('source') && topic.workstreams.includes('moved'))).toBe(true);
      expect(moved.every((topic) => !topic.focusedWorkstreams.includes('source'))).toBe(true);

      const unrelated = jsonOf<TopicList>(await client.callTool({
        name: 'ws-topic-read', arguments: { slug: 'unrelated' },
      })).topics[0];
      expect(unrelated?.workstreams).toEqual(['source']);
    } finally {
      await close();
    }
  });

  it('rejects a transfer when either workstream does not exist', async () => {
    const { client, close } = await connect(openStore(':memory:'));
    try {
      await client.callTool({
        name: 'ws-workstream-create', arguments: { slug: 'source', title: 'Source' },
      });
      await client.callTool({
        name: 'ws-topic-create', arguments: { slug: 'root', title: 'Root', workstreams: ['source'] },
      });

      const rejected = await client.callTool({
        name: 'ws-topic-transfer',
        arguments: { slug: 'root', sourceWorkstream: 'source', targetWorkstream: 'missing' },
      });

      expect(isErrorResult(rejected)).toBe(true);
      expect(textOf(rejected)).toContain('Unknown workstream slug: "missing"');
      const root = jsonOf<TopicList>(await client.callTool({
        name: 'ws-topic-read', arguments: { slug: 'root' },
      })).topics[0];
      expect(root?.workstreams).toEqual(['source']);
    } finally {
      await close();
    }
  });

  it('ws-topic-create returns the mapped shape with defaults applied', async () => {
    const { client, close } = await connect(openStore(':memory:'));
    try {
      const created = jsonOf<ITopic>(
        await client.callTool({
          name: 'ws-topic-create',
          arguments: { slug: 'alpha', title: 'Alpha', workstreams: ['ws-seed'] },
        }),
      );
      expect(created.slug).toBe('alpha');
      expect(created.title).toBe('Alpha');
      expect(created.body).toBe('');
      expect(created.status).toBe('open');
      expect(created.topicType).toBe('topic');
      expect(created.parents).toEqual([]);
      expect(created.workstreams).toEqual(['ws-seed']);
      expect(created.focusedWorkstreams).toEqual([]);
      expect(created.id).toMatch(/^[0-9a-f-]{36}$/);
      expect(created.resourceVersion).toBe(1);
    } finally {
      await close();
    }
  });

  it('validates explicit slugs and creates a visible workstream member', async () => {
    const { client, close } = await connect(openStore(':memory:'));
    try {
      for (const arguments_ of [
        { slug: '   ', title: 'Blank', workstreams: ['ws-one'] },
        { slug: 'Not_valid', title: 'Invalid', workstreams: ['ws-one'] },
      ]) {
        const rejected = await client.callTool({ name: 'ws-topic-create', arguments: arguments_ });
        expect(isErrorResult(rejected)).toBe(true);
        expect(textOf(rejected)).toMatch(/unique slug.*lowercase words separated with dashes/i);
      }

      const created = jsonOf<ITopic>(
        await client.callTool({
          name: 'ws-topic-create',
          arguments: {
            slug: 'require-topic-slugs',
            title: 'Require topic slugs',
            workstreams: ['working-memory-14-1'],
          },
        }),
      );
      expect(created.slug).toBe('require-topic-slugs');

      const duplicate = await client.callTool({
        name: 'ws-topic-create',
        arguments: {
          slug: 'require-topic-slugs',
          title: 'Duplicate topic slug',
          workstreams: ['working-memory-14-1'],
        },
      });
      expect(isErrorResult(duplicate)).toBe(true);
      expect(textOf(duplicate)).toMatch(/unique slug.*already in use/i);

      const members = jsonOf<TopicList>(
        await client.callTool({
          name: 'ws-topic-read',
          arguments: { workstream: 'working-memory-14-1' },
        }),
      );
      expect(members.topics.map((topic) => topic.slug)).toEqual(['require-topic-slugs']);
    } finally {
      await close();
    }
  });

  it('ws-topic-read: one-by-slug (0-or-1), list, query filter, and workstream membership filter', async () => {
    const { client, close } = await connect(openStore(':memory:'));
    try {
      await client.callTool({
        name: 'ws-topic-create',
        arguments: { slug: 'alpha', title: 'Alpha topic', workstreams: ['ws-one'] },
      });
      await client.callTool({
        name: 'ws-topic-create',
        arguments: { slug: 'beta', title: 'Beta topic', workstreams: ['ws-two'] },
      });

      // one-by-slug → 0-or-1 element list.
      const oneHit = jsonOf<TopicList>(
        await client.callTool({ name: 'ws-topic-read', arguments: { slug: 'alpha' } }),
      );
      expect(oneHit.count).toBe(1);
      expect(oneHit.topics[0]?.title).toBe('Alpha topic');

      const oneMiss = jsonOf<TopicList>(
        await client.callTool({ name: 'ws-topic-read', arguments: { slug: 'ghost' } }),
      );
      expect(oneMiss.count).toBe(0);

      // list mode (no slug/id) → both.
      const list = jsonOf<TopicList>(
        await client.callTool({ name: 'ws-topic-read', arguments: {} }),
      );
      expect(list.count).toBe(2);

      // query filter (case-insensitive substring over the doc text).
      const queried = jsonOf<TopicList>(
        await client.callTool({ name: 'ws-topic-read', arguments: { query: 'beta' } }),
      );
      expect(queried.count).toBe(1);
      expect(queried.topics[0]?.slug).toBe('beta');

      // workstream membership filter → only the topic whose workstreams include it.
      const members = jsonOf<TopicList>(
        await client.callTool({ name: 'ws-topic-read', arguments: { workstream: 'ws-one' } }),
      );
      expect(members.count).toBe(1);
      expect(members.topics[0]?.slug).toBe('alpha');

      const noMembers = jsonOf<TopicList>(
        await client.callTool({ name: 'ws-topic-read', arguments: { workstream: 'ws-none' } }),
      );
      expect(noMembers.count).toBe(0);
    } finally {
      await close();
    }
  });

  it('ws-topic-read returns resourceVersion (plus id/slug/title) per item so callers can build friendly link-outs', async () => {
    const { client, close } = await connect(openStore(':memory:'));
    try {
      await client.callTool({
        name: 'ws-topic-create',
        arguments: { slug: 'versioned', title: 'Versioned topic', workstreams: ['ws-v'] },
      });

      // Read one — the projected item must carry resourceVersion + identity.
      const one = jsonOf<TopicList>(
        await client.callTool({ name: 'ws-topic-read', arguments: { slug: 'versioned' } }),
      );
      expect(one.count).toBe(1);
      const item = one.topics[0];
      expect(item).toBeDefined();
      expect(typeof item!.resourceVersion).toBe('number');
      expect(item!.resourceVersion).toBeGreaterThanOrEqual(1);
      expect(item!.slug).toBe('versioned');
      expect(item!.title).toBe('Versioned topic');
      expect(typeof item!.id).toBe('string');
      expect(item!.id.length).toBeGreaterThan(0);

      // List mode carries it too.
      const list = jsonOf<TopicList>(
        await client.callTool({ name: 'ws-topic-read', arguments: {} }),
      );
      expect(typeof list.topics[0]?.resourceVersion).toBe('number');
    } finally {
      await close();
    }
  });

  it('ws-topic-create + ws-topic-update persist focusedWorkstreams; ws-topic-read returns it', async () => {
    const { client, close } = await connect(openStore(':memory:'));
    try {
      // Create with an explicit focus subset.
      const created = jsonOf<ITopic>(
        await client.callTool({
          name: 'ws-topic-create',
          arguments: {
            slug: 'focus-topic',
            title: 'Focus topic',
            workstreams: ['ws-one', 'ws-two'],
            focusedWorkstreams: ['ws-one'],
          },
        }),
      );
      expect(created.workstreams).toEqual(['ws-one', 'ws-two']);
      expect(created.focusedWorkstreams).toEqual(['ws-one']);

      // Read-back returns the persisted focus subset.
      const afterCreate = jsonOf<TopicList>(
        await client.callTool({ name: 'ws-topic-read', arguments: { slug: 'focus-topic' } }),
      );
      expect(afterCreate.topics[0]?.focusedWorkstreams).toEqual(['ws-one']);

      // Update REPLACES the focus subset (mirrors workstreams replacement).
      const updated = jsonOf<ITopic>(
        await client.callTool({
          name: 'ws-topic-update',
          arguments: { slug: 'focus-topic', focusedWorkstreams: ['ws-two'] },
        }),
      );
      expect(updated.focusedWorkstreams).toEqual(['ws-two']);
      // Membership is untouched by a focus-only patch.
      expect(updated.workstreams).toEqual(['ws-one', 'ws-two']);

      const afterUpdate = jsonOf<TopicList>(
        await client.callTool({ name: 'ws-topic-read', arguments: { slug: 'focus-topic' } }),
      );
      expect(afterUpdate.topics[0]?.focusedWorkstreams).toEqual(['ws-two']);
    } finally {
      await close();
    }
  });

  it('ws-topic-update merges + re-validates, reflected on a subsequent read (happy path)', async () => {
    const { client, close } = await connect(openStore(':memory:'));
    try {
      await client.callTool({
        name: 'ws-topic-create',
        arguments: { slug: 'evolve', title: 'Old', body: 'old body', workstreams: ['ws-seed'] },
      });
      const updated = jsonOf<ITopic>(
        await client.callTool({
          name: 'ws-topic-update',
          arguments: { slug: 'evolve', title: 'New', status: 'closed' },
        }),
      );
      expect(updated.title).toBe('New');
      expect(updated.status).toBe('closed');
      // Unpatched fields survive the merge.
      expect(updated.body).toBe('old body');
      // CAS bumped the version.
      expect(updated.resourceVersion).toBe(2);

      const read = jsonOf<TopicList>(
        await client.callTool({ name: 'ws-topic-read', arguments: { slug: 'evolve' } }),
      );
      expect(read.topics[0]?.title).toBe('New');
      expect(read.topics[0]?.status).toBe('closed');
    } finally {
      await close();
    }
  });

  it('ws-topic-update surfaces a CAS conflict when the stored version has advanced', async () => {
    // Decorate the store so the tool's READ observes a STALE resourceVersion
    // while the real row has advanced — the only way to drive ws-topic-update's
    // read-then-write into a genuine compare-and-swap conflict (the handler
    // re-reads internally, so a conflict is otherwise unreachable through the
    // tool alone).
    const real = openStore(':memory:');
    let staleVersion: number | null = null;
    const store: Store = {
      ...real,
      getDocument(input) {
        const doc = real.getDocument(input);
        if (doc && staleVersion !== null) {
          return { ...doc, metadata: { ...doc.metadata, resourceVersion: staleVersion } };
        }
        return doc;
      },
    };
    const { client, close } = await connect(store);
    try {
      await client.callTool({
        name: 'ws-topic-create',
        arguments: { slug: 'race', title: 'Race', workstreams: ['ws-seed'] },
      });
      // Advance the real row to version 2.
      await client.callTool({
        name: 'ws-topic-update',
        arguments: { slug: 'race', title: 'Race v2' },
      });
      // Pin the tool's read to the now-stale version 1 → the write's CAS guard
      // (expected 1) mismatches the real current version (2).
      staleVersion = 1;
      const conflict = await client.callTool({
        name: 'ws-topic-update',
        arguments: { slug: 'race', title: 'Race v3' },
      });
      expect(isErrorResult(conflict)).toBe(true);
      expect(textOf(conflict)).toMatch(/conflict/i);
    } finally {
      await close();
    }
  });

  it('ws-topic-delete drops it from ws-topic-read; restore:true brings it back with spec intact', async () => {
    const { client, close } = await connect(openStore(':memory:'));
    try {
      await client.callTool({
        name: 'ws-topic-create',
        arguments: { slug: 'gone', title: 'Gone', body: 'keep me', workstreams: ['ws-x'] },
      });

      const del = jsonOf<{ ok: boolean; slug: string }>(
        await client.callTool({ name: 'ws-topic-delete', arguments: { slug: 'gone' } }),
      );
      expect(del).toEqual({ ok: true, slug: 'gone' });
      expect(
        jsonOf<TopicList>(await client.callTool({ name: 'ws-topic-read', arguments: { slug: 'gone' } }))
          .count,
      ).toBe(0);

      const restored = jsonOf<{ ok: boolean; slug: string }>(
        await client.callTool({ name: 'ws-topic-delete', arguments: { slug: 'gone', restore: true } }),
      );
      expect(restored).toEqual({ ok: true, slug: 'gone' });
      const afterRestore = jsonOf<TopicList>(
        await client.callTool({ name: 'ws-topic-read', arguments: { slug: 'gone' } }),
      );
      expect(afterRestore.count).toBe(1);
      // Spec survived the round-trip.
      expect(afterRestore.topics[0]?.body).toBe('keep me');
      expect(afterRestore.topics[0]?.workstreams).toEqual(['ws-x']);
    } finally {
      await close();
    }
  });

  it('ws-topic-update sets spec.workstreams (membership is edited via update)', async () => {
    const { client, close } = await connect(openStore(':memory:'));
    try {
      await client.callTool({
        name: 'ws-topic-create',
        arguments: { slug: 'member', title: 'Member', workstreams: ['ws-seed'] },
      });
      // Not yet a member.
      expect(
        jsonOf<TopicList>(
          await client.callTool({ name: 'ws-topic-read', arguments: { workstream: 'ws-a' } }),
        ).count,
      ).toBe(0);

      const updated = jsonOf<ITopic>(
        await client.callTool({
          name: 'ws-topic-update',
          arguments: { slug: 'member', workstreams: ['ws-a'] },
        }),
      );
      expect(updated.workstreams).toEqual(['ws-a']);

      // Membership filter now reflects the update.
      const members = jsonOf<TopicList>(
        await client.callTool({ name: 'ws-topic-read', arguments: { workstream: 'ws-a' } }),
      );
      expect(members.count).toBe(1);
      expect(members.topics[0]?.slug).toBe('member');
    } finally {
      await close();
    }
  });

  it('rejects an invalid status via kind validation (create + update), persisting nothing', async () => {
    const { client, close } = await connect(openStore(':memory:'));
    try {
      const badCreate = await client.callTool({
        name: 'ws-topic-create',
        arguments: { slug: 'bad', title: 'Bad', status: 'nonsense', workstreams: ['ws-seed'] },
      });
      expect(isErrorResult(badCreate)).toBe(true);
      expect(textOf(badCreate)).toMatch(/status/i);
      // The rejected create persisted nothing.
      expect(
        jsonOf<TopicList>(await client.callTool({ name: 'ws-topic-read', arguments: {} })).count,
      ).toBe(0);

      // A valid create, then an invalid-status update, is also rejected …
      await client.callTool({
        name: 'ws-topic-create',
        arguments: { slug: 'ok', title: 'OK', workstreams: ['ws-seed'] },
      });
      const badUpdate = await client.callTool({
        name: 'ws-topic-update',
        arguments: { slug: 'ok', status: 'nonsense' },
      });
      expect(isErrorResult(badUpdate)).toBe(true);
      expect(textOf(badUpdate)).toMatch(/status/i);
      // … and leaves the topic unchanged (still open).
      const still = jsonOf<TopicList>(
        await client.callTool({ name: 'ws-topic-read', arguments: { slug: 'ok' } }),
      );
      expect(still.topics[0]?.status).toBe('open');
    } finally {
      await close();
    }
  });

  it('errors clearly on unknown-slug update, delete, and restore', async () => {
    const { client, close } = await connect(openStore(':memory:'));
    try {
      for (const call of [
        { name: 'ws-topic-update', arguments: { slug: 'ghost', title: 'X' } },
        { name: 'ws-topic-delete', arguments: { slug: 'ghost' } },
        { name: 'ws-topic-delete', arguments: { slug: 'ghost', restore: true } },
      ]) {
        const res = await client.callTool(call);
        expect(isErrorResult(res)).toBe(true);
        expect(textOf(res)).toMatch(/ghost/);
      }
    } finally {
      await close();
    }
  });

  it('ws-topic-create with neither workstreams nor parents creates an unassigned topic', async () => {
    const { client, close } = await connect(openStore(':memory:'));
    try {
      const orphan = jsonOf<ITopic>(await client.callTool({
        name: 'ws-topic-create',
        arguments: { slug: 'orphan', title: 'Orphan' },
      }));
      expect(orphan.workstreams).toEqual([]);
      expect(
        jsonOf<TopicList>(await client.callTool({ name: 'ws-topic-read', arguments: {} })).count,
      ).toBe(1);
    } finally {
      await close();
    }
  });

  it('ws-topic-create generates a unique slug from the title when omitted', async () => {
    const { client, close } = await connect(openStore(':memory:'));
    try {
      const first = jsonOf<ITopic>(await client.callTool({
        name: 'ws-topic-create',
        arguments: { title: 'Test 1', workstreams: ['ws-a'] },
      }));
      const second = jsonOf<ITopic>(await client.callTool({
        name: 'ws-topic-create',
        arguments: { title: 'Test 1', workstreams: ['ws-a'] },
      }));

      expect(first.slug).toBe('test-1');
      expect(second.slug).toBe('test-1-2');
    } finally {
      await close();
    }
  });

  it('ws-topic-create inherits the union of its parents workstreams when none supplied', async () => {
    const { client, close } = await connect(openStore(':memory:'));
    try {
      await client.callTool({
        name: 'ws-topic-create',
        arguments: { slug: 'mom', title: 'Mom', workstreams: ['ws-a', 'ws-b'] },
      });
      await client.callTool({
        name: 'ws-topic-create',
        arguments: { slug: 'dad', title: 'Dad', workstreams: ['ws-b', 'ws-c'] },
      });

      const child = jsonOf<ITopic>(
        await client.callTool({
          name: 'ws-topic-create',
          arguments: { slug: 'kid', title: 'Kid', parents: ['mom', 'dad'] },
        }),
      );
      // Union of both parents' memberships (dedup preserved), no explicit input.
      expect([...child.workstreams].sort()).toEqual(['ws-a', 'ws-b', 'ws-c']);
      expect(child.parents).toEqual(['mom', 'dad']);
    } finally {
      await close();
    }
  });

  it('ws-topic-update can clear workstreams and clears stale focus membership', async () => {
    const { client, close } = await connect(openStore(':memory:'));
    try {
      await client.callTool({
        name: 'ws-topic-create',
        arguments: {
          slug: 'keep',
          title: 'Keep',
          workstreams: ['ws-a'],
          focusedWorkstreams: ['ws-a'],
        },
      });
      const updated = jsonOf<ITopic>(await client.callTool({
        name: 'ws-topic-update',
        arguments: { slug: 'keep', workstreams: [] },
      }));
      expect(updated.workstreams).toEqual([]);
      expect(updated.focusedWorkstreams).toEqual([]);
      expect(updated.resourceVersion).toBe(2);
    } finally {
      await close();
    }
  });

  it('ws-topic-update removes focus membership excluded by a workstream replacement', async () => {
    const { client, close } = await connect(openStore(':memory:'));
    try {
      await client.callTool({
        name: 'ws-topic-create',
        arguments: {
          slug: 'focused',
          title: 'Focused',
          workstreams: ['ws-a', 'ws-b'],
          focusedWorkstreams: ['ws-a', 'ws-b'],
        },
      });
      const updated = jsonOf<ITopic>(await client.callTool({
        name: 'ws-topic-update',
        arguments: { slug: 'focused', workstreams: ['ws-b'] },
      }));
      expect(updated.workstreams).toEqual(['ws-b']);
      expect(updated.focusedWorkstreams).toEqual(['ws-b']);
    } finally {
      await close();
    }
  });
});
