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
import alertModule from '../src/kinds/alert.kind';
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

describe('Alert kind registry', () => {
  beforeEach(() => {
    clearKinds();
    registerKind(alertModule.name, alertModule.descriptor);
  });

  it('registers Alert and lists it (case-sensitive)', () => {
    expect(listKinds()).toContain('Alert');
    expect(getKind('Alert')).toBeTruthy();
    expect(getKind('alert')).toBeUndefined();
  });

  it('parses a valid spec and applies defaults (title, recommended_action, status, created_by)', () => {
    const parsed = validateSpec('Alert', { description: 'Disk is nearly full.' });
    expect(parsed).toEqual({
      title: '',
      description: 'Disk is nearly full.',
      recommended_action: '',
      status: 'alert',
      created_by: 'system',
    });
  });

  it('accepts every status value from migration 016', () => {
    for (const status of ['alert', 'informational', 'closed'] as const) {
      expect(validateSpec('Alert', { description: 'D', status })).toEqual({
        title: '',
        description: 'D',
        recommended_action: '',
        status,
        created_by: 'system',
      });
    }
  });

  it('passes optional dedupe_key through when present', () => {
    const parsed = validateSpec('Alert', {
      title: 'Low disk',
      description: 'Disk is nearly full.',
      recommended_action: 'Free up space.',
      status: 'alert',
      dedupe_key: 'disk-space',
      created_by: 'monitor',
    });
    expect(parsed).toEqual({
      title: 'Low disk',
      description: 'Disk is nearly full.',
      recommended_action: 'Free up space.',
      status: 'alert',
      dedupe_key: 'disk-space',
      created_by: 'monitor',
    });
  });

  it('rejects a missing description', () => {
    expect(() => validateSpec('Alert', {})).toThrow(KindValidationError);
    expect(() => validateSpec('Alert', {})).toThrow(/description/);
  });

  it('rejects an empty description', () => {
    expect(() => validateSpec('Alert', { description: '' })).toThrow(KindValidationError);
  });

  it('rejects a bad status value', () => {
    expect(() => validateSpec('Alert', { description: 'D', status: 'open' })).toThrow(
      KindValidationError,
    );
  });

  it('rejects an unknown field (spec is strict)', () => {
    expect(() => validateSpec('Alert', { description: 'D', severity: 'high' })).toThrow(
      KindValidationError,
    );
  });

  it('inherits Base envelope status ({})', () => {
    expect(defaultStatus('Alert')).toEqual({});
  });
});

describe('Alert kind loader', () => {
  beforeEach(() => {
    clearKinds();
  });

  it('auto-discovers Alert from the kinds folder', async () => {
    const registered = await loadKinds();
    expect(registered).toContain('Alert');
    expect(getKind('Alert')).toBeTruthy();
  });
});

(sqliteAvailable ? describe : describe.skip)('Alert kind via MCP tools', () => {
  beforeAll(async () => {
    clearKinds();
    await loadKinds();
  });

  it('wm_list_kinds includes Alert with its spec fields', async () => {
    const store = openStore(':memory:');
    const server = await startServer({ port: 0, store });
    const client = new Client({ name: 'wm-cp-alert-1', version: '0.0.0' });
    const transport = new StreamableHTTPClientTransport(new URL(`${server.url}/mcp`));
    try {
      await client.connect(transport);
      const result = jsonOf<{ count: number; kinds: { name: string; specFields: string[] }[] }>(
        await client.callTool({ name: 'wm_list_kinds', arguments: {} }),
      );
      const alertKind = result.kinds.find((k) => k.name === 'Alert');
      expect(alertKind).toBeDefined();
      expect(alertKind?.specFields).toEqual(
        expect.arrayContaining([
          'title',
          'description',
          'recommended_action',
          'status',
          'dedupe_key',
          'created_by',
        ]),
      );
    } finally {
      await client.close();
      await server.close();
      store.close();
    }
  });

  it('creates an Alert document with just a description (defaults applied)', async () => {
    const store = openStore(':memory:');
    const server = await startServer({ port: 0, store });
    const client = new Client({ name: 'wm-cp-alert-2', version: '0.0.0' });
    const transport = new StreamableHTTPClientTransport(new URL(`${server.url}/mcp`));
    try {
      await client.connect(transport);
      const created = jsonOf<Envelope>(
        await client.callTool({
          name: 'wm_create_document',
          arguments: {
            kind: 'Alert',
            slug: 'disk-space',
            spec: { description: 'Disk is nearly full.' },
          },
        }),
      );
      expect(created.kind).toBe('Alert');
      expect(created.spec).toEqual({
        title: '',
        description: 'Disk is nearly full.',
        recommended_action: '',
        status: 'alert',
        created_by: 'system',
      });
      expect(created.status).toEqual({});

      const list = jsonOf<{ count: number; documents: Envelope[] }>(
        await client.callTool({ name: 'wm_list_documents', arguments: { kind: 'Alert' } }),
      );
      expect(list.count).toBe(1);
    } finally {
      await client.close();
      await server.close();
      store.close();
    }
  });

  it('rejects an invalid Alert spec (bad status) and does NOT persist', async () => {
    const store = openStore(':memory:');
    const server = await startServer({ port: 0, store });
    const client = new Client({ name: 'wm-cp-alert-3', version: '0.0.0' });
    const transport = new StreamableHTTPClientTransport(new URL(`${server.url}/mcp`));
    try {
      await client.connect(transport);
      const res = await client.callTool({
        name: 'wm_create_document',
        arguments: { kind: 'Alert', slug: 'bad', spec: { description: 'D', status: 'open' } },
      });
      expect((res as { isError?: boolean }).isError).toBe(true);
      expect(store.listDocuments({ kind: 'Alert' })).toEqual([]);
    } finally {
      await client.close();
      await server.close();
      store.close();
    }
  });
});
