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

/** True when an MCP tool result is flagged as an error. */
function isErrorResult(res: unknown): boolean {
  return (res as { isError?: boolean }).isError === true;
}

interface Envelope {
  kind: string;
  metadata: { id: string; slug: string | null; resourceVersion: number; deletedAt: number | null };
  spec: Record<string, unknown>;
}

(sqliteAvailable ? describe : describe.skip)('control-plane delete/restore tools', () => {
  beforeAll(async () => {
    clearKinds();
    await loadKinds();
  });

  it('exposes wm_delete_document but not wm_restore_document', async () => {
    const store = openStore(':memory:');
    const server = await startServer({ port: 0, store });
    const client = new Client({ name: 'wm-cp-del-names', version: '0.0.0' });
    const transport = new StreamableHTTPClientTransport(new URL(`${server.url}/mcp`));
    try {
      await client.connect(transport);
      const names = (await client.listTools()).tools.map((t) => t.name);
      expect(names).toContain('wm_delete_document');
      expect(names).not.toContain('wm_restore_document');
    } finally {
      await client.close();
      await server.close();
      store.close();
    }
  });

  it('deletes a Topic by id → gone from wm_list_documents, then restores it', async () => {
    const store = openStore(':memory:');
    const server = await startServer({ port: 0, store });
    const client = new Client({ name: 'wm-cp-del-roundtrip', version: '0.0.0' });
    const transport = new StreamableHTTPClientTransport(new URL(`${server.url}/mcp`));
    try {
      await client.connect(transport);

      const created = jsonOf<Envelope>(
        await client.callTool({
          name: 'wm_create_document',
          arguments: { kind: 'Topic', slug: 'to-delete', spec: { title: 'Delete me' } },
        }),
      );

      const deleted = jsonOf<Envelope>(
        await client.callTool({
          name: 'wm_delete_document',
          arguments: { id: created.metadata.id },
        }),
      );
      expect(deleted.metadata.deletedAt).not.toBeNull();

      const afterDelete = jsonOf<{ count: number; documents: Envelope[] }>(
        await client.callTool({ name: 'wm_list_documents', arguments: {} }),
      );
      expect(afterDelete.count).toBe(0);

      // Restore brings it back via the same tool with restore: true.
      const restored = jsonOf<Envelope>(
        await client.callTool({
          name: 'wm_delete_document',
          arguments: { id: created.metadata.id, restore: true },
        }),
      );
      expect(restored.metadata.deletedAt).toBeNull();

      const afterRestore = jsonOf<{ count: number; documents: Envelope[] }>(
        await client.callTool({ name: 'wm_list_documents', arguments: {} }),
      );
      expect(afterRestore.count).toBe(1);
      expect(afterRestore.documents[0]?.metadata.slug).toBe('to-delete');
    } finally {
      await client.close();
      await server.close();
      store.close();
    }
  });

  it('deletes a legacy lowercase-`topic` (unregistered kind) doc via the tool', async () => {
    const store = openStore(':memory:');
    const server = await startServer({ port: 0, store });
    const client = new Client({ name: 'wm-cp-del-legacy', version: '0.0.0' });
    const transport = new StreamableHTTPClientTransport(new URL(`${server.url}/mcp`));
    try {
      await client.connect(transport);

      // Seed a junk doc directly through the injected store: unregistered kind,
      // hallucinated fields — the sort of thing wm_create_document would reject.
      const junk = store.createDocument({
        kind: 'topic',
        slug: 'legacy-junk',
        spec: { hallucinated: 'field' },
      });

      const deleted = jsonOf<Envelope>(
        await client.callTool({
          name: 'wm_delete_document',
          arguments: { id: junk.metadata.id },
        }),
      );
      expect(deleted.kind).toBe('topic');
      expect(deleted.metadata.deletedAt).not.toBeNull();
      expect(store.getDocument({ id: junk.metadata.id })).toBeNull();
    } finally {
      await client.close();
      await server.close();
      store.close();
    }
  });

  it('errors on delete of an unknown id and restore of an unknown id', async () => {
    const store = openStore(':memory:');
    const server = await startServer({ port: 0, store });
    const client = new Client({ name: 'wm-cp-del-errors', version: '0.0.0' });
    const transport = new StreamableHTTPClientTransport(new URL(`${server.url}/mcp`));
    try {
      await client.connect(transport);

      const delMiss = await client.callTool({
        name: 'wm_delete_document',
        arguments: { id: 'nope-not-real' },
      });
      expect(isErrorResult(delMiss)).toBe(true);

      const restoreMiss = await client.callTool({
        name: 'wm_delete_document',
        arguments: { id: 'nope-not-real', restore: true },
      });
      expect(isErrorResult(restoreMiss)).toBe(true);
    } finally {
      await client.close();
      await server.close();
      store.close();
    }
  });
});
