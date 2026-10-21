import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { openStore, type Store } from '../src/store';
import { loadKinds } from '../src/kinds/loader';
import { startServer } from '../src/server';
import { SYSTEM_IMPORT_AGENT_ID } from '../src/kinds/agent/spec';
import { ControlPlaneClient } from '../../shared/controlPlaneClient';

const stores: Store[] = [];
const directories: string[] = [];
const memory = () => {
  const store = openStore(':memory:');
  stores.push(store);
  return store;
};
const body = { title: 'Ready for review', description: '# Original\n\nReview **this**.', category: 'completion' };
beforeAll(async () => { await loadKinds(); });
afterEach(() => {
  for (const store of stores.splice(0)) store.close();
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe('registered Agent senders', () => {
  it('requires a live registered caller for canonical writes and protects historical attribution', () => {
    const store = memory();
    expect(() => store.createDocument({ kind: 'AgentMessage', spec: body })).toThrow(/agent_id/);
    expect(() => store.createDocument({ kind: 'Agent', spec: { name: '  ' } })).toThrow();
    const agent = store.createDocument({ kind: 'Agent', spec: { name: 'Review Agent' } });
    const other = store.createDocument({ kind: 'Agent', spec: { name: 'Other Agent' } });
    const spec = { ...body, agent_id: agent.metadata.id, dedupe_key: 'send-retry' };
    expect(() => store.createDocument({ kind: 'Agent', spec: { name: ' review agent ' } })).toThrow(/already registered/);
    expect(() => store.createDocument({ kind: 'AgentMessage', spec: { ...spec, agent_id: '00000000-0000-4000-8000-000000000099' } })).toThrow(/Unknown live registered Agent/);
    expect(() => store.createDocument({ kind: 'AgentMessage', spec: { ...spec, agent_name: 'Impersonated' } })).toThrow(/server-owned/);
    const message = store.createDocument({ kind: 'AgentMessage', spec });
    expect(message.spec.agent_name).toBe('Review Agent');
    expect(() => store.updateDocument({ id: message.metadata.id, expectedResourceVersion: message.metadata.resourceVersion,
      spec: { ...message.spec, agent_id: other.metadata.id } })).toThrow(/immutable/);
    store.updateDocument({ id: agent.metadata.id, expectedResourceVersion: agent.metadata.resourceVersion, spec: { name: 'Renamed Agent' } });
    expect(store.createDocument({ kind: 'AgentMessage', spec })).toEqual(message);
    const updated = store.updateDocument({ id: message.metadata.id, expectedResourceVersion: message.metadata.resourceVersion,
      spec: { ...message.spec, title: 'Changed title' } });
    expect(updated.spec.agent_name).toBe('Review Agent');
    const future = store.createDocument({ kind: 'AgentMessage', spec: { ...spec, dedupe_key: 'after-rename' } });
    expect(future.spec.agent_name).toBe('Renamed Agent');
    expect(() => store.deleteDocument({ id: agent.metadata.id })).toThrow(/referenced/);
    store.deleteDocument({ id: updated.metadata.id });
    store.deleteDocument({ id: future.metadata.id });
    expect(() => store.deleteDocument({ id: agent.metadata.id })).toThrow(/referenced/);
  });

  it('round-trips registered-agent MCP CRUD, lookup, CAS, uniqueness and required field guidance', async () => {
    const server = await startServer({ port: 0, store: memory() });
    const client = new ControlPlaneClient({ resolveUrl: () => `${server.url}/mcp` });
    try {
      const agent = await client.agentCreate({ name: '  Build Agent  ', description: '**Builds**' });
      expect(agent.name).toBe('Build Agent');
      expect(await client.agentRead({ name: 'build agent' })).toEqual([agent]);
      expect(await client.agentRead({ id: agent.id })).toEqual([agent]);
      await expect(client.agentCreate({ name: 'BUILD AGENT' })).rejects.toThrow(/already registered/);
      const updated = await client.agentUpdate({ id: agent.id, expectedResourceVersion: agent.resourceVersion, name: 'Release Agent' });
      await expect(client.agentUpdate({ id: agent.id, expectedResourceVersion: agent.resourceVersion, name: 'Stale' })).rejects.toThrow(/Conflict/);
      expect((await client.agentRead({ name: 'Release Agent' }))[0]).toEqual(updated);
      await client.agentDelete({ id: agent.id, expectedResourceVersion: updated.resourceVersion });
      expect(await client.agentRead({ id: agent.id })).toEqual([]);
      expect(await client.agentRead({ id: agent.id, includeDeleted: true })).toHaveLength(1);
      await client.agentDelete({ id: agent.id, restore: true });
      const message = await client.agentMessageCreate({ agent_id: agent.id, title: body.title,
        description: body.description, category: 'completion' });
      expect(message).toMatchObject({ agent_id: agent.id, agent_name: 'Release Agent' });
      const catalog = await client.listTools();
      const create = catalog.find((tool) => tool.name === 'ws-agent-message-create');
      expect(create?.inputSchema?.required).toContain('agent_id');
      expect(JSON.stringify(create?.inputSchema)).toMatch(/ws-agent-read.*ws-agent-create.*Remember/);
    } finally { await client.dispose(); await server.close(); }
  });

  it('blocks restore name collisions through generic and domain writes', () => {
    const store = memory();
    const first = store.createDocument({ kind: 'Agent', spec: { name: 'Release Agent' } });
    store.deleteDocument({ id: first.metadata.id });
    store.createDocument({ kind: 'Agent', spec: { name: 'release agent' } });
    expect(() => store.restoreDocument({ id: first.metadata.id })).toThrow(/already registered/);
    const topic = store.createDocument({ kind: 'Topic', spec: { title: 'Not an agent' } });
    expect(() => store.createDocument({ kind: 'AgentMessage', spec: { ...body, agent_id: topic.metadata.id } })).toThrow(/registered Agent/);
  });

  it('migrates v3 live and deleted messages to one System Import agent without altering authored content or timestamps', () => {
    const directory = mkdtempSync(join(tmpdir(), 'wm-registered-agents-'));
    directories.push(directory);
    const file = join(directory, 'store.db');
    const initial = openStore(file);
    const live = initial.createDocument({ kind: 'Alert', spec: { description: body.description, status: 'informational' } });
    const deleted = initial.createDocument({ kind: 'Alert', spec: { description: '**Deleted history**', status: 'closed' } });
    initial.deleteDocument({ id: deleted.metadata.id });
    initial.db.exec(`UPDATE resources SET spec = json_remove(spec, '$.agent_id', '$.agent_name') WHERE kind = 'AgentMessage';
      DELETE FROM resources WHERE kind = 'Agent';
      UPDATE resource_migrations SET version = 3 WHERE name = 'agent-messages'`);
    const before = initial.listDocuments({ kind: 'AgentMessage', includeDeleted: true });
    const cursor = initial.getResourceVersion();
    initial.close();
    const migrated = openStore(file);
    const documents = migrated.listDocuments({ kind: 'AgentMessage', includeDeleted: true });
    expect(migrated.listDocuments({ kind: 'Agent' })).toHaveLength(1);
    expect(migrated.getDocument({ id: SYSTEM_IMPORT_AGENT_ID })?.spec.name).toBe('System Import');
    for (const document of documents) {
      const original = before.find((item) => item.metadata.id === document.metadata.id)!;
      expect(document.spec).toEqual({ ...original.spec, agent_id: SYSTEM_IMPORT_AGENT_ID, agent_name: 'System Import' });
      expect(document.metadata).toMatchObject({ ...original.metadata, resourceVersion: expect.any(Number) });
      expect(document.metadata.resourceVersion).toBeGreaterThan(cursor);
    }
    expect(documents.map((item) => item.metadata.id).sort()).toEqual([live.metadata.id, deleted.metadata.id].sort());
    const version = migrated.getResourceVersion();
    migrated.close();
    const reopened = openStore(file);
    stores.push(reopened);
    expect(reopened.listDocuments({ kind: 'AgentMessage', includeDeleted: true })).toEqual(documents);
    expect(reopened.getResourceVersion()).toBe(version);
  });
});
