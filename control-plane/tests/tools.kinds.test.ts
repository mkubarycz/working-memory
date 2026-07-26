import { describe, it, expect, beforeAll } from 'vitest';
import { startServer } from '../src/server';
import { openStore } from '../src/store';
import { loadKinds } from '../src/kinds/loader';
import { clearKinds } from '../src/kinds/registry';
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

interface Envelope {
  kind: string;
  metadata: { id: string; slug: string | null; resourceVersion: number };
  spec: Record<string, unknown>;
  status: Record<string, unknown>;
}

(sqliteAvailable ? describe : describe.skip)('control-plane typed-kind tools', () => {
  beforeAll(async () => {
    clearKinds();
    await loadKinds();
  });

  it('wm-list-kinds includes the registered Topic kind', async () => {
    const store = openStore(':memory:');
    const server = await startServer({ port: 0, store });
    const client = new Client({ name: 'wm-cp-kinds', version: '0.0.0' });
    const transport = new StreamableHTTPClientTransport(new URL(`${server.url}/mcp`));
    try {
      await client.connect(transport);
      const names = (await client.listTools()).tools.map((t) => t.name);
      expect(names).toContain('wm-list-kinds');

      const result = jsonOf<{ count: number; kinds: { name: string; specFields: string[] }[] }>(
        await client.callTool({ name: 'wm-list-kinds', arguments: {} }),
      );
      const topic = result.kinds.find((k) => k.name === 'Topic');
      expect(topic).toBeDefined();
      // Exposes the allowed spec field names for introspection.
      expect(topic?.specFields).toEqual(
        expect.arrayContaining(['title', 'body', 'status', 'topicType', 'parents']),
      );
    } finally {
      await client.close();
      await server.close();
      store.close();
    }
  });

  it('creates a Topic with a valid spec and defaults its status', async () => {
    const store = openStore(':memory:');
    const server = await startServer({ port: 0, store });
    const client = new Client({ name: 'wm-cp-kinds-2', version: '0.0.0' });
    const transport = new StreamableHTTPClientTransport(new URL(`${server.url}/mcp`));
    try {
      await client.connect(transport);
      const created = jsonOf<Envelope>(
        await client.callTool({
          name: 'wm-document-create',
          arguments: { kind: 'Topic', slug: 'demo', spec: { title: 'Demo Topic' } },
        }),
      );
      expect(created.kind).toBe('Topic');
      // Defaults applied by the Topic spec schema.
      expect(created.spec).toEqual({
        title: 'Demo Topic',
        body: '',
        topicType: 'topic',
        status: 'open',
        parents: [],
      });
      // Envelope status inherits Base's empty default.
      expect(created.status).toEqual({});

      // It persisted.
      const list = jsonOf<{ count: number; documents: Envelope[] }>(
        await client.callTool({ name: 'wm-document-read', arguments: { kind: 'Topic' } }),
      );
      expect(list.count).toBe(1);
      expect(list.documents[0]?.metadata.slug).toBe('demo');
    } finally {
      await client.close();
      await server.close();
      store.close();
    }
  });

  it('rejects an invalid Topic spec (missing title) and does NOT persist', async () => {
    const store = openStore(':memory:');
    const server = await startServer({ port: 0, store });
    const client = new Client({ name: 'wm-cp-kinds-3', version: '0.0.0' });
    const transport = new StreamableHTTPClientTransport(new URL(`${server.url}/mcp`));
    try {
      await client.connect(transport);
      const res = await client.callTool({
        name: 'wm-document-create',
        arguments: { kind: 'Topic', slug: 'bad', spec: {} },
      });
      expect((res as { isError?: boolean }).isError).toBe(true);
      expect(textOf(res)).toMatch(/title/i);

      // Nothing was written.
      expect(store.listDocuments({ kind: 'Topic' })).toEqual([]);
    } finally {
      await client.close();
      await server.close();
      store.close();
    }
  });

  it('rejects a Topic with a 200-char title and does NOT persist', async () => {
    const store = openStore(':memory:');
    const server = await startServer({ port: 0, store });
    const client = new Client({ name: 'wm-cp-kinds-4', version: '0.0.0' });
    const transport = new StreamableHTTPClientTransport(new URL(`${server.url}/mcp`));
    try {
      await client.connect(transport);
      const res = await client.callTool({
        name: 'wm-document-create',
        arguments: { kind: 'Topic', slug: 'toolong', spec: { title: 'x'.repeat(200) } },
      });
      expect((res as { isError?: boolean }).isError).toBe(true);
      expect(store.listDocuments()).toEqual([]);
    } finally {
      await client.close();
      await server.close();
      store.close();
    }
  });

  it('rejects an unregistered kind (no freeform escape hatch) and does NOT persist', async () => {
    const store = openStore(':memory:');
    const server = await startServer({ port: 0, store });
    const client = new Client({ name: 'wm-cp-kinds-5', version: '0.0.0' });
    const transport = new StreamableHTTPClientTransport(new URL(`${server.url}/mcp`));
    try {
      await client.connect(transport);
      const res = await client.callTool({
        name: 'wm-document-create',
        // 'note' is not registered → hard error (unknown kind), nothing stored.
        arguments: { kind: 'note', slug: 'n1', spec: { anything: 'goes' } },
      });
      expect((res as { isError?: boolean }).isError).toBe(true);
      expect(textOf(res)).toMatch(/unknown kind/i);
      expect(store.listDocuments()).toEqual([]);
    } finally {
      await client.close();
      await server.close();
      store.close();
    }
  });

  it('rejects unknown spec fields (Topic spec is strict) and does NOT persist', async () => {
    const store = openStore(':memory:');
    const server = await startServer({ port: 0, store });
    const client = new Client({ name: 'wm-cp-kinds-6', version: '0.0.0' });
    const transport = new StreamableHTTPClientTransport(new URL(`${server.url}/mcp`));
    try {
      await client.connect(transport);
      const res = await client.callTool({
        name: 'wm-document-create',
        arguments: {
          kind: 'Topic',
          slug: 'extra',
          spec: { title: 'Has Extras', steps: ['a'], owner: 'me', priority: 1 },
        },
      });
      expect((res as { isError?: boolean }).isError).toBe(true);
      expect(textOf(res)).toMatch(/invalid spec/i);
      expect(store.listDocuments()).toEqual([]);
    } finally {
      await client.close();
      await server.close();
      store.close();
    }
  });
});
