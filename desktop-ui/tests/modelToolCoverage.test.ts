import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { clearKinds } from '../../control-plane/src/kinds/registry';
import { loadKinds } from '../../control-plane/src/kinds/loader';
import { startServer, type RunningServer } from '../../control-plane/src/server';
import { desktopToolDescriptors } from '../src/main/modelTools';
import { ControlPlaneClient } from '../../shared/controlPlaneClient';
import { updateAgentMessageStatus } from '../src/main/agentMessageLifecycle';

describe('desktop tool coverage', () => {
  let server: RunningServer;
  let client: Client;

  beforeAll(async () => {
    clearKinds();
    await loadKinds();
    server = await startServer({ port: 0 });
    client = new Client({ name: 'wm-desktop-tool-coverage', version: '0.0.0' });
    await client.connect(new StreamableHTTPClientTransport(new URL(`${server.url}/mcp`)));
  });

  afterAll(async () => {
    await client?.close();
    await server?.close();
  });

  it('projects every registered tool in the supported high-level ws families', async () => {
    const canonical = (await client.listTools()).tools;
    const projected = desktopToolDescriptors(canonical).map((tool) => tool.name);
    const requestedFamilies = ['workstream', 'topic', 'topictype', 'agent-message', 'agent'];
    const expected = canonical
      .map((tool) => tool.name)
      .filter((name) => requestedFamilies.some((family) => name.startsWith(`ws-${family}-`)));

    expect(projected).toEqual(expected);
    expect(new Set(projected.map((name) => `ws-${requestedFamilies.find((family) => name.startsWith(`ws-${family}-`))}`))).toEqual(new Set([
      'ws-workstream',
      'ws-topic',
      'ws-topictype',
      'ws-agent-message',
      'ws-agent',
    ]));
    expect(projected.some((name) => name.startsWith('ws-config-'))).toBe(false);
    expect(projected.some((name) => name.startsWith('wm-document-'))).toBe(false);
    expect(projected.some((name) => name.startsWith('ws-alert-'))).toBe(false);
  });

  it('round-trips the canonical typed client against the registered message tools', async () => {
    const typed = new ControlPlaneClient({ resolveUrl: () => `${server.url}/mcp` });
    try {
      await typed.topicTypeCreate({ label: 'Topic', icon: 'notebook', description: 'Default' });
      const topic = await typed.topicCreate({ title: 'Review topic' });
      const agent = await typed.agentCreate({ name: 'Desktop Integration Agent' });
      const created = await typed.agentMessageCreate({
        agent_id: agent.id,
        title: 'Review this change', category: 'approval', description: '**Review** this change', attention: true,
        recommended_action: 'Review the pull request and explicitly approve or request changes.',
        topics: [topic.id], relations: [{ kind: 'Topic', id: topic.id }],
        provenance: { source: 'desktop-integration' },
      });
      expect(created).toMatchObject({
        id: created.id, category: 'approval', status: 'open', attention: true,
        description: '**Review** this change',
      });
      expect(await typed.agentMessageRead({ id: created.id })).toEqual([created]);
      const decisionRecorded = await typed.agentMessageUpdate({
        id: created.id,
        decision: { outcome: 'approved', decided_by: 'Human reviewer', reason: 'Review recorded, not execution authorized.' },
      });
      expect(decisionRecorded).toMatchObject({
        status: 'open', attention: true,
        decision: { outcome: 'approved', decided_by: 'Human reviewer', reason: 'Review recorded, not execution authorized.' },
      });
      expect(decisionRecorded.decision?.decided_at).toBeTypeOf('number');
      expect(decisionRecorded.decision!.decided_at).toBeLessThan(Date.now() / 1000 + 1);
      await updateAgentMessageStatus(typed, created.id, 'acknowledged');
      const [acknowledged] = await typed.agentMessageRead({ id: created.id });
      expect(acknowledged).toMatchObject({ status: 'acknowledged', category: 'approval' });
      expect(acknowledged.attention).toBe(false);
      expect(acknowledged.resourceVersion).toBeGreaterThan(created.resourceVersion);
      await updateAgentMessageStatus(typed, created.id, 'resolved');
      const [resolved] = await typed.agentMessageRead({ id: created.id });
      expect(resolved).toMatchObject({ status: 'resolved' });
      expect(resolved.attention).toBe(false);
      expect(resolved.resourceVersion).toBeGreaterThan(acknowledged.resourceVersion);
      expect(await typed.agentMessageRead({ id: created.id })).toEqual([resolved]);
      expect((await typed.topicRead({ id: topic.id }))[0].status).toBe('open');
      await updateAgentMessageStatus(typed, created.id, 'open');
      const [reopened] = await typed.agentMessageRead({ id: created.id });
      expect(reopened).toMatchObject({ id: created.id, status: 'open' });
      expect(reopened.attention).toBe(false);
      expect(reopened.resourceVersion).toBeGreaterThan(resolved.resourceVersion);
      const deleted = await typed.agentMessageDelete({ id: created.id, expectedResourceVersion: reopened.resourceVersion });
      expect(deleted.deleted_at).toBeTypeOf('number');
      expect(await typed.agentMessageRead({ id: created.id })).toEqual([]);
      const deletedHistory = await typed.agentMessageReadPage({ includeDeleted: true, limit: 1 });
      expect(deletedHistory.messages).toMatchObject([{ id: created.id, deleted_at: deleted.deleted_at }]);
      expect(deletedHistory).toMatchObject({ count: 1, totalCount: 1, nextOffset: null });
      expect(await typed.agentMessageRestore({ id: created.id })).toMatchObject({ id: created.id, status: 'open' });
    } finally {
      await typed.dispose();
    }
  });
});