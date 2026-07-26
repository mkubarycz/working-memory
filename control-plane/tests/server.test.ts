import { describe, it, expect } from 'vitest';
import { startServer } from '../src/server';
import { SERVICE_VERSION } from '../src/config';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

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

      const res = await fetch(`${server.url}/health`);
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
      const res = await fetch(`${server.url}/definitely-not-a-route`);
      expect(res.status).toBe(404);
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
});
