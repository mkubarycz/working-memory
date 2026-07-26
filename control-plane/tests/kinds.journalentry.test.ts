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
import entryModule from '../src/kinds/journalentry.kind';
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

describe('JournalEntry kind registry', () => {
  beforeEach(() => {
    clearKinds();
    registerKind(entryModule.name, entryModule.descriptor);
  });

  it('registers JournalEntry and lists it (case-sensitive)', () => {
    expect(listKinds()).toContain('JournalEntry');
    expect(getKind('JournalEntry')).toBeTruthy();
    expect(getKind('journalentry')).toBeUndefined();
  });

  it('parses a valid spec and applies defaults (topics [], createdBy system)', () => {
    const parsed = validateSpec('JournalEntry', { body: 'did a thing', workstream: 'seed-document-kinds' });
    expect(parsed).toEqual({
      body: 'did a thing',
      workstream: 'seed-document-kinds',
      topics: [],
      createdBy: 'system',
    });
  });

  it('keeps session optional and passes it through when present', () => {
    const parsed = validateSpec('JournalEntry', {
      body: 'grouped entry',
      workstream: 'ws',
      session: '3b218b7e-4ea8-4b0d-952b-dad24ec1a81d',
    });
    expect(parsed).toMatchObject({ session: '3b218b7e-4ea8-4b0d-952b-dad24ec1a81d' });
  });

  it('accepts a topics array of slugs', () => {
    const parsed = validateSpec('JournalEntry', {
      body: 'tagged entry',
      workstream: 'ws',
      topics: ['seed-document-kinds', 'data-tier-mcp'],
    });
    expect(parsed).toMatchObject({ topics: ['seed-document-kinds', 'data-tier-mcp'] });
  });

  it('passes createdBy through when present', () => {
    const parsed = validateSpec('JournalEntry', {
      body: 'authored',
      workstream: 'ws',
      createdBy: 'working-memory-developer',
    });
    expect(parsed).toMatchObject({ createdBy: 'working-memory-developer' });
  });

  it('rejects a missing body', () => {
    expect(() => validateSpec('JournalEntry', { workstream: 'ws' })).toThrow(KindValidationError);
    expect(() => validateSpec('JournalEntry', { workstream: 'ws' })).toThrow(/body/);
  });

  it('rejects an empty body', () => {
    expect(() => validateSpec('JournalEntry', { body: '', workstream: 'ws' })).toThrow(
      KindValidationError,
    );
  });

  it('rejects a missing workstream', () => {
    expect(() => validateSpec('JournalEntry', { body: 'x' })).toThrow(KindValidationError);
    expect(() => validateSpec('JournalEntry', { body: 'x' })).toThrow(/workstream/);
  });

  it('rejects an empty workstream', () => {
    expect(() => validateSpec('JournalEntry', { body: 'x', workstream: '' })).toThrow(
      KindValidationError,
    );
  });

  it('rejects an unknown field (spec is strict)', () => {
    expect(() => validateSpec('JournalEntry', { body: 'x', workstream: 'ws', edge: 'nope' })).toThrow(
      KindValidationError,
    );
  });

  it('inherits Base envelope status ({})', () => {
    expect(defaultStatus('JournalEntry')).toEqual({});
  });
});

describe('JournalEntry kind loader', () => {
  beforeEach(() => {
    clearKinds();
  });

  it('auto-discovers JournalEntry (alongside the other kinds) from the kinds folder', async () => {
    const registered = await loadKinds();
    expect(registered).toContain('JournalEntry');
    expect(getKind('JournalEntry')).toBeTruthy();
  });
});

(sqliteAvailable ? describe : describe.skip)('JournalEntry kind via MCP tools', () => {
  beforeAll(async () => {
    clearKinds();
    await loadKinds();
  });

  it('wm_list_kinds includes all five kinds (JournalEntry alongside Topic/Workstream/TopicType/Alert)', async () => {
    const store = openStore(':memory:');
    const server = await startServer({ port: 0, store });
    const client = new Client({ name: 'wm-cp-entry-1', version: '0.0.0' });
    const transport = new StreamableHTTPClientTransport(new URL(`${server.url}/mcp`));
    try {
      await client.connect(transport);
      const result = jsonOf<{ count: number; kinds: { name: string; specFields: string[] }[] }>(
        await client.callTool({ name: 'wm_list_kinds', arguments: {} }),
      );
      const names = result.kinds.map((k) => k.name);
      expect(names).toEqual(
        expect.arrayContaining(['JournalEntry', 'Topic', 'Workstream', 'TopicType', 'Alert']),
      );
      const entry = result.kinds.find((k) => k.name === 'JournalEntry');
      expect(entry?.specFields).toEqual(
        expect.arrayContaining(['body', 'workstream', 'session', 'topics', 'createdBy']),
      );
    } finally {
      await client.close();
      await server.close();
      store.close();
    }
  });

  it('creates an JournalEntry with body + workstream (defaults applied) and persists', async () => {
    const store = openStore(':memory:');
    const server = await startServer({ port: 0, store });
    const client = new Client({ name: 'wm-cp-entry-2', version: '0.0.0' });
    const transport = new StreamableHTTPClientTransport(new URL(`${server.url}/mcp`));
    try {
      await client.connect(transport);
      const created = jsonOf<Envelope>(
        await client.callTool({
          name: 'wm_create_document',
          arguments: { kind: 'JournalEntry', spec: { body: 'shipped the JournalEntry kind', workstream: 'ws' } },
        }),
      );
      expect(created.kind).toBe('JournalEntry');
      expect(created.spec).toEqual({
        body: 'shipped the JournalEntry kind',
        workstream: 'ws',
        topics: [],
        createdBy: 'system',
      });
      expect(created.status).toEqual({});

      const list = jsonOf<{ count: number; documents: Envelope[] }>(
        await client.callTool({ name: 'wm_list_documents', arguments: { kind: 'JournalEntry' } }),
      );
      expect(list.count).toBe(1);
      expect(list.documents[0]?.spec.body).toBe('shipped the JournalEntry kind');
    } finally {
      await client.close();
      await server.close();
      store.close();
    }
  });

  it('rejects an invalid JournalEntry spec (missing body) and does NOT persist', async () => {
    const store = openStore(':memory:');
    const server = await startServer({ port: 0, store });
    const client = new Client({ name: 'wm-cp-entry-3', version: '0.0.0' });
    const transport = new StreamableHTTPClientTransport(new URL(`${server.url}/mcp`));
    try {
      await client.connect(transport);
      const res = await client.callTool({
        name: 'wm_create_document',
        arguments: { kind: 'JournalEntry', spec: { workstream: 'ws' } },
      });
      expect((res as { isError?: boolean }).isError).toBe(true);
      expect(textOf(res)).toMatch(/body/i);
      expect(store.listDocuments({ kind: 'JournalEntry' })).toEqual([]);
    } finally {
      await client.close();
      await server.close();
      store.close();
    }
  });
});
