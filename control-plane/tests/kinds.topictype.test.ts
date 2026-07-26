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
import topicTypeModule from '../src/kinds/topictype.kind';
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

describe('TopicType kind registry', () => {
  beforeEach(() => {
    clearKinds();
    registerKind(topicTypeModule.name, topicTypeModule.descriptor);
  });

  it('registers TopicType and lists it (case-sensitive)', () => {
    expect(listKinds()).toContain('TopicType');
    expect(getKind('TopicType')).toBeTruthy();
    expect(getKind('topictype')).toBeUndefined();
  });

  it('parses a valid spec and applies the body_template default', () => {
    const parsed = validateSpec('TopicType', {
      label: 'Feature',
      icon: 'rocket',
      description: 'A user-visible capability to design, build, and ship.',
    });
    expect(parsed).toEqual({
      label: 'Feature',
      icon: 'rocket',
      description: 'A user-visible capability to design, build, and ship.',
      body_template: '',
    });
  });

  it('passes body_template through when present', () => {
    expect(
      validateSpec('TopicType', {
        label: 'Feature',
        icon: 'rocket',
        description: 'Ships things.',
        body_template: '## Problem\n\n## Proposal\n',
      }),
    ).toEqual({
      label: 'Feature',
      icon: 'rocket',
      description: 'Ships things.',
      body_template: '## Problem\n\n## Proposal\n',
    });
  });

  it('rejects a missing label', () => {
    expect(() =>
      validateSpec('TopicType', { icon: 'rocket', description: 'x' }),
    ).toThrow(KindValidationError);
    expect(() =>
      validateSpec('TopicType', { icon: 'rocket', description: 'x' }),
    ).toThrow(/label/);
  });

  it('rejects a missing icon', () => {
    expect(() =>
      validateSpec('TopicType', { label: 'L', description: 'x' }),
    ).toThrow(KindValidationError);
  });

  it('rejects a missing description', () => {
    expect(() => validateSpec('TopicType', { label: 'L', icon: 'rocket' })).toThrow(
      KindValidationError,
    );
  });

  it('rejects empty required strings', () => {
    expect(() =>
      validateSpec('TopicType', { label: '', icon: 'rocket', description: 'x' }),
    ).toThrow(KindValidationError);
  });

  it('rejects an unknown field (spec is strict)', () => {
    expect(() =>
      validateSpec('TopicType', { label: 'L', icon: 'i', description: 'x', bogus: 1 }),
    ).toThrow(KindValidationError);
  });

  it('inherits Base envelope status ({})', () => {
    expect(defaultStatus('TopicType')).toEqual({});
  });
});

describe('TopicType kind loader', () => {
  beforeEach(() => {
    clearKinds();
  });

  it('auto-discovers TopicType from the kinds folder', async () => {
    const registered = await loadKinds();
    expect(registered).toContain('TopicType');
    expect(getKind('TopicType')).toBeTruthy();
  });
});

(sqliteAvailable ? describe : describe.skip)('TopicType kind via MCP tools', () => {
  beforeAll(async () => {
    clearKinds();
    await loadKinds();
  });

  it('wm-list-kinds includes TopicType with its spec fields', async () => {
    const store = openStore(':memory:');
    const server = await startServer({ port: 0, store });
    const client = new Client({ name: 'wm-cp-tt-1', version: '0.0.0' });
    const transport = new StreamableHTTPClientTransport(new URL(`${server.url}/mcp`));
    try {
      await client.connect(transport);
      const result = jsonOf<{ count: number; kinds: { name: string; specFields: string[] }[] }>(
        await client.callTool({ name: 'wm-list-kinds', arguments: {} }),
      );
      const tt = result.kinds.find((k) => k.name === 'TopicType');
      expect(tt).toBeDefined();
      expect(tt?.specFields).toEqual(
        expect.arrayContaining(['label', 'icon', 'description', 'body_template']),
      );
    } finally {
      await client.close();
      await server.close();
      store.close();
    }
  });

  it('creates a TopicType document (body_template defaults to "")', async () => {
    const store = openStore(':memory:');
    const server = await startServer({ port: 0, store });
    const client = new Client({ name: 'wm-cp-tt-2', version: '0.0.0' });
    const transport = new StreamableHTTPClientTransport(new URL(`${server.url}/mcp`));
    try {
      await client.connect(transport);
      const created = jsonOf<Envelope>(
        await client.callTool({
          name: 'wm-document-create',
          arguments: {
            kind: 'TopicType',
            slug: 'feature',
            spec: { label: 'Feature', icon: 'rocket', description: 'Ships things.' },
          },
        }),
      );
      expect(created.kind).toBe('TopicType');
      expect(created.spec).toEqual({
        label: 'Feature',
        icon: 'rocket',
        description: 'Ships things.',
        body_template: '',
      });
      expect(created.status).toEqual({});

      const list = jsonOf<{ count: number; documents: Envelope[] }>(
        await client.callTool({ name: 'wm-document-read', arguments: { kind: 'TopicType' } }),
      );
      expect(list.count).toBe(1);
      expect(list.documents[0]?.metadata.slug).toBe('feature');
    } finally {
      await client.close();
      await server.close();
      store.close();
    }
  });

  it('rejects an invalid TopicType spec (missing icon) and does NOT persist', async () => {
    const store = openStore(':memory:');
    const server = await startServer({ port: 0, store });
    const client = new Client({ name: 'wm-cp-tt-3', version: '0.0.0' });
    const transport = new StreamableHTTPClientTransport(new URL(`${server.url}/mcp`));
    try {
      await client.connect(transport);
      const res = await client.callTool({
        name: 'wm-document-create',
        arguments: { kind: 'TopicType', slug: 'bad', spec: { label: 'L', description: 'x' } },
      });
      expect((res as { isError?: boolean }).isError).toBe(true);
      expect(store.listDocuments({ kind: 'TopicType' })).toEqual([]);
    } finally {
      await client.close();
      await server.close();
      store.close();
    }
  });
});
