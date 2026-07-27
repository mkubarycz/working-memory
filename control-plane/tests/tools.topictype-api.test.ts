import { describe, it, expect, beforeAll } from 'vitest';
import { startServer } from '../src/server';
import { openStore, type Store, type DocumentEnvelope } from '../src/store';
import { clearKinds } from '../src/kinds/registry';
import { loadKinds } from '../src/kinds/loader';
import { TopicType } from '../src/kinds/topictype/topictype';
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

/** The legacy topic-type shape the ws-topictype-* API maps documents to. */
interface ITopicType {
  id: string;
  slug: string | null;
  label: string;
  icon: string;
  description: string;
  body_template: string;
  created_at: number;
  updated_at: number;
  resourceVersion: number;
}

interface TopicTypeList {
  count: number;
  topicTypes: ITopicType[];
}

let clientSeq = 0;

/** Stand up an ephemeral server + connected MCP client over the given store. */
async function connect(store: Store): Promise<{
  client: Client;
  close: () => Promise<void>;
}> {
  const server = await startServer({ port: 0, store });
  const client = new Client({ name: `wm-cp-topictype-api-${++clientSeq}`, version: '0.0.0' });
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

(sqliteAvailable ? describe : describe.skip)('control-plane TopicType ws-topictype-* API', () => {
  beforeAll(async () => {
    // Populate the kind registry (TopicType's registerApi is what wires ws-topictype-*).
    clearKinds();
    await loadKinds();
  });

  it('exposes ws-topictype-* tools alongside the generic wm-document-* tools', async () => {
    const { client, close } = await connect(openStore(':memory:'));
    try {
      const names = (await client.listTools()).tools.map((t) => t.name);
      // Generic CRUD is still present …
      expect(names).toContain('wm-document-create');
      expect(names).toContain('wm-document-read');
      // … PLUS the TopicType kind's domain API (registered via its registerApi).
      expect(names).toEqual(
        expect.arrayContaining([
          'ws-topictype-create',
          'ws-topictype-read',
          'ws-topictype-update',
          'ws-topictype-delete',
        ]),
      );
    } finally {
      await close();
    }
  });

  it('round-trips create → read(one+list, query) → update(happy) → delete/restore', async () => {
    const { client, close } = await connect(openStore(':memory:'));
    try {
      // create — body_template defaults to ''; the return is the mapped shape.
      const created = jsonOf<ITopicType>(
        await client.callTool({
          name: 'ws-topictype-create',
          arguments: { slug: 'feature', label: 'Feature', icon: 'rocket', description: 'Ships things.' },
        }),
      );
      expect(created.slug).toBe('feature');
      expect(created.label).toBe('Feature');
      expect(created.icon).toBe('rocket');
      expect(created.body_template).toBe('');
      expect(created.id).toMatch(/^[0-9a-f-]{36}$/);
      expect(created.resourceVersion).toBe(1);

      // read by slug → mapped 0-or-1 list.
      const read = jsonOf<TopicTypeList>(
        await client.callTool({ name: 'ws-topictype-read', arguments: { slug: 'feature' } }),
      );
      expect(read.count).toBe(1);
      expect(read.topicTypes[0]?.label).toBe('Feature');

      // read by slug miss → 0.
      const miss = jsonOf<TopicTypeList>(
        await client.callTool({ name: 'ws-topictype-read', arguments: { slug: 'ghost' } }),
      );
      expect(miss.count).toBe(0);

      // list mode (no slug/id) → contains it.
      const list = jsonOf<TopicTypeList>(
        await client.callTool({ name: 'ws-topictype-read', arguments: {} }),
      );
      expect(list.count).toBe(1);
      expect(list.topicTypes[0]?.slug).toBe('feature');

      // query filter (case-insensitive substring): matches, then excludes.
      const queried = jsonOf<TopicTypeList>(
        await client.callTool({ name: 'ws-topictype-read', arguments: { query: 'ships' } }),
      );
      expect(queried.count).toBe(1);
      const noMatch = jsonOf<TopicTypeList>(
        await client.callTool({ name: 'ws-topictype-read', arguments: { query: 'zzz-nomatch' } }),
      );
      expect(noMatch.count).toBe(0);

      // update — change label + body_template; unpatched fields survive the merge.
      const updated = jsonOf<ITopicType>(
        await client.callTool({
          name: 'ws-topictype-update',
          arguments: { slug: 'feature', label: 'Feature v2', body_template: '## Problem\n' },
        }),
      );
      expect(updated.label).toBe('Feature v2');
      expect(updated.body_template).toBe('## Problem\n');
      expect(updated.icon).toBe('rocket');
      expect(updated.description).toBe('Ships things.');
      expect(updated.resourceVersion).toBe(2);

      const afterUpdate = jsonOf<TopicTypeList>(
        await client.callTool({ name: 'ws-topictype-read', arguments: { slug: 'feature' } }),
      );
      expect(afterUpdate.topicTypes[0]?.label).toBe('Feature v2');

      // delete — drops out of ws-topictype-read.
      const del = jsonOf<{ ok: boolean; slug: string }>(
        await client.callTool({ name: 'ws-topictype-delete', arguments: { slug: 'feature' } }),
      );
      expect(del).toEqual({ ok: true, slug: 'feature' });
      expect(
        jsonOf<TopicTypeList>(
          await client.callTool({ name: 'ws-topictype-read', arguments: { slug: 'feature' } }),
        ).count,
      ).toBe(0);

      // restore: true → back in ws-topictype-read, spec intact.
      const restored = jsonOf<{ ok: boolean; slug: string }>(
        await client.callTool({
          name: 'ws-topictype-delete',
          arguments: { slug: 'feature', restore: true },
        }),
      );
      expect(restored).toEqual({ ok: true, slug: 'feature' });
      const afterRestore = jsonOf<TopicTypeList>(
        await client.callTool({ name: 'ws-topictype-read', arguments: { slug: 'feature' } }),
      );
      expect(afterRestore.count).toBe(1);
      expect(afterRestore.topicTypes[0]?.label).toBe('Feature v2');
      expect(afterRestore.topicTypes[0]?.body_template).toBe('## Problem\n');
    } finally {
      await close();
    }
  });

  it('ws-topictype-update surfaces a CAS conflict when the stored version has advanced', async () => {
    // Decorate the store so the tool's READ observes a STALE resourceVersion
    // while the real row has advanced — the only way to drive the read-then-write
    // into a genuine compare-and-swap conflict (the handler re-reads internally).
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
        name: 'ws-topictype-create',
        arguments: { slug: 'race', label: 'Race', icon: 'sync', description: 'd' },
      });
      await client.callTool({
        name: 'ws-topictype-update',
        arguments: { slug: 'race', label: 'Race v2' },
      });
      staleVersion = 1;
      const conflict = await client.callTool({
        name: 'ws-topictype-update',
        arguments: { slug: 'race', label: 'Race v3' },
      });
      expect(isErrorResult(conflict)).toBe(true);
      expect(textOf(conflict)).toMatch(/conflict/i);
    } finally {
      await close();
    }
  });

  it('rejects an invalid spec via kind validation (create + update), persisting nothing', async () => {
    const { client, close } = await connect(openStore(':memory:'));
    try {
      // Empty icon passes the tool schema (z.string()) but fails the kind schema
      // (z.string().min(1)) → kind-validation rejection, not a raw store error.
      const badCreate = await client.callTool({
        name: 'ws-topictype-create',
        arguments: { slug: 'bad', label: 'L', icon: '', description: 'x' },
      });
      expect(isErrorResult(badCreate)).toBe(true);
      expect(textOf(badCreate)).toMatch(/icon/i);
      expect(
        jsonOf<TopicTypeList>(await client.callTool({ name: 'ws-topictype-read', arguments: {} }))
          .count,
      ).toBe(0);

      // A valid create, then an invalid-label update, is also rejected …
      await client.callTool({
        name: 'ws-topictype-create',
        arguments: { slug: 'ok', label: 'OK', icon: 'check', description: 'fine' },
      });
      const badUpdate = await client.callTool({
        name: 'ws-topictype-update',
        arguments: { slug: 'ok', label: '' },
      });
      expect(isErrorResult(badUpdate)).toBe(true);
      expect(textOf(badUpdate)).toMatch(/label/i);
      // … and leaves the topic type unchanged.
      const still = jsonOf<TopicTypeList>(
        await client.callTool({ name: 'ws-topictype-read', arguments: { slug: 'ok' } }),
      );
      expect(still.topicTypes[0]?.label).toBe('OK');
    } finally {
      await close();
    }
  });

  it('errors clearly on unknown-slug update, delete, and restore', async () => {
    const { client, close } = await connect(openStore(':memory:'));
    try {
      const badUpdate = await client.callTool({
        name: 'ws-topictype-update',
        arguments: { slug: 'ghost', label: 'X' },
      });
      expect(isErrorResult(badUpdate)).toBe(true);
      expect(textOf(badUpdate)).toMatch(/ghost/);

      const badDelete = await client.callTool({
        name: 'ws-topictype-delete',
        arguments: { slug: 'ghost' },
      });
      expect(isErrorResult(badDelete)).toBe(true);
      expect(textOf(badDelete)).toMatch(/ghost/);

      const badRestore = await client.callTool({
        name: 'ws-topictype-delete',
        arguments: { slug: 'ghost', restore: true },
      });
      expect(isErrorResult(badRestore)).toBe(true);
      expect(textOf(badRestore)).toMatch(/ghost/);
    } finally {
      await close();
    }
  });

  it('POCO: JSON.stringify(new TopicType(env)) is a stable projection of the document', () => {
    const env: DocumentEnvelope = {
      kind: 'TopicType',
      metadata: {
        id: '11111111-1111-1111-1111-111111111111',
        slug: 'feature',
        labels: {},
        createdAt: 1000,
        updatedAt: 2000,
        deletedAt: null,
        resourceVersion: 3,
      },
      spec: { label: 'Feature', icon: 'rocket', description: 'Ships things.', body_template: '## P\n' },
      status: {},
    };
    // Round-trip through JSON to assert the serialized projection exactly.
    expect(JSON.parse(JSON.stringify(new TopicType(env)))).toEqual({
      id: '11111111-1111-1111-1111-111111111111',
      slug: 'feature',
      label: 'Feature',
      icon: 'rocket',
      description: 'Ships things.',
      body_template: '## P\n',
      created_at: 1000,
      updated_at: 2000,
      resourceVersion: 3,
    });
  });
});
