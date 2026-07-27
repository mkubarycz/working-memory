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

/** The legacy workstream shape the ws-* API maps documents to. */
interface IWorkstream {
  id: string;
  slug: string | null;
  title: string;
  status: string;
  closure: string | null;
  opened_at: number;
  updated_at: number;
  closed_at: number | null;
  resourceVersion: number;
}

(sqliteAvailable ? describe : describe.skip)('control-plane Workstream ws-* API', () => {
  beforeAll(async () => {
    // Populate the kind registry (Workstream's registerApi is what wires ws-*).
    clearKinds();
    await loadKinds();
  });

  it('exposes ws-* tools alongside the generic wm-document-* tools', async () => {
    const store = openStore(':memory:');
    const server = await startServer({ port: 0, store });
    const client = new Client({ name: 'wm-cp-ws-api-1', version: '0.0.0' });
    const transport = new StreamableHTTPClientTransport(new URL(`${server.url}/mcp`));
    try {
      await client.connect(transport);
      const names = (await client.listTools()).tools.map((t) => t.name);
      // Generic CRUD is still present …
      expect(names).toContain('wm-document-create');
      expect(names).toContain('wm-document-read');
      // … PLUS the Workstream kind's domain API (registered via its registerApi).
      expect(names).toEqual(
        expect.arrayContaining(['ws-workstream-create', 'ws-workstream-read', 'ws-workstream-update', 'ws-workstream-delete']),
      );
    } finally {
      await client.close();
      await server.close();
      store.close();
    }
  });

  it('round-trips ws-workstream-create → ws-workstream-read (mapped) → ws-workstream-update → ws-workstream-delete/restore', async () => {
    const store = openStore(':memory:');
    const server = await startServer({ port: 0, store });
    const client = new Client({ name: 'wm-cp-ws-api-2', version: '0.0.0' });
    const transport = new StreamableHTTPClientTransport(new URL(`${server.url}/mcp`));
    try {
      await client.connect(transport);

      // create — status defaults to 'progress'; the return is the mapped shape.
      const created = jsonOf<IWorkstream>(
        await client.callTool({
          name: 'ws-workstream-create',
          arguments: { slug: 'cp', title: 'Control Plane' },
        }),
      );
      expect(created.slug).toBe('cp');
      expect(created.title).toBe('Control Plane');
      expect(created.status).toBe('progress');
      expect(created.closed_at).toBeNull();
      expect(created.id).toMatch(/^[0-9a-f-]{36}$/);

      // read by slug → mapped 0-or-1 list.
      const read = jsonOf<{ count: number; workstreams: IWorkstream[] }>(
        await client.callTool({ name: 'ws-workstream-read', arguments: { slug: 'cp' } }),
      );
      expect(read.count).toBe(1);
      expect(read.workstreams[0]?.title).toBe('Control Plane');
      expect(read.workstreams[0]?.status).toBe('progress');

      // list mode (no slug/id) → contains it.
      const list = jsonOf<{ count: number; workstreams: IWorkstream[] }>(
        await client.callTool({ name: 'ws-workstream-read', arguments: {} }),
      );
      expect(list.count).toBe(1);
      expect(list.workstreams[0]?.slug).toBe('cp');

      // update — change title + status, both reflected on a subsequent read.
      const updated = jsonOf<IWorkstream>(
        await client.callTool({
          name: 'ws-workstream-update',
          arguments: { slug: 'cp', title: 'Control Plane v2', status: 'closed' },
        }),
      );
      expect(updated.title).toBe('Control Plane v2');
      expect(updated.status).toBe('closed');
      expect(updated.closed_at).not.toBeNull();

      const afterUpdate = jsonOf<{ count: number; workstreams: IWorkstream[] }>(
        await client.callTool({ name: 'ws-workstream-read', arguments: { slug: 'cp' } }),
      );
      expect(afterUpdate.workstreams[0]?.title).toBe('Control Plane v2');
      expect(afterUpdate.workstreams[0]?.status).toBe('closed');

      // delete — drops out of ws-workstream-read (both single + list).
      const del = jsonOf<{ ok: boolean; slug: string }>(
        await client.callTool({ name: 'ws-workstream-delete', arguments: { slug: 'cp' } }),
      );
      expect(del).toEqual({ ok: true, slug: 'cp' });
      const afterDelete = jsonOf<{ count: number }>(
        await client.callTool({ name: 'ws-workstream-read', arguments: { slug: 'cp' } }),
      );
      expect(afterDelete.count).toBe(0);
      const listAfterDelete = jsonOf<{ count: number }>(
        await client.callTool({ name: 'ws-workstream-read', arguments: {} }),
      );
      expect(listAfterDelete.count).toBe(0);

      // restore: true → back in ws-workstream-read, with its spec intact (status survived).
      const restored = jsonOf<{ ok: boolean; slug: string }>(
        await client.callTool({ name: 'ws-workstream-delete', arguments: { slug: 'cp', restore: true } }),
      );
      expect(restored).toEqual({ ok: true, slug: 'cp' });
      const afterRestore = jsonOf<{ count: number; workstreams: IWorkstream[] }>(
        await client.callTool({ name: 'ws-workstream-read', arguments: { slug: 'cp' } }),
      );
      expect(afterRestore.count).toBe(1);
      expect(afterRestore.workstreams[0]?.status).toBe('closed');
    } finally {
      await client.close();
      await server.close();
      store.close();
    }
  });

  it('rejects an invalid status via kind validation (create + update)', async () => {
    const store = openStore(':memory:');
    const server = await startServer({ port: 0, store });
    const client = new Client({ name: 'wm-cp-ws-api-3', version: '0.0.0' });
    const transport = new StreamableHTTPClientTransport(new URL(`${server.url}/mcp`));
    try {
      await client.connect(transport);

      const badCreate = await client.callTool({
        name: 'ws-workstream-create',
        arguments: { slug: 'bad', title: 'Bad', status: 'nonsense' },
      });
      expect(isErrorResult(badCreate)).toBe(true);
      expect(textOf(badCreate)).toMatch(/status/i);

      // The rejected create persisted nothing.
      const list = jsonOf<{ count: number }>(
        await client.callTool({ name: 'ws-workstream-read', arguments: {} }),
      );
      expect(list.count).toBe(0);

      // A valid create, then an invalid-status update, is also rejected …
      await client.callTool({ name: 'ws-workstream-create', arguments: { slug: 'ok', title: 'OK' } });
      const badUpdate = await client.callTool({
        name: 'ws-workstream-update',
        arguments: { slug: 'ok', status: 'nonsense' },
      });
      expect(isErrorResult(badUpdate)).toBe(true);
      expect(textOf(badUpdate)).toMatch(/status/i);

      // … and leaves the workstream unchanged.
      const still = jsonOf<{ count: number; workstreams: IWorkstream[] }>(
        await client.callTool({ name: 'ws-workstream-read', arguments: { slug: 'ok' } }),
      );
      expect(still.workstreams[0]?.status).toBe('progress');
    } finally {
      await client.close();
      await server.close();
      store.close();
    }
  });

  it('errors clearly on unknown-slug update, delete, and restore', async () => {
    const store = openStore(':memory:');
    const server = await startServer({ port: 0, store });
    const client = new Client({ name: 'wm-cp-ws-api-4', version: '0.0.0' });
    const transport = new StreamableHTTPClientTransport(new URL(`${server.url}/mcp`));
    try {
      await client.connect(transport);

      const badUpdate = await client.callTool({
        name: 'ws-workstream-update',
        arguments: { slug: 'ghost', title: 'X' },
      });
      expect(isErrorResult(badUpdate)).toBe(true);
      expect(textOf(badUpdate)).toMatch(/ghost/);

      const badDelete = await client.callTool({
        name: 'ws-workstream-delete',
        arguments: { slug: 'ghost' },
      });
      expect(isErrorResult(badDelete)).toBe(true);
      expect(textOf(badDelete)).toMatch(/ghost/);

      const badRestore = await client.callTool({
        name: 'ws-workstream-delete',
        arguments: { slug: 'ghost', restore: true },
      });
      expect(isErrorResult(badRestore)).toBe(true);
      expect(textOf(badRestore)).toMatch(/ghost/);
    } finally {
      await client.close();
      await server.close();
      store.close();
    }
  });
});
