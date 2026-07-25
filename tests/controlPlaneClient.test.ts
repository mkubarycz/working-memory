import { describe, it, expect, afterEach } from 'vitest';
import { startServer, type RunningServer } from '../control-plane/src/server';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import {
  ControlPlaneClient,
  type DocumentEnvelope,
} from '../src/controlPlaneClient';

/**
 * The Blackboard tab reads documents through the SAME MCP surface an agent
 * uses. These tests stand up an ephemeral in-process control-plane server
 * (port 0, `:memory:` store), seed a document via the real `wm_create_document`
 * tool, then assert `ControlPlaneClient` round-trips it back through the actual
 * MCP client + Streamable-HTTP transport.
 */

/** Seed a document by calling `wm_create_document` over a throwaway MCP client. */
async function seedDocument(
  url: string,
  args: Record<string, unknown>,
): Promise<DocumentEnvelope> {
  const client = new Client({ name: 'seed-client', version: '0.0.0' });
  const transport = new StreamableHTTPClientTransport(new URL(url));
  try {
    await client.connect(transport);
    const result = await client.callTool({
      name: 'wm_create_document',
      arguments: args,
    });
    const content = result.content as Array<{ type: string; text?: string }>;
    const text = content.find((c) => c.type === 'text')?.text ?? '';
    return JSON.parse(text) as DocumentEnvelope;
  } finally {
    await client.close();
  }
}

describe('ControlPlaneClient (Blackboard MCP path)', () => {
  let server: RunningServer | null = null;

  afterEach(async () => {
    await server?.close();
    server = null;
  });

  it('round-trips list + get through the real MCP client/transport', async () => {
    server = await startServer({ port: 0 });
    const mcpUrl = `${server.url}/mcp`;
    const created = await seedDocument(mcpUrl, {
      kind: 'topic',
      slug: 'hello-blackboard',
      spec: { title: 'Hello Blackboard' },
    });

    const client = new ControlPlaneClient({ resolveUrl: () => mcpUrl });
    try {
      const list = await client.listDocuments();
      expect(list.available).toBe(true);
      expect(list.documents.map((d) => d.metadata.id)).toContain(
        created.metadata.id,
      );

      const one = await client.getDocument({ id: created.metadata.id });
      expect(one.available).toBe(true);
      expect(one.document?.metadata.id).toBe(created.metadata.id);
      expect(one.document?.kind).toBe('topic');
      expect(one.document?.metadata.slug).toBe('hello-blackboard');
      expect(one.document?.spec).toEqual({ title: 'Hello Blackboard' });
    } finally {
      await client.dispose();
    }
  });

  it('filters list by kind', async () => {
    server = await startServer({ port: 0 });
    const mcpUrl = `${server.url}/mcp`;
    await seedDocument(mcpUrl, { kind: 'topic', slug: 't1' });
    await seedDocument(mcpUrl, { kind: 'note', slug: 'n1' });

    const client = new ControlPlaneClient({ resolveUrl: () => mcpUrl });
    try {
      const notes = await client.listDocuments('note');
      expect(notes.available).toBe(true);
      expect(notes.documents.map((d) => d.kind)).toEqual(['note']);
    } finally {
      await client.dispose();
    }
  });

  it('reports unavailable when no daemon is reachable', async () => {
    const client = new ControlPlaneClient({ resolveUrl: () => null });
    const list = await client.listDocuments();
    expect(list.available).toBe(false);
    expect(list.documents).toEqual([]);
    expect(list.error).toBeTruthy();

    const one = await client.getDocument({ id: 'x' });
    expect(one.available).toBe(false);
    expect(one.document).toBeNull();
    await client.dispose();
  });

  it('returns an available result with a null document for an unknown id', async () => {
    server = await startServer({ port: 0 });
    const mcpUrl = `${server.url}/mcp`;
    const client = new ControlPlaneClient({ resolveUrl: () => mcpUrl });
    try {
      const one = await client.getDocument({ id: 'no-such-id' });
      expect(one.available).toBe(true);
      expect(one.document).toBeNull();
    } finally {
      await client.dispose();
    }
  });
});
