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
  configs?: string[];
  request?: string;
  phase: string;
  output?: string;
  resourceVersion: number;
  toolCalls?: { name: string; ok: boolean; error?: string }[];
  steps?: {
    kind: 'assistant' | 'tool';
    text?: string;
    name?: string;
    ok?: boolean;
    input?: string;
    result?: string;
    error?: string;
  }[];
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

  it('defaults configs to [] and accepts a configs array of slugs/ids', async () => {
    const { client, close } = await connect(openStore(':memory:'));
    try {
      await client.callTool({
        name: 'ws-workstream-create',
        arguments: { slug: 'ws-cfg', title: 'WS Cfg' },
      });
      // No configs → defaults to [].
      const bare = jsonOf<INanite>(
        await client.callTool({
          name: 'ws-nanite-create',
          arguments: { workstream: 'ws-cfg' },
        }),
      );
      expect(bare.configs).toEqual([]);
      // An explicit configs array of slugs/ids is accepted verbatim.
      const withCfg = await client.callTool({
        name: 'ws-nanite-create',
        arguments: { workstream: 'ws-cfg', configs: ['banking-app-developer', 'shared-secrets'] },
      });
      expect(isErrorResult(withCfg)).toBe(false);
      const n = jsonOf<INanite>(withCfg);
      expect(n.configs).toEqual(['banking-app-developer', 'shared-secrets']);
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

  it('persists the run result — output, toolCalls, and the ordered steps trace — and reads it back', async () => {
    const { client, close } = await connect(openStore(':memory:'));
    try {
      await client.callTool({
        name: 'ws-workstream-create',
        arguments: { slug: 'ws-trace', title: 'WS Trace' },
      });
      await client.callTool({
        name: 'ws-nanitetemplate-create',
        arguments: { slug: 'trace-tpl', title: 'Trace', allowRunWithoutHuman: true },
      });
      const created = jsonOf<INanite>(
        await client.callTool({
          name: 'ws-nanite-create',
          arguments: { workstream: 'ws-trace', templateId: 'trace-tpl' },
        }),
      );
      // Queue (unattended) then start.
      await client.callTool({ name: 'ws-nanite-run', arguments: { id: created.id } });
      await client.callTool({ name: 'ws-nanite-run', arguments: { id: created.id, begin: true } });

      const steps = [
        { kind: 'assistant', text: 'Listing topics first.' },
        { kind: 'tool', name: 'wm_list_topics', ok: true, input: '{"status":"open"}', result: '[]' },
        { kind: 'tool', name: 'wm_delete_topic', ok: false, input: '{"slug":"a"}', error: 'not granted' },
      ];
      const finished = jsonOf<INanite>(
        await client.callTool({
          name: 'ws-nanite-run',
          arguments: {
            id: created.id,
            outcome: 'succeeded',
            output: 'all done',
            toolCalls: [
              { name: 'wm_list_topics', ok: true },
              { name: 'wm_delete_topic', ok: false, error: 'not granted' },
            ],
            steps,
          },
        }),
      );

      expect(finished.phase).toBe('Succeeded');
      expect(finished.output).toBe('all done');
      // The ordered trace survives the strict spec schema round-trip.
      expect(finished.steps).toEqual(steps);

      // And it's still there on a fresh read.
      const reread = jsonOf<{ nanites: INanite[] }>(
        await client.callTool({ name: 'ws-nanite-read', arguments: { id: created.id } }),
      );
      expect(reread.nanites[0]?.steps).toEqual(steps);
    } finally {
      await close();
    }
  });

  it('reset clears the steps trace back to empty', async () => {
    const { client, close } = await connect(openStore(':memory:'));
    try {
      await client.callTool({
        name: 'ws-workstream-create',
        arguments: { slug: 'ws-reset', title: 'WS Reset' },
      });
      await client.callTool({
        name: 'ws-nanitetemplate-create',
        arguments: { slug: 'reset-tpl', title: 'Reset', allowRunWithoutHuman: true },
      });
      const created = jsonOf<INanite>(
        await client.callTool({
          name: 'ws-nanite-create',
          arguments: { workstream: 'ws-reset', templateId: 'reset-tpl' },
        }),
      );
      await client.callTool({ name: 'ws-nanite-run', arguments: { id: created.id } });
      await client.callTool({ name: 'ws-nanite-run', arguments: { id: created.id, begin: true } });
      await client.callTool({
        name: 'ws-nanite-run',
        arguments: {
          id: created.id,
          outcome: 'succeeded',
          steps: [{ kind: 'tool', name: 'wm_list_topics', ok: true }],
        },
      });

      const reset = jsonOf<INanite>(
        await client.callTool({ name: 'ws-nanite-run', arguments: { id: created.id, reset: true } }),
      );
      expect(reset.phase).toBe('Pending');
      expect(reset.steps).toEqual([]);
    } finally {
      await close();
    }
  });
});

(sqliteAvailable ? describe : describe.skip)('control-plane Nanite ws-nanite-update (configs/request in place)', () => {
  beforeAll(async () => {
    clearKinds();
    await loadKinds();
  });

  it('updates configs in place and persists across a re-read', async () => {
    const { client, close } = await connect(openStore(':memory:'));
    try {
      await client.callTool({
        name: 'ws-workstream-create',
        arguments: { slug: 'ws-upd', title: 'WS Upd' },
      });
      const created = jsonOf<INanite>(
        await client.callTool({
          name: 'ws-nanite-create',
          arguments: { workstream: 'ws-upd', request: 'original' },
        }),
      );
      expect(created.configs).toEqual([]);

      const updated = jsonOf<INanite>(
        await client.callTool({
          name: 'ws-nanite-update',
          arguments: { id: created.id, configs: ['banking-app-developer'] },
        }),
      );
      expect(updated.configs).toEqual(['banking-app-developer']);
      // request is unpatched → preserved by the merge.
      expect(updated.request).toBe('original');
      expect(updated.resourceVersion).toBe(created.resourceVersion + 1);

      // Persisted: a fresh read shows the new configs.
      const reread = jsonOf<{ nanites: INanite[] }>(
        await client.callTool({ name: 'ws-nanite-read', arguments: { id: created.id } }),
      );
      expect(reread.nanites[0]?.configs).toEqual(['banking-app-developer']);
    } finally {
      await close();
    }
  });

  it('updates request in place, leaving configs untouched', async () => {
    const { client, close } = await connect(openStore(':memory:'));
    try {
      await client.callTool({
        name: 'ws-workstream-create',
        arguments: { slug: 'ws-req', title: 'WS Req' },
      });
      const created = jsonOf<INanite>(
        await client.callTool({
          name: 'ws-nanite-create',
          arguments: { workstream: 'ws-req', configs: ['keep-me'], request: 'before' },
        }),
      );

      const updated = jsonOf<INanite>(
        await client.callTool({
          name: 'ws-nanite-update',
          arguments: { id: created.id, request: 'after' },
        }),
      );
      expect(updated.request).toBe('after');
      expect(updated.configs).toEqual(['keep-me']);
    } finally {
      await close();
    }
  });

  it('ignores attempts to change workstream / inputTopic / phase (immutable fields)', async () => {
    const { client, close } = await connect(openStore(':memory:'));
    try {
      await client.callTool({
        name: 'ws-workstream-create',
        arguments: { slug: 'ws-immut', title: 'WS Immut' },
      });
      await client.callTool({
        name: 'ws-workstream-create',
        arguments: { slug: 'ws-other', title: 'WS Other' },
      });
      const created = jsonOf<INanite>(
        await client.callTool({
          name: 'ws-nanite-create',
          arguments: { workstream: 'ws-immut', request: 'r' },
        }),
      );

      // Extra immutable keys are stripped by the tool schema → ignored. The
      // patchable `configs` still lands; workstream / inputTopic / phase hold.
      const updated = jsonOf<INanite>(
        await client.callTool({
          name: 'ws-nanite-update',
          arguments: {
            id: created.id,
            configs: ['cfg-a'],
            workstream: 'ws-other',
            inputTopic: 'some-topic',
            phase: 'Running',
          },
        }),
      );
      expect(updated.configs).toEqual(['cfg-a']);
      expect(updated.workstream).toBe('ws-immut');
      expect(updated.inputTopic).toBe('');
      expect(updated.phase).toBe('Pending');
    } finally {
      await close();
    }
  });

  it('rejects an unknown nanite id', async () => {
    const { client, close } = await connect(openStore(':memory:'));
    try {
      const res = await client.callTool({
        name: 'ws-nanite-update',
        arguments: { id: 'does-not-exist', configs: ['x'] },
      });
      expect(isErrorResult(res)).toBe(true);
      expect(textOf(res)).toContain('Unknown nanite id');
    } finally {
      await close();
    }
  });

  it('surfaces a CAS conflict on a stale expectedResourceVersion', async () => {
    const { client, close } = await connect(openStore(':memory:'));
    try {
      await client.callTool({
        name: 'ws-workstream-create',
        arguments: { slug: 'ws-cas', title: 'WS Cas' },
      });
      const created = jsonOf<INanite>(
        await client.callTool({
          name: 'ws-nanite-create',
          arguments: { workstream: 'ws-cas', request: 'v1' },
        }),
      );

      // Advance the stored version once.
      const advanced = jsonOf<INanite>(
        await client.callTool({
          name: 'ws-nanite-update',
          arguments: { id: created.id, request: 'v2' },
        }),
      );
      expect(advanced.resourceVersion).toBe(created.resourceVersion + 1);

      // The now-stale version from the first read → conflict, no write.
      const conflict = await client.callTool({
        name: 'ws-nanite-update',
        arguments: {
          id: created.id,
          expectedResourceVersion: created.resourceVersion,
          request: 'v3',
        },
      });
      expect(isErrorResult(conflict)).toBe(true);
      expect(textOf(conflict)).toMatch(/conflict/i);

      // The stale write did not land.
      const reread = jsonOf<{ nanites: INanite[] }>(
        await client.callTool({ name: 'ws-nanite-read', arguments: { id: created.id } }),
      );
      expect(reread.nanites[0]?.request).toBe('v2');
    } finally {
      await close();
    }
  });
});
