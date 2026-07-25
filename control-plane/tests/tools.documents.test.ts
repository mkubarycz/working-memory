import { describe, it, expect, beforeAll } from 'vitest';
import { startServer } from '../src/server';
import { openStore } from '../src/store';
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

/** Pull the JSON payload out of an MCP tool result's text content. */
function jsonOf<T>(res: unknown): T {
  const content = (res as { content: TextContent[] }).content;
  const text = content.find((c) => c.type === 'text')?.text ?? '';
  return JSON.parse(text) as T;
}

interface Envelope {
  kind: string;
  metadata: { id: string; slug: string | null; resourceVersion: number };
  spec: Record<string, unknown>;
}

/** True when an MCP tool result is flagged as an error. */
function isErrorResult(res: unknown): boolean {
  return (res as { isError?: boolean }).isError === true;
}

/** Pull the plain-text message out of an MCP tool result. */
function textOf(res: unknown): string {
  const content = (res as { content: TextContent[] }).content;
  return content.find((c) => c.type === 'text')?.text ?? '';
}

(sqliteAvailable ? describe : describe.skip)('control-plane document tools', () => {
  beforeAll(async () => {
    clearKinds();
    await loadKinds();
  });

  it('exposes the document tools and round-trips create → list → get', async () => {
    const store = openStore(':memory:');
    const server = await startServer({ port: 0, store });
    const client = new Client({ name: 'wm-cp-doc-test', version: '0.0.0' });
    const transport = new StreamableHTTPClientTransport(new URL(`${server.url}/mcp`));
    try {
      await client.connect(transport);

      const names = (await client.listTools()).tools.map((t) => t.name);
      expect(names).toContain('wm_ping');
      expect(names).toContain('wm_create_document');
      expect(names).toContain('wm_list_documents');
      expect(names).toContain('wm_get_document');

      const created = jsonOf<Envelope>(
        await client.callTool({
          name: 'wm_create_document',
          arguments: { kind: 'Topic', slug: 'demo', spec: { title: 'Demo' } },
        }),
      );
      expect(created.kind).toBe('Topic');
      expect(created.metadata.id).toMatch(/^[0-9a-f-]{36}$/);
      expect(created.metadata.resourceVersion).toBe(1);
      // The PARSED spec is persisted: defaults applied (body, status, topicType,
      // parents), not just the raw `{ title }`.
      expect(created.spec).toEqual({
        title: 'Demo',
        body: '',
        status: 'open',
        topicType: 'topic',
        parents: [],
      });

      const list = jsonOf<{ count: number; documents: Envelope[] }>(
        await client.callTool({ name: 'wm_list_documents', arguments: {} }),
      );
      expect(list.count).toBe(1);
      expect(list.documents[0]?.metadata.slug).toBe('demo');

      const got = jsonOf<Envelope>(
        await client.callTool({
          name: 'wm_get_document',
          arguments: { id: created.metadata.id },
        }),
      );
      expect(got.metadata.slug).toBe('demo');

      const miss = jsonOf<{ found: boolean }>(
        await client.callTool({ name: 'wm_get_document', arguments: { slug: 'nope' } }),
      );
      expect(miss).toEqual({ found: false });
    } finally {
      await client.close();
      await server.close();
      store.close();
    }
  });

  it('rejects unregistered kinds and unknown spec fields, persisting nothing', async () => {
    const store = openStore(':memory:');
    const server = await startServer({ port: 0, store });
    const client = new Client({ name: 'wm-cp-doc-reject', version: '0.0.0' });
    const transport = new StreamableHTTPClientTransport(new URL(`${server.url}/mcp`));
    try {
      await client.connect(transport);

      // Unregistered kind (lowercase 'topic', 'note') → hard error, no doc.
      const unknownKind = await client.callTool({
        name: 'wm_create_document',
        arguments: { kind: 'note', slug: 'nope', spec: { title: 'x' } },
      });
      expect(isErrorResult(unknownKind)).toBe(true);
      expect(textOf(unknownKind)).toMatch(/unknown kind/i);

      const lowercaseTopic = await client.callTool({
        name: 'wm_create_document',
        arguments: { kind: 'topic', slug: 'nope2', spec: { title: 'x' } },
      });
      expect(isErrorResult(lowercaseTopic)).toBe(true);

      // Registered kind but extra spec fields → validation error, no doc.
      const extraFields = await client.callTool({
        name: 'wm_create_document',
        arguments: {
          kind: 'Topic',
          slug: 'demo',
          spec: { title: 'Demo', steps: ['a'], supplies: 'glue' },
        },
      });
      expect(isErrorResult(extraFields)).toBe(true);
      expect(textOf(extraFields)).toMatch(/invalid spec/i);

      // Nothing above should have persisted.
      const list = jsonOf<{ count: number }>(
        await client.callTool({ name: 'wm_list_documents', arguments: {} }),
      );
      expect(list.count).toBe(0);
    } finally {
      await client.close();
      await server.close();
      store.close();
    }
  });

  it('increments the version and honors the kind filter across tool calls', async () => {
    const store = openStore(':memory:');
    const server = await startServer({ port: 0, store });
    const client = new Client({ name: 'wm-cp-doc-test-2', version: '0.0.0' });
    const transport = new StreamableHTTPClientTransport(new URL(`${server.url}/mcp`));
    try {
      await client.connect(transport);

      await client.callTool({
        name: 'wm_create_document',
        arguments: { kind: 'Topic', slug: 'a', spec: { title: 'A' } },
      });
      // A non-Topic doc seeded directly through the (kind-agnostic) store, so
      // the kind filter below has something to exclude.
      store.createDocument({ kind: 'note', slug: 'b', spec: {}, status: {} });
      const c = jsonOf<Envelope>(
        await client.callTool({
          name: 'wm_create_document',
          arguments: { kind: 'Topic', slug: 'c', spec: { title: 'C' } },
        }),
      );
      expect(c.metadata.resourceVersion).toBe(3);

      const topics = jsonOf<{ count: number; documents: Envelope[] }>(
        await client.callTool({ name: 'wm_list_documents', arguments: { kind: 'Topic' } }),
      );
      expect(topics.count).toBe(2);
      expect(topics.documents.map((d) => d.metadata.slug)).toEqual(['c', 'a']);
    } finally {
      await client.close();
      await server.close();
      store.close();
    }
  });

  it('updates a document via CAS, rejecting stale versions, bad specs, and unknown ids', async () => {
    const store = openStore(':memory:');
    const server = await startServer({ port: 0, store });
    const client = new Client({ name: 'wm-cp-doc-update', version: '0.0.0' });
    const transport = new StreamableHTTPClientTransport(new URL(`${server.url}/mcp`));
    try {
      await client.connect(transport);

      expect((await client.listTools()).tools.map((t) => t.name)).toContain('wm_update_document');

      const created = jsonOf<Envelope>(
        await client.callTool({
          name: 'wm_create_document',
          arguments: { kind: 'Topic', slug: 'edit-me', spec: { title: 'Before' } },
        }),
      );
      expect(created.metadata.resourceVersion).toBe(1);

      // Happy path: change status + body with the correct expected version.
      const updated = jsonOf<Envelope>(
        await client.callTool({
          name: 'wm_update_document',
          arguments: {
            id: created.metadata.id,
            expectedResourceVersion: created.metadata.resourceVersion,
            spec: { title: 'After', body: 'edited', status: 'closed' },
          },
        }),
      );
      expect(updated.metadata.resourceVersion).toBe(2);
      expect(updated.spec).toEqual({
        title: 'After',
        body: 'edited',
        status: 'closed',
        topicType: 'topic',
        parents: [],
      });

      // Stale version → conflict error that mentions the current version.
      const stale = await client.callTool({
        name: 'wm_update_document',
        arguments: {
          id: created.metadata.id,
          expectedResourceVersion: 1,
          spec: { title: 'Nope' },
        },
      });
      expect(isErrorResult(stale)).toBe(true);
      expect(textOf(stale)).toMatch(/conflict/i);
      expect(textOf(stale)).toMatch(/\b2\b/);

      // Invalid / unknown-field spec → rejected, nothing persisted.
      const bad = await client.callTool({
        name: 'wm_update_document',
        arguments: {
          id: created.metadata.id,
          expectedResourceVersion: 2,
          spec: { title: 'x', bogus: 1 },
        },
      });
      expect(isErrorResult(bad)).toBe(true);
      expect(textOf(bad)).toMatch(/invalid spec/i);

      // Row is unchanged after both failures (still version 2, 'After').
      const after = jsonOf<Envelope>(
        await client.callTool({
          name: 'wm_get_document',
          arguments: { id: created.metadata.id },
        }),
      );
      expect(after.metadata.resourceVersion).toBe(2);
      expect(after.spec.title).toBe('After');

      // Unknown id → error.
      const unknown = await client.callTool({
        name: 'wm_update_document',
        arguments: {
          id: '00000000-0000-0000-0000-000000000000',
          expectedResourceVersion: 1,
          spec: { title: 'x' },
        },
      });
      expect(isErrorResult(unknown)).toBe(true);
      expect(textOf(unknown)).toMatch(/unknown id/i);
    } finally {
      await client.close();
      await server.close();
      store.close();
    }
  });
});
