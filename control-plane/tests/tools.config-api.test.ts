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

/** The configmap shape the ws-config-* API maps documents to. */
interface IConfig {
  id: string;
  name: string;
  data: Record<string, string>;
  status: string;
  created_at: number;
  updated_at: number;
  resourceVersion: number;
}

interface ConfigList {
  count: number;
  configs: IConfig[];
}

let clientSeq = 0;

/** Stand up an ephemeral server + connected MCP client over the given store. */
async function connect(store: Store): Promise<{
  client: Client;
  close: () => Promise<void>;
}> {
  const server = await startServer({ port: 0, store });
  const client = new Client({ name: `wm-cp-config-api-${++clientSeq}`, version: '0.0.0' });
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

(sqliteAvailable ? describe : describe.skip)('control-plane Config ws-config-* API', () => {
  beforeAll(async () => {
    // Populate the kind registry (Config's registerApi is what wires ws-config-*).
    clearKinds();
    await loadKinds();
  });

  it('exposes ws-config-* tools alongside the generic wm-document-* tools', async () => {
    const { client, close } = await connect(openStore(':memory:'));
    try {
      const names = (await client.listTools()).tools.map((t) => t.name);
      // Generic CRUD is still present …
      expect(names).toContain('wm-document-create');
      expect(names).toContain('wm-document-read');
      // … PLUS the Config kind's domain API (registered via its registerApi).
      expect(names).toEqual(
        expect.arrayContaining([
          'ws-config-create',
          'ws-config-read',
          'ws-config-update',
          'ws-config-delete',
        ]),
      );
    } finally {
      await close();
    }
  });

  it('round-trips create → read(one+list, query) → update(merge data) → delete/restore', async () => {
    const { client, close } = await connect(openStore(':memory:'));
    try {
      // create — name/status optional, data required. The return is the mapped shape.
      const created = jsonOf<IConfig>(
        await client.callTool({
          name: 'ws-config-create',
          arguments: {
            name: 'Banking App Developer',
            data: { GH_TOKEN: 'ghp_abc', REGION: 'us-east-1' },
          },
        }),
      );
      expect(created).not.toHaveProperty('slug');
      expect(created.name).toBe('Banking App Developer');
      expect(created.data).toEqual({ GH_TOKEN: 'ghp_abc', REGION: 'us-east-1' });
      expect(created.status).toBe('');
      expect(created.id).toMatch(/^[0-9a-f-]{36}$/);
      expect(created.resourceVersion).toBe(1);

      // Read by immutable ID → mapped 0-or-1 list.
      const read = jsonOf<ConfigList>(
        await client.callTool({ name: 'ws-config-read', arguments: { id: created.id } }),
      );
      expect(read.count).toBe(1);
      expect(read.configs[0]?.name).toBe('Banking App Developer');

      // Unknown ID → 0.
      const miss = jsonOf<ConfigList>(
        await client.callTool({ name: 'ws-config-read', arguments: { id: 'missing-config-42' } }),
      );
      expect(miss.count).toBe(0);

      // List mode → contains it.
      const list = jsonOf<ConfigList>(
        await client.callTool({ name: 'ws-config-read', arguments: {} }),
      );
      expect(list.count).toBe(1);
      expect(list.configs[0]?.id).toBe(created.id);

      // query filter over KEYS (case-insensitive substring): matches a key, excludes a miss.
      const queried = jsonOf<ConfigList>(
        await client.callTool({ name: 'ws-config-read', arguments: { query: 'gh_token' } }),
      );
      expect(queried.count).toBe(1);
      const noMatch = jsonOf<ConfigList>(
        await client.callTool({ name: 'ws-config-read', arguments: { query: 'zzz-nomatch' } }),
      );
      expect(noMatch.count).toBe(0);

      // update — MERGE data (add a key, overwrite one), REPLACE name; untouched keys survive.
      const updated = jsonOf<IConfig>(
        await client.callTool({
          name: 'ws-config-update',
          arguments: {
            id: created.id,
            name: 'Banking App Dev v2',
            data: { REGION: 'eu-west-1', EXTRA: 'yes' },
          },
        }),
      );
      expect(updated.name).toBe('Banking App Dev v2');
      // GH_TOKEN survived the merge; REGION overwritten; EXTRA added.
      expect(updated.data).toEqual({ GH_TOKEN: 'ghp_abc', REGION: 'eu-west-1', EXTRA: 'yes' });
      expect(updated.resourceVersion).toBe(2);

      const afterUpdate = jsonOf<ConfigList>(
        await client.callTool({ name: 'ws-config-read', arguments: { id: created.id } }),
      );
      expect(afterUpdate.configs[0]?.data.GH_TOKEN).toBe('ghp_abc');

      // delete — drops out of ws-config-read.
      const del = jsonOf<{ ok: boolean; id: string }>(
        await client.callTool({ name: 'ws-config-delete', arguments: { id: created.id } }),
      );
      expect(del).toEqual({ ok: true, id: created.id });
      expect(
        jsonOf<ConfigList>(
          await client.callTool({ name: 'ws-config-read', arguments: { id: created.id } }),
        ).count,
      ).toBe(0);

      // restore: true → back in ws-config-read, spec intact.
      const restored = jsonOf<{ ok: boolean; id: string }>(
        await client.callTool({
          name: 'ws-config-delete',
          arguments: { id: created.id, restore: true },
        }),
      );
      expect(restored).toEqual({ ok: true, id: created.id });
      const afterRestore = jsonOf<ConfigList>(
        await client.callTool({ name: 'ws-config-read', arguments: { id: created.id } }),
      );
      expect(afterRestore.count).toBe(1);
      expect(afterRestore.configs[0]?.data).toEqual({
        GH_TOKEN: 'ghp_abc',
        REGION: 'eu-west-1',
        EXTRA: 'yes',
      });
    } finally {
      await close();
    }
  });

  it('ws-config-update surfaces a CAS conflict when the stored version has advanced', async () => {
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
      const created = jsonOf<IConfig>(await client.callTool({
        name: 'ws-config-create',
        arguments: { data: { A: '1' } },
      }));
      await client.callTool({
        name: 'ws-config-update',
        arguments: { id: created.id, data: { A: '2' } },
      });
      staleVersion = 1;
      const conflict = await client.callTool({
        name: 'ws-config-update',
        arguments: { id: created.id, data: { A: '3' } },
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
      // A non-string data value passes the tool schema loosely but fails the
      // kind schema (z.record(string, string)) → kind-validation rejection.
      const badCreate = await client.callTool({
        name: 'ws-config-create',
        arguments: { data: { PORT: 8080 } },
      });
      expect(isErrorResult(badCreate)).toBe(true);
      expect(textOf(badCreate)).toMatch(/data/i);
      expect(
        jsonOf<ConfigList>(await client.callTool({ name: 'ws-config-read', arguments: {} })).count,
      ).toBe(0);

      // A valid create, then an invalid-data update, is also rejected …
      const created = jsonOf<IConfig>(await client.callTool({
        name: 'ws-config-create',
        arguments: { data: { A: '1' } },
      }));
      const badUpdate = await client.callTool({
        name: 'ws-config-update',
        arguments: { id: created.id, data: { B: 2 } },
      });
      expect(isErrorResult(badUpdate)).toBe(true);
      expect(textOf(badUpdate)).toMatch(/data/i);
      // … and leaves the config unchanged.
      const still = jsonOf<ConfigList>(
        await client.callTool({ name: 'ws-config-read', arguments: { id: created.id } }),
      );
      expect(still.configs[0]?.data).toEqual({ A: '1' });
    } finally {
      await close();
    }
  });

  it('errors clearly on unknown-ID update, delete, and restore', async () => {
    const { client, close } = await connect(openStore(':memory:'));
    try {
      const badUpdate = await client.callTool({
        name: 'ws-config-update',
        arguments: { id: 'ghost', name: 'X' },
      });
      expect(isErrorResult(badUpdate)).toBe(true);
      expect(textOf(badUpdate)).toMatch(/ghost/);

      const badDelete = await client.callTool({
        name: 'ws-config-delete',
        arguments: { id: 'ghost' },
      });
      expect(isErrorResult(badDelete)).toBe(true);
      expect(textOf(badDelete)).toMatch(/ghost/);

      const badRestore = await client.callTool({
        name: 'ws-config-delete',
        arguments: { id: 'ghost', restore: true },
      });
      expect(isErrorResult(badRestore)).toBe(true);
      expect(textOf(badRestore)).toMatch(/ghost/);
    } finally {
      await close();
    }
  });
});
