import { describe, it, expect, afterEach, beforeAll } from 'vitest';
import { startServer, type RunningServer } from '../control-plane/src/server';
import { clearKinds } from '../control-plane/src/kinds/registry';
import { loadKinds } from '../control-plane/src/kinds/loader';
import { ControlPlaneClient } from '../src/controlPlaneClient';

/**
 * Exercises the {@link ControlPlaneClient} WRITE methods (create/update/delete)
 * against an ephemeral in-process control-plane server, mirroring the read-path
 * harness in `controlPlaneClient.test.ts`. Writes go through the real
 * `wm-document-{create,update,delete}` tools over the actual MCP client +
 * Streamable-HTTP transport.
 */
describe('ControlPlaneClient write methods', () => {
  let server: RunningServer | null = null;

  beforeAll(async () => {
    clearKinds();
    await loadKinds();
  });

  afterEach(async () => {
    await server?.close();
    server = null;
  });

  it('create → update → delete round-trips a document', async () => {
    server = await startServer({ port: 0 });
    const mcpUrl = `${server.url}/mcp`;
    const client = new ControlPlaneClient({ resolveUrl: () => mcpUrl });
    try {
      const created = await client.createDocument({
        kind: 'Workstream',
        slug: 'ws-write',
        spec: { title: 'Write Path' },
      });
      expect(created.available).toBe(true);
      expect(created.document?.kind).toBe('Workstream');
      expect(created.document?.metadata.slug).toBe('ws-write');
      // Kind default applied server-side.
      expect(created.document?.spec.status).toBe('progress');
      expect(created.document?.metadata.resourceVersion).toBe(1);

      const id = created.document!.metadata.id;
      const updated = await client.updateDocument({
        id,
        expectedResourceVersion: created.document!.metadata.resourceVersion,
        spec: { status: 'backlog' },
      });
      expect(updated.available).toBe(true);
      expect(updated.document?.spec.status).toBe('backlog');
      // Title was preserved (partial spec merge server-side).
      expect(updated.document?.spec.title).toBe('Write Path');
      expect(updated.document?.metadata.resourceVersion).toBe(2);

      const deleted = await client.deleteDocument({ id });
      expect(deleted.available).toBe(true);
      expect(deleted.document?.metadata.deletedAt).not.toBeNull();

      // After delete the doc drops out of reads.
      const gone = await client.getDocument({ id });
      expect(gone.available).toBe(true);
      expect(gone.document).toBeNull();

      // restore:true brings it back.
      const restored = await client.deleteDocument({ id, restore: true });
      expect(restored.available).toBe(true);
      expect(restored.document?.metadata.deletedAt).toBeNull();
    } finally {
      await client.dispose();
    }
  });

  it('surfaces a version conflict as an available-but-rejected result', async () => {
    server = await startServer({ port: 0 });
    const mcpUrl = `${server.url}/mcp`;
    const client = new ControlPlaneClient({ resolveUrl: () => mcpUrl });
    try {
      const created = await client.createDocument({
        kind: 'Workstream',
        slug: 'ws-conflict',
        spec: { title: 'Conflict' },
      });
      const id = created.document!.metadata.id;
      // Stale expectedResourceVersion (0) → conflict.
      const conflict = await client.updateDocument({
        id,
        expectedResourceVersion: 0,
        spec: { title: 'Nope' },
      });
      expect(conflict.available).toBe(true);
      expect(conflict.document).toBeNull();
      expect(conflict.error).toMatch(/[Cc]onflict/);
    } finally {
      await client.dispose();
    }
  });

  it('rejects an unknown-kind create with a tool error', async () => {
    server = await startServer({ port: 0 });
    const mcpUrl = `${server.url}/mcp`;
    const client = new ControlPlaneClient({ resolveUrl: () => mcpUrl });
    try {
      const bad = await client.createDocument({
        kind: 'NotAKind',
        spec: { title: 'x' },
      });
      expect(bad.available).toBe(true);
      expect(bad.document).toBeNull();
      expect(bad.error).toMatch(/[Uu]nknown kind/);
    } finally {
      await client.dispose();
    }
  });

  it('attaches then detaches a workstream via the topic read→update path', async () => {
    server = await startServer({ port: 0 });
    const mcpUrl = `${server.url}/mcp`;
    const client = new ControlPlaneClient({ resolveUrl: () => mcpUrl });
    try {
      await client.createDocument({
        kind: 'Workstream',
        slug: 'ws-membership',
        spec: { title: 'Membership' },
      });
      await client.topicCreate({ slug: 'topic-membership', title: 'Membership Topic' });

      // Attach adds the workstream to the topic's membership.
      const attached = await client.topicAttachWorkstream({
        slug: 'topic-membership',
        workstream: 'ws-membership',
      });
      expect(attached.workstreams).toContain('ws-membership');

      // Attaching again is idempotent — no duplicate.
      const again = await client.topicAttachWorkstream({
        slug: 'topic-membership',
        workstream: 'ws-membership',
      });
      expect(again.workstreams.filter((w) => w === 'ws-membership')).toHaveLength(1);

      // Detach removes it.
      const detached = await client.topicDetachWorkstream({
        slug: 'topic-membership',
        workstream: 'ws-membership',
      });
      expect(detached.workstreams).not.toContain('ws-membership');
    } finally {
      await client.dispose();
    }
  });

  it('throws on attach/detach for an unknown topic slug', async () => {
    server = await startServer({ port: 0 });
    const mcpUrl = `${server.url}/mcp`;
    const client = new ControlPlaneClient({ resolveUrl: () => mcpUrl });
    try {
      await expect(
        client.topicAttachWorkstream({ slug: 'no-such-topic', workstream: 'ws-x' }),
      ).rejects.toThrow(/[Uu]nknown topic slug/);
    } finally {
      await client.dispose();
    }
  });

  it('reports unavailable when no daemon is reachable', async () => {
    const client = new ControlPlaneClient({ resolveUrl: () => null });
    const created = await client.createDocument({ kind: 'Workstream', spec: { title: 'x' } });
    expect(created.available).toBe(false);
    expect(created.document).toBeNull();
    expect(created.error).toBeTruthy();
    await client.dispose();
  });
});
