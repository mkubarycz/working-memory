import { expect, it } from 'vitest';
import { clearKinds } from '../../control-plane/src/kinds/registry';
import { loadKinds } from '../../control-plane/src/kinds/loader';
import { startServer } from '../../control-plane/src/server';
import { ControlPlaneClient } from '../../shared/controlPlaneClient';
import { toAgentMessageVM } from '../../shared/viewModels/agentMessageVms';
import { mergeMessageRows } from '../src/renderer/agentMessages';
import type { ChatRun } from '../src/renderer/chatHistory';
import { toGenericDocumentViewModel } from '../src/main/resolver';
import { documentTabKey, openDocumentTab, parseDocumentTabs, serializeDocumentTabs } from '../src/renderer/documentTabs';
import { recordAgentMessageDecision } from '../src/main/agentMessageLifecycle';

it('orders real persisted message seconds correctly after HTTP parsing and shared VM projection', async () => {
  clearKinds();
  await loadKinds();
  const server = await startServer({ port: 0 });
  const client = new ControlPlaneClient({ resolveUrl: () => `${server.url}/mcp` });
  try {
    const created = await client.agentMessageCreate({
      title: 'Published renderer validation', description: 'Canonical timestamp integration check.',
      category: 'completion', attention: false,
    });

    const persisted = (await client.agentMessageRead({ id: created.id }))[0];
    expect(persisted.created_at).toBeGreaterThan(1_700_000_000);
    expect(persisted.created_at).toBeLessThan(10_000_000_000);
    const message = toAgentMessageVM(persisted);
    expect(message.createdAt).toBe(persisted.created_at);
    const milliseconds = persisted.created_at * 1000;
    const rows = mergeMessageRows([
      { key: 'immediately-before', startedAt: milliseconds - 1 } as ChatRun,
      { key: 'immediately-after', startedAt: milliseconds + 1 } as ChatRun,
    ], [message]);
    expect(rows.map((row) => row.key)).toEqual([
      'run:immediately-before', `agent-message:${created.id}`, 'run:immediately-after',
    ]);
    expect(rows[1].timestamp).toBe(milliseconds);
    expect(new Date(rows[1].timestamp).getUTCFullYear()).toBeGreaterThan(2023);
    const envelope = (await client.getDocument({ id: created.id })).document!;
    const view = toGenericDocumentViewModel(envelope);
    expect(view.kind).toBe('AgentMessage');
    const state = openDocumentTab({ tabs: [], selectedKey: null }, view, false);
    const persistedTabs = parseDocumentTabs(serializeDocumentTabs(state))!;
    expect(persistedTabs.tabs).toEqual([{ kind: 'agent-message', identifier: created.id }]);
    expect(persistedTabs.selectedKey).toBe(`agent-message:${created.id}`);
    const restored = toGenericDocumentViewModel((await client.getDocument({ id: persistedTabs.tabs[0].identifier })).document!);
    expect(documentTabKey(restored)).toBe(persistedTabs.selectedKey);
    for (const kind of ['Alert', 'alert', 'AgentMessage']) {
      const legacy = parseDocumentTabs(JSON.stringify({
        version: 1, tabs: [{ kind, identifier: created.id }], selectedKey: `${kind}:${created.id}`,
      }))!;
      expect(legacy.tabs).toEqual(persistedTabs.tabs);
      expect(legacy.selectedKey).toBe(persistedTabs.selectedKey);
    }
  } finally {
    await client.dispose();
    await server.close();
  }
});

it('persists communication-only decisions through the real desktop helper and projects them for rendering', async () => {
  clearKinds();
  await loadKinds();
  const server = await startServer({ port: 0 });
  const client = new ControlPlaneClient({ resolveUrl: () => `${server.url}/mcp` });
  try {
    const topic = await client.topicCreate({ title: 'Human-owned decision scope', slug: 'decision-scope' });
    const approval = await client.agentMessageCreate({
      title: 'Request human review', description: 'This approval request cannot execute anything.',
      category: 'approval', topics: [topic.slug!], relations: [{ kind: 'Topic', id: topic.id }],
    });
    for (const outcome of ['approved', 'rejected'] as const) {
      await recordAgentMessageDecision(client, approval.id, {
        outcome, decided_by: 'Renderer Human', reason: 'Recorded communication, not an execution grant.',
      });
      const stored = (await client.agentMessageRead({ id: approval.id }))[0];
      const projected = toAgentMessageVM(stored);
      expect(projected.decision).toMatchObject({ outcome, decided_by: 'Renderer Human' });
      expect(projected.decision!.decided_at).toBeGreaterThan(1_700_000_000);
      expect(projected.decision!.decided_at).toBeLessThan(10_000_000_000);
      expect(projected.status).toBe('open');
      expect(projected.attention).toBe(false);
      expect((await client.topicRead({ id: topic.id }))[0].status).toBe('open');
    }
  } finally {
    await client.dispose();
    await server.close();
  }
});
