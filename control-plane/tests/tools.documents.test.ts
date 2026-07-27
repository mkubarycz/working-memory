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
  metadata: { id: string; slug: string | null; labels: Record<string, string>; resourceVersion: number };
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

  it('exposes the document tools and round-trips create → read (list) → read (by id)', async () => {
    const store = openStore(':memory:');
    const server = await startServer({ port: 0, store });
    const client = new Client({ name: 'wm-cp-doc-test', version: '0.0.0' });
    const transport = new StreamableHTTPClientTransport(new URL(`${server.url}/mcp`));
    try {
      await client.connect(transport);

      const names = (await client.listTools()).tools.map((t) => t.name);
      expect(names).toContain('wm-ping');
      expect(names).toContain('wm-document-create');
      expect(names).toContain('wm-document-read');
      // The old get/list tools were collapsed into wm-document-read.
      expect(names).not.toContain('wm_list_documents');
      expect(names).not.toContain('wm_get_document');

      const created = jsonOf<Envelope>(
        await client.callTool({
          name: 'wm-document-create',
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
        workstreams: [],
      });

      const list = jsonOf<{ count: number; documents: Envelope[] }>(
        await client.callTool({ name: 'wm-document-read', arguments: {} }),
      );
      expect(list.count).toBe(1);
      expect(list.documents[0]?.metadata.slug).toBe('demo');

      // Read by id → uniform { count, documents } shape with a single element.
      const got = jsonOf<{ count: number; documents: Envelope[] }>(
        await client.callTool({
          name: 'wm-document-read',
          arguments: { id: created.metadata.id },
        }),
      );
      expect(got.count).toBe(1);
      expect(got.documents[0]?.metadata.slug).toBe('demo');

      // A miss (unknown slug) is an empty list, not a special { found: false }.
      const miss = jsonOf<{ count: number; documents: Envelope[] }>(
        await client.callTool({ name: 'wm-document-read', arguments: { slug: 'nope' } }),
      );
      expect(miss).toEqual({ count: 0, documents: [] });
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
        name: 'wm-document-create',
        arguments: { kind: 'note', slug: 'nope', spec: { title: 'x' } },
      });
      expect(isErrorResult(unknownKind)).toBe(true);
      expect(textOf(unknownKind)).toMatch(/unknown kind/i);

      const lowercaseTopic = await client.callTool({
        name: 'wm-document-create',
        arguments: { kind: 'topic', slug: 'nope2', spec: { title: 'x' } },
      });
      expect(isErrorResult(lowercaseTopic)).toBe(true);

      // Registered kind but extra spec fields → validation error, no doc.
      const extraFields = await client.callTool({
        name: 'wm-document-create',
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
        await client.callTool({ name: 'wm-document-read', arguments: {} }),
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
        name: 'wm-document-create',
        arguments: { kind: 'Topic', slug: 'a', spec: { title: 'A' } },
      });
      // A non-Topic doc seeded directly through the (kind-agnostic) store, so
      // the kind filter below has something to exclude.
      store.createDocument({ kind: 'note', slug: 'b', spec: {}, status: {} });
      const c = jsonOf<Envelope>(
        await client.callTool({
          name: 'wm-document-create',
          arguments: { kind: 'Topic', slug: 'c', spec: { title: 'C' } },
        }),
      );
      expect(c.metadata.resourceVersion).toBe(3);

      const topics = jsonOf<{ count: number; documents: Envelope[] }>(
        await client.callTool({ name: 'wm-document-read', arguments: { kind: 'Topic' } }),
      );
      expect(topics.count).toBe(2);
      expect(topics.documents.map((d) => d.metadata.slug)).toEqual(['c', 'a']);
    } finally {
      await client.close();
      await server.close();
      store.close();
    }
  });

  it('wm-document-read: reads by id, by kind-filtered list, and by query substring', async () => {
    const store = openStore(':memory:');
    const server = await startServer({ port: 0, store });
    const client = new Client({ name: 'wm-cp-doc-read', version: '0.0.0' });
    const transport = new StreamableHTTPClientTransport(new URL(`${server.url}/mcp`));
    try {
      await client.connect(transport);

      const alpha = jsonOf<Envelope>(
        await client.callTool({
          name: 'wm-document-create',
          arguments: { kind: 'Topic', slug: 'alpha', spec: { title: 'Alpha Widget' } },
        }),
      );
      await client.callTool({
        name: 'wm-document-create',
        arguments: { kind: 'Topic', slug: 'beta', spec: { title: 'Beta Gadget' } },
      });
      // A non-Topic doc so the kind filter has something to exclude.
      store.createDocument({ kind: 'note', slug: 'gamma', spec: {}, status: {} });

      // Mode 1: read one by id → uniform { count, documents } with a single element.
      const byId = jsonOf<{ count: number; documents: Envelope[] }>(
        await client.callTool({ name: 'wm-document-read', arguments: { id: alpha.metadata.id } }),
      );
      expect(byId.count).toBe(1);
      expect(byId.documents).toHaveLength(1);
      expect(byId.documents[0]?.metadata.slug).toBe('alpha');

      // Read one by slug too.
      const bySlug = jsonOf<{ count: number; documents: Envelope[] }>(
        await client.callTool({ name: 'wm-document-read', arguments: { slug: 'beta' } }),
      );
      expect(bySlug.count).toBe(1);
      expect(bySlug.documents[0]?.metadata.slug).toBe('beta');

      // Mode 2: list filtered by kind → only the two Topics, newest-first.
      const topics = jsonOf<{ count: number; documents: Envelope[] }>(
        await client.callTool({ name: 'wm-document-read', arguments: { kind: 'Topic' } }),
      );
      expect(topics.count).toBe(2);
      expect(topics.documents.map((d) => d.metadata.slug)).toEqual(['beta', 'alpha']);

      // Mode 3: basic case-insensitive substring query over document text.
      const gadget = jsonOf<{ count: number; documents: Envelope[] }>(
        await client.callTool({ name: 'wm-document-read', arguments: { query: 'gadget' } }),
      );
      expect(gadget.count).toBe(1);
      expect(gadget.documents[0]?.metadata.slug).toBe('beta');

      // query combines with kind, and limit caps the result set.
      const limited = jsonOf<{ count: number; documents: Envelope[] }>(
        await client.callTool({
          name: 'wm-document-read',
          arguments: { kind: 'Topic', limit: 1 },
        }),
      );
      expect(limited.count).toBe(1);
      expect(limited.documents[0]?.metadata.slug).toBe('beta');

      // A query that matches nothing → empty uniform shape.
      const none = jsonOf<{ count: number; documents: Envelope[] }>(
        await client.callTool({ name: 'wm-document-read', arguments: { query: 'zzz-no-match' } }),
      );
      expect(none).toEqual({ count: 0, documents: [] });
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

      expect((await client.listTools()).tools.map((t) => t.name)).toContain('wm-document-update');

      const created = jsonOf<Envelope>(
        await client.callTool({
          name: 'wm-document-create',
          arguments: { kind: 'Topic', slug: 'edit-me', spec: { title: 'Before' } },
        }),
      );
      expect(created.metadata.resourceVersion).toBe(1);

      // Happy path: change status + body with the correct expected version.
      const updated = jsonOf<Envelope>(
        await client.callTool({
          name: 'wm-document-update',
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
        workstreams: [],
      });

      // Stale version → conflict error that mentions the current version.
      const stale = await client.callTool({
        name: 'wm-document-update',
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
        name: 'wm-document-update',
        arguments: {
          id: created.metadata.id,
          expectedResourceVersion: 2,
          spec: { title: 'x', bogus: 1 },
        },
      });
      expect(isErrorResult(bad)).toBe(true);
      expect(textOf(bad)).toMatch(/invalid spec/i);

      // Row is unchanged after both failures (still version 2, 'After').
      const after = jsonOf<{ count: number; documents: Envelope[] }>(
        await client.callTool({
          name: 'wm-document-read',
          arguments: { id: created.metadata.id },
        }),
      );
      expect(after.documents[0]?.metadata.resourceVersion).toBe(2);
      expect(after.documents[0]?.spec.title).toBe('After');

      // Unknown id → error.
      const unknown = await client.callTool({
        name: 'wm-document-update',
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

  it('patches spec (partial merge), slug, and labels; requires at least one field', async () => {
    const store = openStore(':memory:');
    const server = await startServer({ port: 0, store });
    const client = new Client({ name: 'wm-cp-doc-patch', version: '0.0.0' });
    const transport = new StreamableHTTPClientTransport(new URL(`${server.url}/mcp`));
    try {
      await client.connect(transport);

      const created = jsonOf<Envelope>(
        await client.callTool({
          name: 'wm-document-create',
          arguments: {
            kind: 'Topic',
            slug: 'patch-me',
            labels: { keep: 'me' },
            spec: { title: 'Title', body: 'Body' },
          },
        }),
      );
      expect(created.metadata.resourceVersion).toBe(1);

      // Partial spec patch: only `status` provided → title/body preserved.
      const closed = jsonOf<Envelope>(
        await client.callTool({
          name: 'wm-document-update',
          arguments: {
            id: created.metadata.id,
            expectedResourceVersion: created.metadata.resourceVersion,
            spec: { status: 'closed' },
          },
        }),
      );
      expect(closed.metadata.resourceVersion).toBe(2);
      expect(closed.spec).toEqual({
        title: 'Title',
        body: 'Body',
        status: 'closed',
        topicType: 'topic',
        parents: [],
        workstreams: [],
      });
      // slug/labels untouched by a spec-only patch.
      expect(closed.metadata.slug).toBe('patch-me');
      expect(closed.metadata.labels).toEqual({ keep: 'me' });

      // Unknown field in the patch → merged spec is strict-invalid → rejected.
      const bogus = await client.callTool({
        name: 'wm-document-update',
        arguments: {
          id: created.metadata.id,
          expectedResourceVersion: 2,
          spec: { bogus: 1 },
        },
      });
      expect(isErrorResult(bogus)).toBe(true);
      expect(textOf(bogus)).toMatch(/invalid spec/i);
      // Not persisted — still version 2.
      const afterBogus = jsonOf<{ count: number; documents: Envelope[] }>(
        await client.callTool({ name: 'wm-document-read', arguments: { id: created.metadata.id } }),
      );
      expect(afterBogus.documents[0]?.metadata.resourceVersion).toBe(2);

      // slug-only patch → slug changes, spec unchanged.
      const reslugged = jsonOf<Envelope>(
        await client.callTool({
          name: 'wm-document-update',
          arguments: {
            id: created.metadata.id,
            expectedResourceVersion: 2,
            slug: 'new-slug',
          },
        }),
      );
      expect(reslugged.metadata.slug).toBe('new-slug');
      expect(reslugged.metadata.resourceVersion).toBe(3);
      expect(reslugged.spec).toEqual(closed.spec);

      // labels-only patch → whole labels object replaced.
      const relabeled = jsonOf<Envelope>(
        await client.callTool({
          name: 'wm-document-update',
          arguments: {
            id: created.metadata.id,
            expectedResourceVersion: 3,
            labels: { a: 'b' },
          },
        }),
      );
      expect(relabeled.metadata.labels).toEqual({ a: 'b' });
      expect(relabeled.metadata.resourceVersion).toBe(4);

      // Clear a field explicitly: parents already []; set a parent then clear it.
      const withParent = jsonOf<Envelope>(
        await client.callTool({
          name: 'wm-document-update',
          arguments: {
            id: created.metadata.id,
            expectedResourceVersion: 4,
            spec: { parents: ['p1'] },
          },
        }),
      );
      expect(withParent.spec.parents).toEqual(['p1']);
      const cleared = jsonOf<Envelope>(
        await client.callTool({
          name: 'wm-document-update',
          arguments: {
            id: created.metadata.id,
            expectedResourceVersion: withParent.metadata.resourceVersion,
            spec: { parents: [] },
          },
        }),
      );
      expect(cleared.spec.parents).toEqual([]);

      // No fields provided → error, nothing persisted.
      const empty = await client.callTool({
        name: 'wm-document-update',
        arguments: {
          id: created.metadata.id,
          expectedResourceVersion: cleared.metadata.resourceVersion,
        },
      });
      expect(isErrorResult(empty)).toBe(true);
      expect(textOf(empty)).toMatch(/nothing to update/i);

      // Stale version → conflict mentioning the current version.
      const stale = await client.callTool({
        name: 'wm-document-update',
        arguments: {
          id: created.metadata.id,
          expectedResourceVersion: 2,
          slug: 'whatever',
        },
      });
      expect(isErrorResult(stale)).toBe(true);
      expect(textOf(stale)).toMatch(/conflict/i);
      expect(textOf(stale)).toMatch(new RegExp(`\\b${cleared.metadata.resourceVersion}\\b`));

      // Unknown id → error.
      const unknown = await client.callTool({
        name: 'wm-document-update',
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
