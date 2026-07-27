import { describe, it, expect, beforeAll } from 'vitest';
import { startServer } from '../src/server';
import { openStore, type Store, type DocumentEnvelope } from '../src/store';
import { clearKinds } from '../src/kinds/registry';
import { loadKinds } from '../src/kinds/loader';
import { JournalEntry } from '../src/kinds/journalentry/journalentry';
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

/** The legacy journal-entry shape the ws-journalentry-* API maps documents to. */
interface IJournalEntry {
  id: string;
  slug: string | null;
  body: string;
  workstream: string;
  session: string | null;
  topics: string[];
  createdBy: string;
  created_at: number;
  updated_at: number;
  resourceVersion: number;
}

interface JournalEntryList {
  count: number;
  journalEntries: IJournalEntry[];
}

let clientSeq = 0;

/** Stand up an ephemeral server + connected MCP client over the given store. */
async function connect(store: Store): Promise<{
  client: Client;
  close: () => Promise<void>;
}> {
  const server = await startServer({ port: 0, store });
  const client = new Client({ name: `wm-cp-journalentry-api-${++clientSeq}`, version: '0.0.0' });
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

(sqliteAvailable ? describe : describe.skip)('control-plane JournalEntry ws-journalentry-* API', () => {
  beforeAll(async () => {
    // Populate the kind registry (JournalEntry's registerApi wires ws-journalentry-*).
    clearKinds();
    await loadKinds();
  });

  it('exposes ws-journalentry-* tools alongside the generic wm-document-* tools', async () => {
    const { client, close } = await connect(openStore(':memory:'));
    try {
      const names = (await client.listTools()).tools.map((t) => t.name);
      expect(names).toContain('wm-document-create');
      expect(names).toContain('wm-document-read');
      expect(names).toEqual(
        expect.arrayContaining([
          'ws-journalentry-create',
          'ws-journalentry-read',
          'ws-journalentry-update',
          'ws-journalentry-delete',
        ]),
      );
    } finally {
      await close();
    }
  });

  it('round-trips create → read(one+list, query) → update(happy) → delete/restore', async () => {
    const { client, close } = await connect(openStore(':memory:'));
    try {
      // create — topics/createdBy default; the return is the mapped shape.
      const created = jsonOf<IJournalEntry>(
        await client.callTool({
          name: 'ws-journalentry-create',
          arguments: { body: 'shipped the JournalEntry API', workstream: 'data-tier-mcp' },
        }),
      );
      // Entries have NO slug — identity is the uuid `id`.
      expect(created.slug).toBeNull();
      expect(created.body).toBe('shipped the JournalEntry API');
      expect(created.workstream).toBe('data-tier-mcp');
      expect(created.session).toBeNull();
      expect(created.topics).toEqual([]);
      expect(created.createdBy).toBe('system');
      expect(created.id).toMatch(/^[0-9a-f-]{36}$/);
      expect(created.resourceVersion).toBe(1);
      const id = created.id;

      // read by id → mapped 0-or-1 list.
      const read = jsonOf<JournalEntryList>(
        await client.callTool({ name: 'ws-journalentry-read', arguments: { id } }),
      );
      expect(read.count).toBe(1);
      expect(read.journalEntries[0]?.body).toBe('shipped the JournalEntry API');

      // read by unknown id → 0.
      const miss = jsonOf<JournalEntryList>(
        await client.callTool({
          name: 'ws-journalentry-read',
          arguments: { id: '00000000-0000-0000-0000-000000000000' },
        }),
      );
      expect(miss.count).toBe(0);

      // list mode → contains it; query matches then excludes.
      const list = jsonOf<JournalEntryList>(
        await client.callTool({ name: 'ws-journalentry-read', arguments: {} }),
      );
      expect(list.count).toBe(1);
      const queried = jsonOf<JournalEntryList>(
        await client.callTool({ name: 'ws-journalentry-read', arguments: { query: 'shipped' } }),
      );
      expect(queried.count).toBe(1);
      const noMatch = jsonOf<JournalEntryList>(
        await client.callTool({ name: 'ws-journalentry-read', arguments: { query: 'zzz-nomatch' } }),
      );
      expect(noMatch.count).toBe(0);

      // update — change body + topics; unpatched workstream survives the merge.
      const updated = jsonOf<IJournalEntry>(
        await client.callTool({
          name: 'ws-journalentry-update',
          arguments: { id, body: 'shipped + tagged', topics: ['data-tier-mcp', 'seed-document-kinds'] },
        }),
      );
      expect(updated.body).toBe('shipped + tagged');
      expect(updated.topics).toEqual(['data-tier-mcp', 'seed-document-kinds']);
      expect(updated.workstream).toBe('data-tier-mcp');
      expect(updated.resourceVersion).toBe(2);

      // delete — drops out of ws-journalentry-read.
      const del = jsonOf<{ ok: boolean; id: string }>(
        await client.callTool({ name: 'ws-journalentry-delete', arguments: { id } }),
      );
      expect(del).toEqual({ ok: true, id });
      expect(
        jsonOf<JournalEntryList>(
          await client.callTool({ name: 'ws-journalentry-read', arguments: { id } }),
        ).count,
      ).toBe(0);

      // restore: true → back in ws-journalentry-read, spec intact (topics survived).
      const restored = jsonOf<{ ok: boolean; id: string }>(
        await client.callTool({ name: 'ws-journalentry-delete', arguments: { id, restore: true } }),
      );
      expect(restored).toEqual({ ok: true, id });
      const afterRestore = jsonOf<JournalEntryList>(
        await client.callTool({ name: 'ws-journalentry-read', arguments: { id } }),
      );
      expect(afterRestore.count).toBe(1);
      expect(afterRestore.journalEntries[0]?.topics).toEqual([
        'data-tier-mcp',
        'seed-document-kinds',
      ]);
    } finally {
      await close();
    }
  });

  it('ws-journalentry-update surfaces a CAS conflict when the stored version has advanced', async () => {
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
      const created = jsonOf<IJournalEntry>(
        await client.callTool({
          name: 'ws-journalentry-create',
          arguments: { body: 'Race', workstream: 'ws' },
        }),
      );
      const id = created.id;
      await client.callTool({ name: 'ws-journalentry-update', arguments: { id, body: 'Race v2' } });
      staleVersion = 1;
      const conflict = await client.callTool({
        name: 'ws-journalentry-update',
        arguments: { id, body: 'Race v3' },
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
      // Empty body passes the tool schema (z.string()) but fails the kind schema
      // (z.string().min(1)) → kind-validation rejection.
      const badCreate = await client.callTool({
        name: 'ws-journalentry-create',
        arguments: { body: '', workstream: 'ws' },
      });
      expect(isErrorResult(badCreate)).toBe(true);
      expect(textOf(badCreate)).toMatch(/body/i);
      expect(
        jsonOf<JournalEntryList>(
          await client.callTool({ name: 'ws-journalentry-read', arguments: {} }),
        ).count,
      ).toBe(0);

      // A valid create, then an empty-body update, is also rejected …
      const ok = jsonOf<IJournalEntry>(
        await client.callTool({
          name: 'ws-journalentry-create',
          arguments: { body: 'keep me', workstream: 'ws' },
        }),
      );
      const badUpdate = await client.callTool({
        name: 'ws-journalentry-update',
        arguments: { id: ok.id, body: '' },
      });
      expect(isErrorResult(badUpdate)).toBe(true);
      expect(textOf(badUpdate)).toMatch(/body/i);
      // … and leaves the entry unchanged.
      const still = jsonOf<JournalEntryList>(
        await client.callTool({ name: 'ws-journalentry-read', arguments: { id: ok.id } }),
      );
      expect(still.journalEntries[0]?.body).toBe('keep me');
    } finally {
      await close();
    }
  });

  it('errors clearly on unknown-id update, delete, and restore', async () => {
    const { client, close } = await connect(openStore(':memory:'));
    try {
      const badUpdate = await client.callTool({
        name: 'ws-journalentry-update',
        arguments: { id: 'ghost-id', body: 'X' },
      });
      expect(isErrorResult(badUpdate)).toBe(true);
      expect(textOf(badUpdate)).toMatch(/ghost-id/);

      const badDelete = await client.callTool({
        name: 'ws-journalentry-delete',
        arguments: { id: 'ghost-id' },
      });
      expect(isErrorResult(badDelete)).toBe(true);
      expect(textOf(badDelete)).toMatch(/ghost-id/);

      const badRestore = await client.callTool({
        name: 'ws-journalentry-delete',
        arguments: { id: 'ghost-id', restore: true },
      });
      expect(isErrorResult(badRestore)).toBe(true);
      expect(textOf(badRestore)).toMatch(/ghost-id/);
    } finally {
      await close();
    }
  });

  it('POCO: JSON.stringify(new JournalEntry(env)) is a stable projection of the document', () => {
    const env: DocumentEnvelope = {
      kind: 'JournalEntry',
      metadata: {
        id: '33333333-3333-3333-3333-333333333333',
        slug: null,
        labels: {},
        createdAt: 1000,
        updatedAt: 2000,
        deletedAt: null,
        resourceVersion: 5,
      },
      spec: {
        body: 'did a thing',
        workstream: 'data-tier-mcp',
        session: '3b218b7e-4ea8-4b0d-952b-dad24ec1a81d',
        topics: ['data-tier-mcp'],
        createdBy: 'working-memory-developer',
      },
      status: {},
    };
    expect(JSON.parse(JSON.stringify(new JournalEntry(env)))).toEqual({
      id: '33333333-3333-3333-3333-333333333333',
      slug: null,
      body: 'did a thing',
      workstream: 'data-tier-mcp',
      session: '3b218b7e-4ea8-4b0d-952b-dad24ec1a81d',
      topics: ['data-tier-mcp'],
      createdBy: 'working-memory-developer',
      created_at: 1000,
      updated_at: 2000,
      resourceVersion: 5,
    });
  });
});
