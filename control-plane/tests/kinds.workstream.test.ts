import { describe, it, expect, beforeEach, beforeAll } from 'vitest';
import {
  registerKind,
  getKind,
  listKinds,
  clearKinds,
  validateSpec,
  defaultStatus,
  KindValidationError,
} from '../src/kinds/registry';
import { loadKinds } from '../src/kinds/loader';
import workstreamModule from '../src/kinds/workstream';
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

function textOf(res: unknown): string {
  const content = (res as { content: TextContent[] }).content;
  return content.find((c) => c.type === 'text')?.text ?? '';
}

function jsonOf<T>(res: unknown): T {
  return JSON.parse(textOf(res)) as T;
}

interface Envelope {
  kind: string;
  metadata: { id: string; slug: string | null; resourceVersion: number };
  spec: Record<string, unknown>;
  status: Record<string, unknown>;
}

describe('Workstream kind registry', () => {
  beforeEach(() => {
    clearKinds();
    registerKind(workstreamModule.name, workstreamModule.descriptor);
  });

  it('registers Workstream and lists it (case-sensitive)', () => {
    expect(listKinds()).toContain('Workstream');
    expect(getKind('Workstream')).toBeTruthy();
    expect(getKind('workstream')).toBeUndefined();
  });

  it('parses a valid spec and applies the status default (progress)', () => {
    const parsed = validateSpec('Workstream', { title: 'Ship control plane' });
    expect(parsed).toEqual({ title: 'Ship control plane', status: 'progress' });
  });

  it('accepts every lifecycle status value from migration 014', () => {
    for (const status of ['queue', 'progress', 'backlog', 'closed'] as const) {
      expect(validateSpec('Workstream', { title: 'T', status })).toEqual({ title: 'T', status });
    }
  });

  it('keeps closure optional and passes it through when present', () => {
    expect(validateSpec('Workstream', { title: 'T', status: 'closed', closure: 'done' })).toEqual({
      title: 'T',
      status: 'closed',
      closure: 'done',
    });
  });

  it('rejects a missing title', () => {
    expect(() => validateSpec('Workstream', {})).toThrow(KindValidationError);
    expect(() => validateSpec('Workstream', {})).toThrow(/title/);
  });

  it('rejects an empty title', () => {
    expect(() => validateSpec('Workstream', { title: '' })).toThrow(KindValidationError);
  });

  it('rejects a bad status value', () => {
    expect(() => validateSpec('Workstream', { title: 'T', status: 'open' })).toThrow(
      KindValidationError,
    );
  });

  it('rejects an unknown field (spec is strict)', () => {
    expect(() => validateSpec('Workstream', { title: 'T', body: 'nope' })).toThrow(
      KindValidationError,
    );
  });

  it('inherits Base envelope status ({})', () => {
    expect(defaultStatus('Workstream')).toEqual({});
  });
});

describe('Workstream kind loader', () => {
  beforeEach(() => {
    clearKinds();
  });

  it('auto-discovers Workstream (alongside Topic) from the kinds folder', async () => {
    const registered = await loadKinds();
    expect(registered).toContain('Workstream');
    expect(registered).toContain('Topic');
    expect(getKind('Workstream')).toBeTruthy();
  });
});

(sqliteAvailable ? describe : describe.skip)('Workstream kind via MCP tools', () => {
  beforeAll(async () => {
    clearKinds();
    await loadKinds();
  });

  it('wm-list-kinds includes Workstream and Topic', async () => {
    const store = openStore(':memory:');
    const server = await startServer({ port: 0, store });
    const client = new Client({ name: 'wm-cp-ws-1', version: '0.0.0' });
    const transport = new StreamableHTTPClientTransport(new URL(`${server.url}/mcp`));
    try {
      await client.connect(transport);
      const result = jsonOf<{ count: number; kinds: { name: string; specFields: string[] }[] }>(
        await client.callTool({ name: 'wm-list-kinds', arguments: {} }),
      );
      const names = result.kinds.map((k) => k.name);
      expect(names).toContain('Workstream');
      expect(names).toContain('Topic');
      const ws = result.kinds.find((k) => k.name === 'Workstream');
      expect(ws?.specFields).toEqual(expect.arrayContaining(['title', 'status', 'closure']));
    } finally {
      await client.close();
      await server.close();
      store.close();
    }
  });

  it('creates a Workstream document with just a title (status defaults)', async () => {
    const store = openStore(':memory:');
    const server = await startServer({ port: 0, store });
    const client = new Client({ name: 'wm-cp-ws-2', version: '0.0.0' });
    const transport = new StreamableHTTPClientTransport(new URL(`${server.url}/mcp`));
    try {
      await client.connect(transport);
      const created = jsonOf<Envelope>(
        await client.callTool({
          name: 'wm-document-create',
          arguments: { kind: 'Workstream', slug: 'cp', spec: { title: 'Control Plane' } },
        }),
      );
      expect(created.kind).toBe('Workstream');
      expect(created.spec).toEqual({ title: 'Control Plane', status: 'progress' });
      expect(created.status).toEqual({});

      const list = jsonOf<{ count: number; documents: Envelope[] }>(
        await client.callTool({ name: 'wm-document-read', arguments: { kind: 'Workstream' } }),
      );
      expect(list.count).toBe(1);
      expect(list.documents[0]?.metadata.slug).toBe('cp');
    } finally {
      await client.close();
      await server.close();
      store.close();
    }
  });

  it('rejects an invalid Workstream spec (bad status) and does NOT persist', async () => {
    const store = openStore(':memory:');
    const server = await startServer({ port: 0, store });
    const client = new Client({ name: 'wm-cp-ws-3', version: '0.0.0' });
    const transport = new StreamableHTTPClientTransport(new URL(`${server.url}/mcp`));
    try {
      await client.connect(transport);
      const res = await client.callTool({
        name: 'wm-document-create',
        arguments: { kind: 'Workstream', slug: 'bad', spec: { title: 'T', status: 'open' } },
      });
      expect((res as { isError?: boolean }).isError).toBe(true);
      expect(store.listDocuments({ kind: 'Workstream' })).toEqual([]);
    } finally {
      await client.close();
      await server.close();
      store.close();
    }
  });
});
