import { describe, it, expect } from 'vitest';
import { startServer } from '../src/server';
import { openStore } from '../src/store';
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

(sqliteAvailable ? describe : describe.skip)('control-plane document tools', () => {
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
          arguments: { kind: 'topic', slug: 'demo', spec: { title: 'Demo' } },
        }),
      );
      expect(created.kind).toBe('topic');
      expect(created.metadata.id).toMatch(/^[0-9a-f-]{36}$/);
      expect(created.metadata.resourceVersion).toBe(1);
      expect(created.spec).toEqual({ title: 'Demo' });

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

  it('increments the version and honors the kind filter across tool calls', async () => {
    const store = openStore(':memory:');
    const server = await startServer({ port: 0, store });
    const client = new Client({ name: 'wm-cp-doc-test-2', version: '0.0.0' });
    const transport = new StreamableHTTPClientTransport(new URL(`${server.url}/mcp`));
    try {
      await client.connect(transport);

      await client.callTool({ name: 'wm_create_document', arguments: { kind: 'topic', slug: 'a' } });
      await client.callTool({ name: 'wm_create_document', arguments: { kind: 'note', slug: 'b' } });
      const c = jsonOf<Envelope>(
        await client.callTool({ name: 'wm_create_document', arguments: { kind: 'topic', slug: 'c' } }),
      );
      expect(c.metadata.resourceVersion).toBe(3);

      const topics = jsonOf<{ count: number; documents: Envelope[] }>(
        await client.callTool({ name: 'wm_list_documents', arguments: { kind: 'topic' } }),
      );
      expect(topics.count).toBe(2);
      expect(topics.documents.map((d) => d.metadata.slug)).toEqual(['c', 'a']);
    } finally {
      await client.close();
      await server.close();
      store.close();
    }
  });
});
