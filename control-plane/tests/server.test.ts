import { fetch as authenticatedFetch } from '../../tests/authenticatedFixture';
import { describe, it, expect } from 'vitest';
import { startServer } from '../../tests/authenticatedFixture';
import { SERVICE_VERSION } from '../src/config';
import { Client } from '@modelcontextprotocol/client';
import { StreamableHTTPClientTransport } from '../../tests/authenticatedFixture';
import { openStore } from '../src/store';

interface HealthBody {
  ok: boolean;
  version: string;
  uptime: number;
}

interface TextContent {
  type: string;
  text?: string;
}

describe('control-plane server bootstrap', () => {
  it('binds 127.0.0.1 on an ephemeral port and answers GET /health', async () => {
    const server = await startServer({ port: 0 });
    try {
      expect(server.host).toBe('127.0.0.1');
      expect(server.port).toBeGreaterThan(0);

      const res = await authenticatedFetch(`${server.url}/health`);
      expect(res.status).toBe(200);
      const body = (await res.json()) as HealthBody;
      expect(body.ok).toBe(true);
      expect(body.version).toBe(SERVICE_VERSION);
      expect(typeof body.uptime).toBe('number');
      expect(body.uptime).toBeGreaterThanOrEqual(0);
    } finally {
      await server.close();
    }
  });

  it('returns 404 for unknown routes', async () => {
    const server = await startServer({ port: 0 });
    try {
      const res = await authenticatedFetch(`${server.url}/definitely-not-a-route`);
      expect(res.status).toBe(404);
    } finally {
      await server.close();
    }
  });

  it('stores and serves image attachments from SQLite', async () => {
    const server = await startServer({ port: 0 });
    try {
      const upload = await authenticatedFetch(`${server.url}/attachments`, {
        method: 'POST',
        headers: {
          'content-type': 'image/png',
          'x-file-name': encodeURIComponent('pasted image.png'),
        },
        body: Buffer.from('png-bytes'),
      });
      expect(upload.status).toBe(201);
      const created = await upload.json() as { id: string; filename: string };
      expect(created.filename).toBe('pasted image.png');

      const downloaded = await authenticatedFetch(`${server.url}/attachments/${created.id}`);
      expect(downloaded.status).toBe(200);
      expect(downloaded.headers.get('content-type')).toBe('image/png');
      expect(Buffer.from(await downloaded.arrayBuffer()).toString()).toBe('png-bytes');
    } finally {
      await server.close();
    }
  });

  it('rejects unsupported attachment types', async () => {
    const server = await startServer({ port: 0 });
    try {
      const upload = await authenticatedFetch(`${server.url}/attachments`, {
        method: 'POST',
        headers: { 'content-type': 'text/html' },
        body: '<script>alert(1)</script>',
      });
      expect(upload.status).toBe(415);
    } finally {
      await server.close();
    }
  });

  it('completes an MCP initialize handshake and answers wm-ping', async () => {
    const server = await startServer({ port: 0 });
    const client = new Client({ name: 'wm-cp-test-client', version: '0.0.0' });
    const transport = new StreamableHTTPClientTransport(new URL(`${server.url}/mcp`));
    try {
      // connect() performs the initialize handshake.
      await client.connect(transport);

      const listed = await client.listTools();
      expect(listed.tools.map((t) => t.name)).toContain('wm-ping');

      const result = await client.callTool({ name: 'wm-ping', arguments: {} });
      const content = result.content as TextContent[];
      const text = content.find((c) => c.type === 'text')?.text ?? '';
      const payload = JSON.parse(text) as { ok: boolean; version: string };
      expect(payload.ok).toBe(true);
      expect(payload.version).toBe(SERVICE_VERSION);
    } finally {
      await client.close();
      await server.close();
    }
  });

  it('supports two concurrent MCP clients (independent sessions)', async () => {
    const server = await startServer({ port: 0 });
    const makeClient = async () => {
      const client = new Client({ name: 'wm-cp-test-client', version: '0.0.0' });
      const transport = new StreamableHTTPClientTransport(new URL(`${server.url}/mcp`));
      await client.connect(transport);
      return client;
    };
    const a = await makeClient();
    const b = await makeClient();
    try {
      const [ra, rb] = await Promise.all([
        a.callTool({ name: 'wm-ping', arguments: {} }),
        b.callTool({ name: 'wm-ping', arguments: {} }),
      ]);
      for (const r of [ra, rb]) {
        const text = (r.content as TextContent[]).find((c) => c.type === 'text')?.text ?? '';
        expect((JSON.parse(text) as { ok: boolean }).ok).toBe(true);
      }
    } finally {
      await a.close();
      await b.close();
      await server.close();
    }
  });

  it('uses the live ordered index for MCP kind pages without changing timestamp ties or deleted reads', async () => {
    const store = openStore(':memory:');
    const first = store.createDocument({ kind: 'Topic', spec: { title: 'First' } });
    store.createDocument({ kind: 'Workstream', spec: { title: 'Other kind' } });
    const second = store.createDocument({ kind: 'Topic', spec: { title: 'Second' } });
    const deleted = store.createDocument({ kind: 'Topic', spec: { title: 'Deleted' } });
    const last = store.createDocument({ kind: 'Topic', spec: { title: 'Last' } });
    store.deleteDocument({ id: deleted.metadata.id });
    store.db.prepare('UPDATE resources SET updated_at = 100').run();
    const server = await startServer({ port: 0, store });
    const client = new Client({ name: 'wm-ordered-page-test', version: '1' });
    const transport = new StreamableHTTPClientTransport(new URL(`${server.url}/mcp`));
    try {
      const plan = store.db.prepare(`EXPLAIN QUERY PLAN SELECT * FROM resources
        WHERE deleted_at IS NULL AND kind = ? ORDER BY updated_at DESC, rowid DESC LIMIT ? OFFSET ?`)
        .all('Topic', 2, 1).map(row => String(row.detail)).join('\n');
      expect(plan).toContain('idx_resources_live_kind_updated');
      expect(plan).not.toContain('TEMP B-TREE');
      await client.connect(transport);
      const read = async (args: Record<string, unknown>) => {
        const result = await client.callTool({ name: 'wm-document-read', arguments: { kind: 'Topic', ...args } });
        expect(result.isError).not.toBe(true);
        const text = (result.content as TextContent[]).find(value => value.type === 'text')?.text ?? '';
        return (JSON.parse(text).documents as Array<{ metadata: { id: string } }>).map(doc => doc.metadata.id);
      };
      expect(await read({ limit: 2 })).toEqual([last.metadata.id, second.metadata.id]);
      expect(await read({ limit: 2, offset: 1 })).toEqual([second.metadata.id, first.metadata.id]);
      expect(await read({ includeDeleted: true, limit: 3 })).toEqual([last.metadata.id, deleted.metadata.id, second.metadata.id]);
      store.db.prepare('UPDATE resources SET updated_at = 200 WHERE id = ?').run(first.metadata.id);
      expect(await read({ limit: 2 })).toEqual([first.metadata.id, last.metadata.id]);
    } finally {
      await client.close();
      await server.close();
      store.close();
    }
  });
});
