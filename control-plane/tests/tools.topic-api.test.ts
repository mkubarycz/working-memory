import { describe, it, expect, beforeAll } from 'vitest';
import { startServer } from '../src/server';
import { openStore, type Store } from '../src/store';
import { clearKinds } from '../src/kinds/registry';
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
        ]),
      );
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
          arguments: { slug: 'alpha', title: 'Alpha' },
        }),
      );
      expect(created.slug).toBe('alpha');
      expect(created.title).toBe('Alpha');
      expect(created.body).toBe('');
      expect(created.status).toBe('open');
      expect(created.topicType).toBe('topic');
      expect(created.parents).toEqual([]);
      expect(created.workstreams).toEqual([]);
      expect(created.focusedWorkstreams).toEqual([]);
      expect(created.id).toMatch(/^[0-9a-f-]{36}$/);
      expect(created.resourceVersion).toBe(1);
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
        arguments: { slug: 'beta', title: 'Beta topic' },
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
        arguments: { slug: 'evolve', title: 'Old', body: 'old body' },
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
        arguments: { slug: 'race', title: 'Race' },
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
        arguments: { slug: 'member', title: 'Member' },
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
        arguments: { slug: 'bad', title: 'Bad', status: 'nonsense' },
      });
      expect(isErrorResult(badCreate)).toBe(true);
      expect(textOf(badCreate)).toMatch(/status/i);
      // The rejected create persisted nothing.
      expect(
        jsonOf<TopicList>(await client.callTool({ name: 'ws-topic-read', arguments: {} })).count,
      ).toBe(0);

      // A valid create, then an invalid-status update, is also rejected …
      await client.callTool({ name: 'ws-topic-create', arguments: { slug: 'ok', title: 'OK' } });
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
});
