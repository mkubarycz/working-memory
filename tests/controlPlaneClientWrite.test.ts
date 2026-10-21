import { describe, it, expect, afterEach, beforeAll } from 'vitest';
import { startServer, type RunningServer } from '../control-plane/src/server';
import { clearKinds } from '../control-plane/src/kinds/registry';
import { loadKinds } from '../control-plane/src/kinds/loader';
import { ControlPlaneClient } from '../shared/controlPlaneClient';

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
        spec: { title: 'Write Path' },
      });
      expect(created.available).toBe(true);
      expect(created.document?.kind).toBe('Workstream');
      expect(created.document?.metadata.id).toBeTruthy();
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

  it('creates, appends, and finalizes a CommandJournal through typed methods', async () => {
    server = await startServer({ port: 0 });
    const client = new ControlPlaneClient({ resolveUrl: () => `${server!.url}/mcp` });
    try {
      const created = await client.commandJournalCreate({
        startedAt: 1_000,
        provider: { endpoint: 'http://127.0.0.1:11434', mode: 'local', model: 'qwen3:14b' },
        request: { userText: 'Read the selected topic.' },
        primaryScope: { kind: 'Topic', id: 'topic-1',  },
      });
      const appended = await client.commandJournalAppend({
        id: created.id,
        expectedResourceVersion: created.resourceVersion,
        events: [
          { id: 'turn-1', sequence: 1, timestamp: 1_010, type: 'model_turn', role: 'assistant', iteration: 1, assistantText: 'Done.', durationMs: 10 },
        ],
      });
      const finalized = await client.commandJournalFinalize({
        id: created.id,
        expectedResourceVersion: appended.resourceVersion,
        status: 'succeeded',
        completedAt: 1_020,
        completion: { finalAssistantText: 'Done.', stopReason: 'stop', mutated: false },
      });

      expect(finalized.status).toBe('succeeded');
      expect(finalized.events).toHaveLength(1);
      expect(finalized.resourceVersion).toBe(3);

      const page = await client.commandJournalRead({ limit: 1 });
      expect(page.journals).toHaveLength(1);
      expect(page.journals[0]).toMatchObject({ id: created.id, status: 'succeeded' });
      expect(page.journals[0]).not.toHaveProperty('events');

      const detail = await client.commandJournalRead({ id: created.id });
      expect(detail).toMatchObject({ id: created.id, events: [{ id: 'turn-1' }] });
    } finally {
      await client.dispose();
    }
  });

  it('attaches then detaches a workstream via the topic read→update path', async () => {
    server = await startServer({ port: 0 });
    const mcpUrl = `${server.url}/mcp`;
    const client = new ControlPlaneClient({ resolveUrl: () => mcpUrl });
    try {
      const workstream = await client.wsCreate({ title: 'Membership' });
      await client.topicTypeCreate({ label: 'Topic', icon: 'notebook', description: 'Default' });
      const topic = await client.topicCreate({
        title: 'Membership Topic',
      });

      // Attach adds the workstream to the topic's membership.
      const attached = await client.topicAttachWorkstream({
        id: topic.id,
        workstream: workstream.id,
      });
      expect(attached.workstreams).toContain(workstream.id);

      // Attaching again is idempotent — no duplicate.
      const again = await client.topicAttachWorkstream({
        id: topic.id,
        workstream: workstream.id,
      });
      expect(again.workstreams.filter((w) => w === workstream.id)).toHaveLength(1);

      // Detach removes it.
      const detached = await client.topicDetachWorkstream({
        id: topic.id,
        workstream: workstream.id,
      });
      expect(detached.workstreams).not.toContain(workstream.id);
    } finally {
      await client.dispose();
    }
  });

  it('atomically transfers a topic descendant closure through the typed client', async () => {
    server = await startServer({ port: 0 });
    const client = new ControlPlaneClient({ resolveUrl: () => `${server!.url}/mcp` });
    try {
      const [source, target, destination] = await Promise.all(['Source', 'Target', 'Moved'].map((title) => client.wsCreate({ title })));
      await client.topicTypeCreate({ label: 'Topic', icon: 'notebook', description: 'Default' });
      const parent = await client.topicCreate({ title: 'Parent', workstreams: [source.id] });
      const child = await client.topicCreate({ title: 'Child', parents: [parent.id], workstreams: [source.id] });

      const copied = await client.topicTransfer({
        id: parent.id, sourceWorkstream: source.id, targetWorkstream: target.id,
      });
      expect(copied.map((topic) => topic.id).sort()).toEqual([child.id, parent.id].sort());
      expect(copied.every((topic) => topic.workstreams.includes(source.id) && topic.workstreams.includes(target.id)))
        .toBe(true);

      const moved = await client.topicTransfer({
        id: parent.id, sourceWorkstream: source.id, targetWorkstream: destination.id, move: true,
      });
      expect(moved.every((topic) => !topic.workstreams.includes(source.id) && topic.workstreams.includes(destination.id)))
        .toBe(true);

      const preview = await client.topicCloseTree({ id: parent.id, dryRun: true });
      expect(preview).toMatchObject({
        dryRun: true,
        matchedIds: [parent.id, child.id],
        closedCount: 2,
      });
      const closed = await client.topicCloseTree({ id: parent.id });
      expect(closed).toMatchObject({ matchedCount: 2, closedCount: 2 });
    } finally {
      await client.dispose();
    }
  });

  it('sets then clears per-workstream focus via topicSetFocus / topicClearFocus', async () => {
    server = await startServer({ port: 0 });
    const mcpUrl = `${server.url}/mcp`;
    const client = new ControlPlaneClient({ resolveUrl: () => mcpUrl });
    try {
      const workstream = await client.wsCreate({ title: 'Focus WS' });
      await client.topicTypeCreate({ label: 'Topic', icon: 'notebook', description: 'Default' });
      const topic = await client.topicCreate({ title: 'Focus Topic' });

      // Set focus adds BOTH membership and the focus pin (idempotent).
      const focused = await client.topicSetFocus({
        id: topic.id,
        workstream: workstream.id,
      });
      expect(focused.workstreams).toContain(workstream.id);
      expect(focused.focusedWorkstreams).toContain(workstream.id);

      const again = await client.topicSetFocus({
        id: topic.id,
        workstream: workstream.id,
      });
      expect(again.workstreams.filter((w) => w === workstream.id)).toHaveLength(1);
      expect(again.focusedWorkstreams.filter((w) => w === workstream.id)).toHaveLength(1);

      // Clear focus drops the pin but KEEPS membership (idempotent).
      const cleared = await client.topicClearFocus({
        id: topic.id,
        workstream: workstream.id,
      });
      expect(cleared.focusedWorkstreams).not.toContain(workstream.id);
      expect(cleared.workstreams).toContain(workstream.id);

      const clearedAgain = await client.topicClearFocus({
        id: topic.id,
        workstream: workstream.id,
      });
      expect(clearedAgain.focusedWorkstreams).not.toContain(workstream.id);
      expect(clearedAgain.workstreams).toContain(workstream.id);
    } finally {
      await client.dispose();
    }
  });

  it('throws on attach/detach for an unknown topic id', async () => {
    server = await startServer({ port: 0 });
    const mcpUrl = `${server.url}/mcp`;
    const client = new ControlPlaneClient({ resolveUrl: () => mcpUrl });
    try {
      await expect(
        client.topicAttachWorkstream({ id: 'no-such-topic', workstream: 'ws-x' }),
      ).rejects.toThrow(/[Uu]nknown topic id/);
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

  it('alertUpdate sends { id, status } to ws-alert-update and returns the parsed alert', async () => {
    server = await startServer({ port: 0 });
    const mcpUrl = `${server.url}/mcp`;
    const client = new ControlPlaneClient({ resolveUrl: () => mcpUrl });
    try {
      // Seed an alert document (status defaults to 'alert') via the generic
      // create tool, then flip it to 'closed' through the typed alertUpdate.
      await client.topicTypeCreate({ label: 'Topic', icon: 'notebook', description: 'Default' });
      const topic = await client.topicCreate({ title: 'Operations' });
      const created = await client.alertCreate({ description: 'disk almost full', topics: [topic.id] });
      const id = created.id;

      const updated = await client.alertUpdate({ id, status: 'closed' });
      expect(updated.id).toBe(id);
      expect(updated.status).toBe('closed');
      // Untouched fields are preserved (partial-patch merge server-side) and the
      // returned shape is well-formed.
      expect(updated.description).toBe('disk almost full');
      expect(updated.topics).toEqual([topic.id]);
      expect(updated.resourceVersion).toBe(created.resourceVersion + 1);
    } finally {
      await client.dispose();
    }
  });
});
