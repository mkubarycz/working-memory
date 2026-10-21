import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { startServer } from '../src/server';
import { loadKinds } from '../src/kinds/loader';
import { openStore } from '../src/store';

const cleanups: Array<() => Promise<void>> = [];
beforeAll(async () => { await loadKinds(); });
afterEach(async () => { for (const close of cleanups.splice(0)) await close(); });

async function connect() {
  const store = openStore(':memory:');
  const server = await startServer({ port: 0, store });
  const client = new Client({ name: 'workstream-id-api', version: '1' });
  await client.connect(new StreamableHTTPClientTransport(new URL(`${server.url}/mcp`)));
  cleanups.push(async () => { await client.close(); await server.close(); store.close(); });
  const call = async (name: string, args: Record<string, unknown> = {}) => {
    const result = await client.callTool({ name, arguments: args });
    const text = (result.content as Array<{ text?: string }>).find((part) => part.text)?.text ?? '';
    return { result, text, data: result.isError ? undefined : JSON.parse(text) };
  };
  return { store, client, call };
}

describe('control-plane Workstream ID-only API', () => {
  it('advertises stable tool names, document IDs, and strict input objects', async () => {
    const { client } = await connect();
    const tools = (await client.listTools()).tools;
    for (const operation of ['create', 'read', 'update', 'delete', 'reorder']) {
      const tool = tools.find((item) => item.name === `ws-workstream-${operation}`)!;
      expect(tool).toBeDefined();
      expect(tool.inputSchema.additionalProperties).toBe(false);
      expect(tool.inputSchema.properties).not.toHaveProperty('slug');
    }
    expect(tools.find((item) => item.name === 'ws-workstream-update')?.inputSchema.required).toContain('id');
  });

  it('round-trips create/read/update/delete/restore with the same immutable ID', async () => {
    const { call, store } = await connect();
    const created = (await call('ws-workstream-create', { title: 'Control Plane' })).data;
    expect(created).toMatchObject({ title: 'Control Plane', status: 'progress', position: 0 });
    expect(created.id).toEqual(expect.any(String));
    expect(created).not.toHaveProperty('slug');
    expect((await call('ws-workstream-read', { id: created.id })).data).toEqual({ count: 1, workstreams: [created] });
    expect((await call('ws-workstream-read')).data.workstreams).toContainEqual(created);
    const updated = (await call('ws-workstream-update', {
      id: created.id, title: 'Control Plane v2', status: 'closed', closure: 'Done', position: 12.5,
    })).data;
    expect(updated).toMatchObject({ id: created.id, title: 'Control Plane v2', status: 'closed', closure: 'Done', position: 12.5 });
    expect(updated.resourceVersion).toBeGreaterThan(created.resourceVersion);
    expect((await call('ws-workstream-delete', { id: created.id })).data).toEqual({ ok: true, id: created.id });
    expect((await call('ws-workstream-read', { id: created.id })).data.count).toBe(0);
    expect(store.getDocument({ id: created.id, includeDeleted: true })?.metadata.deletedAt).not.toBeNull();
    expect((await call('ws-workstream-delete', { id: created.id, restore: true })).data).toEqual({ ok: true, id: created.id });
    expect((await call('ws-workstream-read', { id: created.id })).data.workstreams[0]).toMatchObject({
      id: updated.id, title: updated.title, status: updated.status, closure: updated.closure, position: updated.position,
    });
  });

  it('uses existing non-UUID IDs without generating an alternate key', async () => {
    const { store, call } = await connect();
    store.db.prepare(`INSERT INTO resources
      (id,kind,labels,spec,status,created_at,updated_at,deleted_at,resource_version)
      VALUES (?, 'Workstream', '{}', ?, '{}', 1, 1, NULL, 1)`)
      .run('workstream-existing-42', JSON.stringify({ title: 'Existing', status: 'queue', position: 0 }));
    expect((await call('ws-workstream-read', { id: 'workstream-existing-42' })).data.workstreams[0].id).toBe('workstream-existing-42');
    expect((await call('ws-workstream-update', { id: 'workstream-existing-42', title: 'Edited' })).data.id).toBe('workstream-existing-42');
    expect((await call('ws-workstream-delete', { id: 'workstream-existing-42' })).data.id).toBe('workstream-existing-42');
    expect((await call('ws-workstream-delete', { id: 'workstream-existing-42', restore: true })).data.id).toBe('workstream-existing-42');
  });

  it('permits identical titles and restores by ID even when another title matches', async () => {
    const { call } = await connect();
    const first = (await call('ws-workstream-create', { title: 'Repeated title' })).data;
    await call('ws-workstream-delete', { id: first.id });
    const second = (await call('ws-workstream-create', { title: 'Repeated title' })).data;
    expect(second.id).not.toBe(first.id);
    expect((await call('ws-workstream-delete', { id: first.id, restore: true })).result.isError).not.toBe(true);
    expect((await call('ws-workstream-read', { query: 'Repeated title' })).data.count).toBe(2);
    expect((await call('ws-workstream-read', { limit: 1 })).data.count).toBe(1);
  });

  it('reorders atomically, rejects duplicate IDs, and rolls back unknown targets', async () => {
    const { call } = await connect();
    const one = (await call('ws-workstream-create', { title: 'One' })).data;
    const two = (await call('ws-workstream-create', { title: 'Two' })).data;
    const reordered = (await call('ws-workstream-reorder', { updates: [
      { id: two.id, status: 'progress', position: 0 }, { id: one.id, status: 'progress', position: 1 },
    ] })).data;
    expect(reordered.map(({ id, position }: { id: string; position: number }) => ({ id, position })))
      .toEqual([{ id: two.id, position: 0 }, { id: one.id, position: 1 }]);
    for (const updates of [
      [{ id: one.id, status: 'queue', position: 0 }, { id: 'missing', status: 'queue', position: 1 }],
      [{ id: one.id, status: 'queue', position: 0 }, { id: one.id, status: 'queue', position: 1 }],
    ]) {
      expect((await call('ws-workstream-reorder', { updates })).result.isError).toBe(true);
      expect((await call('ws-workstream-read', { id: one.id })).data.workstreams[0]).toMatchObject({ status: 'progress', position: 1 });
    }
  });

  it('rejects invalid status, wrong-kind IDs, and unknown update/delete/restore targets', async () => {
    const { call } = await connect();
    expect((await call('ws-workstream-create', { title: 'Bad', status: 'nonsense' })).result.isError).toBe(true);
    const created = (await call('ws-workstream-create', { title: 'Good' })).data;
    expect((await call('ws-workstream-update', { id: created.id, status: 'nonsense' })).result.isError).toBe(true);
    expect((await call('ws-workstream-read', { id: created.id })).data.workstreams[0].status).toBe('progress');
    const foreign = (await call('ws-config-create', { data: {} })).data;
    expect((await call('ws-workstream-read', { id: foreign.id })).data.count).toBe(0);
    for (const id of ['unknown-existing-id', foreign.id]) {
      for (const [name, args] of [
        ['ws-workstream-update', { id, title: 'Wrong' }],
        ['ws-workstream-delete', { id }],
        ['ws-workstream-delete', { id, restore: true }],
      ] as const) expect((await call(name, args)).result.isError).toBe(true);
    }
  });

  it('rejects obsolete locator fields rather than treating them as list/create requests', async () => {
    const { call, store } = await connect();
    for (const name of ['ws-workstream-create', 'ws-workstream-read', 'ws-workstream-update', 'ws-workstream-delete']) {
      expect((await call(name, { slug: 'obsolete', title: 'Must not persist' })).result.isError).toBe(true);
    }
    expect(store.listDocuments({ kind: 'Workstream' })).toHaveLength(0);
    expect((await call('wm-document-create', { kind: 'Workstream', spec: { title: 'Generic title-only' } })).result.isError).not.toBe(true);
  });
});
