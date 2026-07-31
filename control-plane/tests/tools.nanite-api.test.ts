import { describe, it, expect, beforeAll } from 'vitest';
import { startServer } from '../src/server';
import { openStore, type Store } from '../src/store';
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

interface INanite {
  id: string;
  slug: string | null;
  workstream: string;
  inputTopic: string;
  phase: string;
}

let clientSeq = 0;

async function connect(store: Store): Promise<{ client: Client; close: () => Promise<void> }> {
  const server = await startServer({ port: 0, store });
  const client = new Client({ name: `wm-cp-nanite-api-${++clientSeq}`, version: '0.0.0' });
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

(sqliteAvailable ? describe : describe.skip)('control-plane Nanite ws-nanite-create (topic-optional)', () => {
  beforeAll(async () => {
    clearKinds();
    await loadKinds();
  });

  it('creates a workstream-wide nanite with NO inputTopic', async () => {
    const { client, close } = await connect(openStore(':memory:'));
    try {
      await client.callTool({
        name: 'ws-workstream-create',
        arguments: { slug: 'ws-x', title: 'WS X' },
      });
      const res = await client.callTool({
        name: 'ws-nanite-create',
        arguments: { workstream: 'ws-x', request: 'do it' },
      });
      expect(isErrorResult(res)).toBe(false);
      const n = jsonOf<INanite>(res);
      expect(n.workstream).toBe('ws-x');
      expect(n.inputTopic).toBe('');
      expect(n.phase).toBe('Pending');
      expect(n.slug).toBeNull();
    } finally {
      await close();
    }
  });

  it('still rejects an unknown inputTopic when one IS supplied', async () => {
    const { client, close } = await connect(openStore(':memory:'));
    try {
      await client.callTool({
        name: 'ws-workstream-create',
        arguments: { slug: 'ws-y', title: 'WS Y' },
      });
      const res = await client.callTool({
        name: 'ws-nanite-create',
        arguments: { workstream: 'ws-y', inputTopic: 'ghost-topic' },
      });
      expect(isErrorResult(res)).toBe(true);
      expect(textOf(res)).toContain('Unknown input topic');
    } finally {
      await close();
    }
  });

  it('still rejects an unknown workstream', async () => {
    const { client, close } = await connect(openStore(':memory:'));
    try {
      const res = await client.callTool({
        name: 'ws-nanite-create',
        arguments: { workstream: 'nope' },
      });
      expect(isErrorResult(res)).toBe(true);
      expect(textOf(res)).toContain('Unknown workstream');
    } finally {
      await close();
    }
  });

  it('gates a bare start behind human approval; approved/begin advance the lifecycle', async () => {
    const { client, close } = await connect(openStore(':memory:'));
    try {
      await client.callTool({
        name: 'ws-workstream-create',
        arguments: { slug: 'ws-run', title: 'WS Run' },
      });
      const created = jsonOf<INanite>(
        await client.callTool({ name: 'ws-nanite-create', arguments: { workstream: 'ws-run' } }),
      );

      // A bare enqueue (agent / parent nanite, no approval, no template flag) is
      // refused — it needs a human, and nothing would run it otherwise.
      const bare = await client.callTool({
        name: 'ws-nanite-run',
        arguments: { id: created.id },
      });
      expect(isErrorResult(bare)).toBe(true);
      expect(textOf(bare)).toContain('needs human approval');

      // Still Pending (never stranded).
      const afterBare = jsonOf<{ nanites: INanite[] }>(
        await client.callTool({ name: 'ws-nanite-read', arguments: { id: created.id } }),
      );
      expect(afterBare.nanites[0]?.phase).toBe('Pending');

      // Human approval → Queued (awaiting the dispatcher).
      const queued = jsonOf<INanite>(
        await client.callTool({
          name: 'ws-nanite-run',
          arguments: { id: created.id, approved: true },
        }),
      );
      expect(queued.phase).toBe('Queued');

      // The engine's start (begin:true) transitions Queued → Running.
      const started = jsonOf<INanite>(
        await client.callTool({
          name: 'ws-nanite-run',
          arguments: { id: created.id, begin: true },
        }),
      );
      expect(started.phase).toBe('Running');
    } finally {
      await close();
    }
  });

  it('a template with allowRunWithoutHuman lets a bare enqueue reach Queued', async () => {
    const { client, close } = await connect(openStore(':memory:'));
    try {
      await client.callTool({
        name: 'ws-workstream-create',
        arguments: { slug: 'ws-auto', title: 'WS Auto' },
      });
      await client.callTool({
        name: 'ws-nanitetemplate-create',
        arguments: { slug: 'auto-tpl', title: 'Auto', allowRunWithoutHuman: true },
      });
      const created = jsonOf<INanite>(
        await client.callTool({
          name: 'ws-nanite-create',
          arguments: { workstream: 'ws-auto', templateId: 'auto-tpl' },
        }),
      );

      // No `approved`, but the template opts into unattended runs → Queued.
      const queued = jsonOf<INanite>(
        await client.callTool({ name: 'ws-nanite-run', arguments: { id: created.id } }),
      );
      expect(queued.phase).toBe('Queued');
    } finally {
      await close();
    }
  });
});
