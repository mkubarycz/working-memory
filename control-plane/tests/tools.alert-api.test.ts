import { describe, it, expect, beforeAll } from 'vitest';
import { startServer } from '../src/server';
import { openStore, type Store, type DocumentEnvelope } from '../src/store';
import { clearKinds } from '../src/kinds/registry';
import { loadKinds } from '../src/kinds/loader';
import { Alert } from '../src/kinds/alert/alert';
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

/** The legacy alert shape the ws-alert-* API maps documents to. */
interface IAlert {
  id: string;
  slug: string | null;
  title: string;
  description: string;
  recommended_action: string;
  status: string;
  dedupe_key: string | null;
  created_by: string;
  created_at: number;
  updated_at: number;
  resourceVersion: number;
}

interface AlertList {
  count: number;
  alerts: IAlert[];
}

let clientSeq = 0;

/** Stand up an ephemeral server + connected MCP client over the given store. */
async function connect(store: Store): Promise<{
  client: Client;
  close: () => Promise<void>;
}> {
  const server = await startServer({ port: 0, store });
  const client = new Client({ name: `wm-cp-alert-api-${++clientSeq}`, version: '0.0.0' });
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

(sqliteAvailable ? describe : describe.skip)('control-plane Alert ws-alert-* API', () => {
  beforeAll(async () => {
    // Populate the kind registry (Alert's registerApi is what wires ws-alert-*).
    clearKinds();
    await loadKinds();
  });

  it('exposes ws-alert-* tools alongside the generic wm-document-* tools', async () => {
    const { client, close } = await connect(openStore(':memory:'));
    try {
      const names = (await client.listTools()).tools.map((t) => t.name);
      expect(names).toContain('wm-document-create');
      expect(names).toContain('wm-document-read');
      expect(names).toEqual(
        expect.arrayContaining([
          'ws-alert-create',
          'ws-alert-read',
          'ws-alert-update',
          'ws-alert-delete',
        ]),
      );
    } finally {
      await close();
    }
  });

  it('round-trips create → read(one+list, query) → update(happy) → delete/restore', async () => {
    const { client, close } = await connect(openStore(':memory:'));
    try {
      // create — title/recommended_action/status/created_by default; return is mapped.
      const created = jsonOf<IAlert>(
        await client.callTool({
          name: 'ws-alert-create',
          arguments: { description: 'Disk is nearly full.' },
        }),
      );
      // Alerts have NO slug — identity is the uuid `id`.
      expect(created.slug).toBeNull();
      expect(created.description).toBe('Disk is nearly full.');
      expect(created.title).toBe('');
      expect(created.recommended_action).toBe('');
      expect(created.status).toBe('alert');
      expect(created.created_by).toBe('system');
      expect(created.id).toMatch(/^[0-9a-f-]{36}$/);
      expect(created.resourceVersion).toBe(1);
      const id = created.id;

      // read by id → mapped 0-or-1 list.
      const read = jsonOf<AlertList>(
        await client.callTool({ name: 'ws-alert-read', arguments: { id } }),
      );
      expect(read.count).toBe(1);
      expect(read.alerts[0]?.description).toBe('Disk is nearly full.');

      // read by unknown id → 0.
      const miss = jsonOf<AlertList>(
        await client.callTool({
          name: 'ws-alert-read',
          arguments: { id: '00000000-0000-0000-0000-000000000000' },
        }),
      );
      expect(miss.count).toBe(0);

      // list mode → contains it; query matches then excludes.
      const list = jsonOf<AlertList>(
        await client.callTool({ name: 'ws-alert-read', arguments: {} }),
      );
      expect(list.count).toBe(1);
      const queried = jsonOf<AlertList>(
        await client.callTool({ name: 'ws-alert-read', arguments: { query: 'disk' } }),
      );
      expect(queried.count).toBe(1);
      const noMatch = jsonOf<AlertList>(
        await client.callTool({ name: 'ws-alert-read', arguments: { query: 'zzz-nomatch' } }),
      );
      expect(noMatch.count).toBe(0);

      // update — change title + status; unpatched description survives the merge.
      const updated = jsonOf<IAlert>(
        await client.callTool({
          name: 'ws-alert-update',
          arguments: { id, title: 'Low disk', status: 'closed' },
        }),
      );
      expect(updated.title).toBe('Low disk');
      expect(updated.status).toBe('closed');
      expect(updated.description).toBe('Disk is nearly full.');
      expect(updated.resourceVersion).toBe(2);

      // delete — drops out of ws-alert-read.
      const del = jsonOf<{ ok: boolean; id: string }>(
        await client.callTool({ name: 'ws-alert-delete', arguments: { id } }),
      );
      expect(del).toEqual({ ok: true, id });
      expect(
        jsonOf<AlertList>(await client.callTool({ name: 'ws-alert-read', arguments: { id } })).count,
      ).toBe(0);

      // restore: true → back in ws-alert-read, spec intact (status survived).
      const restored = jsonOf<{ ok: boolean; id: string }>(
        await client.callTool({ name: 'ws-alert-delete', arguments: { id, restore: true } }),
      );
      expect(restored).toEqual({ ok: true, id });
      const afterRestore = jsonOf<AlertList>(
        await client.callTool({ name: 'ws-alert-read', arguments: { id } }),
      );
      expect(afterRestore.count).toBe(1);
      expect(afterRestore.alerts[0]?.status).toBe('closed');
    } finally {
      await close();
    }
  });

  it('ws-alert-update surfaces a CAS conflict when the stored version has advanced', async () => {
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
      const created = jsonOf<IAlert>(
        await client.callTool({ name: 'ws-alert-create', arguments: { description: 'Race' } }),
      );
      const id = created.id;
      await client.callTool({ name: 'ws-alert-update', arguments: { id, title: 'Race v2' } });
      staleVersion = 1;
      const conflict = await client.callTool({
        name: 'ws-alert-update',
        arguments: { id, title: 'Race v3' },
      });
      expect(isErrorResult(conflict)).toBe(true);
      expect(textOf(conflict)).toMatch(/conflict/i);
    } finally {
      await close();
    }
  });

  it('rejects an invalid status via kind validation (create + update), persisting nothing', async () => {
    const { client, close } = await connect(openStore(':memory:'));
    try {
      const badCreate = await client.callTool({
        name: 'ws-alert-create',
        arguments: { description: 'D', status: 'nonsense' },
      });
      expect(isErrorResult(badCreate)).toBe(true);
      expect(textOf(badCreate)).toMatch(/status/i);
      expect(
        jsonOf<AlertList>(await client.callTool({ name: 'ws-alert-read', arguments: {} })).count,
      ).toBe(0);

      // A valid create, then an invalid-status update, is also rejected …
      const ok = jsonOf<IAlert>(
        await client.callTool({ name: 'ws-alert-create', arguments: { description: 'OK' } }),
      );
      const badUpdate = await client.callTool({
        name: 'ws-alert-update',
        arguments: { id: ok.id, status: 'nonsense' },
      });
      expect(isErrorResult(badUpdate)).toBe(true);
      expect(textOf(badUpdate)).toMatch(/status/i);
      // … and leaves the alert unchanged (still 'alert').
      const still = jsonOf<AlertList>(
        await client.callTool({ name: 'ws-alert-read', arguments: { id: ok.id } }),
      );
      expect(still.alerts[0]?.status).toBe('alert');
    } finally {
      await close();
    }
  });

  it('errors clearly on unknown-id update, delete, and restore', async () => {
    const { client, close } = await connect(openStore(':memory:'));
    try {
      const badUpdate = await client.callTool({
        name: 'ws-alert-update',
        arguments: { id: 'ghost-id', title: 'X' },
      });
      expect(isErrorResult(badUpdate)).toBe(true);
      expect(textOf(badUpdate)).toMatch(/ghost-id/);

      const badDelete = await client.callTool({
        name: 'ws-alert-delete',
        arguments: { id: 'ghost-id' },
      });
      expect(isErrorResult(badDelete)).toBe(true);
      expect(textOf(badDelete)).toMatch(/ghost-id/);

      const badRestore = await client.callTool({
        name: 'ws-alert-delete',
        arguments: { id: 'ghost-id', restore: true },
      });
      expect(isErrorResult(badRestore)).toBe(true);
      expect(textOf(badRestore)).toMatch(/ghost-id/);
    } finally {
      await close();
    }
  });

  it('POCO: JSON.stringify(new Alert(env)) is a stable projection of the document', () => {
    const env: DocumentEnvelope = {
      kind: 'Alert',
      metadata: {
        id: '22222222-2222-2222-2222-222222222222',
        slug: null,
        labels: {},
        createdAt: 1000,
        updatedAt: 2000,
        deletedAt: null,
        resourceVersion: 4,
      },
      spec: {
        title: 'Low disk',
        description: 'Disk is nearly full.',
        recommended_action: 'Free up space.',
        status: 'informational',
        dedupe_key: 'disk-space',
        created_by: 'monitor',
      },
      status: {},
    };
    expect(JSON.parse(JSON.stringify(new Alert(env)))).toEqual({
      id: '22222222-2222-2222-2222-222222222222',
      slug: null,
      title: 'Low disk',
      description: 'Disk is nearly full.',
      recommended_action: 'Free up space.',
      status: 'informational',
      dedupe_key: 'disk-space',
      created_by: 'monitor',
      created_at: 1000,
      updated_at: 2000,
      resourceVersion: 4,
    });
  });
});
