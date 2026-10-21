import { describe, expect, it, vi } from 'vitest';
import type { AgentMessage } from '../../shared/controlPlaneClient';
import { buildAgentMessageVMs, agentMessageBubbleForTopics } from '../../shared/viewModels/agentMessageVms';
import { buildAgentMessagesPanel } from '../../shared/panelData';
import { listAgentMessages, recordAgentMessageDecision, updateAgentMessageStatus } from '../src/main/agentMessageLifecycle';
import { desktopDeepLink, parseDesktopDeepLink } from '../src/shared/deepLink';
import { resolveDesktopResourceUri } from '../src/main/resolver';
import { desktopToolDescriptors } from '../src/main/modelTools';
import { desktopHttpLink, parseDesktopHttpPath } from '../src/main/linkBridge';
import { renderDocumentByKind } from '../src/main/documentRenderers';

const message: AgentMessage = {
  id: 'message-1', slug: null, title: 'Review', description: '**Review**', recommended_action: 'Review PR',
  category: 'approval', severity: 'warning', status: 'open', attention: true, topics: ['one', 'two'],
  relations: [{ kind: 'Topic', id: 'topic-1' }], dedupe_key: null, created_by: 'agent',
  created_at: 1, updated_at: 2, resourceVersion: 1,
};

describe('AgentMessage desktop plumbing', () => {
  it.each(['approved', 'rejected'])('records an attributed %s decision without changing lifecycle or executing an action', async (outcome) => {
    const agentMessageUpdate = vi.fn().mockResolvedValue(message);
    await recordAgentMessageDecision({ agentMessageUpdate } as never, message.id, { outcome, decided_by: 'Reviewer' });
    expect(agentMessageUpdate.mock.calls).toEqual([[{ id: message.id, decision: { outcome, decided_by: 'Reviewer' } }]]);
  });

  it.each([
    { outcome: 'approved', decided_by: '' },
    { outcome: 'approved', decided_by: 'Reviewer', action: 'execute' },
    { outcome: 'approved', decided_by: 'Reviewer', decided_at: 1 },
    { outcome: 'pending', decided_by: 'Reviewer' },
  ])('rejects malformed or executable decision payload %j', async (decision) => {
    const agentMessageUpdate = vi.fn();
    await expect(recordAgentMessageDecision({ agentMessageUpdate } as never, message.id, decision)).rejects.toThrow('Invalid');
    expect(agentMessageUpdate).not.toHaveBeenCalled();
  });
  it('pages the entire history past 100 messages without dropping resolved records', async () => {
    const messages = Array.from({ length: 205 }, (_, index) => ({
      ...message, id: `message-${index}`, created_at: index, status: 'resolved' as const,
    }));
    const agentMessageRead = vi.fn().mockResolvedValue(messages.reverse());
    const client = { agentMessageRead } as never;
    const all = [
      ...await listAgentMessages(client, { limit: 100, offset: 0 }),
      ...await listAgentMessages(client, { limit: 100, offset: 100 }),
      ...await listAgentMessages(client, { limit: 100, offset: 200 }),
    ];
    expect(all).toHaveLength(205);
    expect(new Set(all.map((item) => item.id)).size).toBe(205);
    expect(all[204].id).toBe('message-204');
    expect(agentMessageRead.mock.calls).toEqual([[], [], []]);
  });

  it.each([{ offset: -1 }, { limit: 0 }, { offset: 0.5 }])('rejects invalid IPC page %j', async (input) => {
    const agentMessageRead = vi.fn();
    await expect(listAgentMessages({ agentMessageRead } as never, input)).rejects.toThrow('Invalid');
    expect(agentMessageRead).not.toHaveBeenCalled();
  });
  it('retains old acknowledged/resolved messages and scopes only the relevant history', () => {
    const messages: AgentMessage[] = [
      { ...message, id: 'resolved', status: 'resolved', updated_at: 1 },
      { ...message, id: 'acknowledged', status: 'acknowledged' },
      message, { ...message, id: 'unrelated', topics: ['other'] },
    ];
    expect(buildAgentMessageVMs(messages, ['one'], Number.MAX_SAFE_INTEGER).map((item) => item.id))
      .toEqual(['message-1', 'acknowledged', 'resolved']);
    expect(buildAgentMessageVMs(messages, ['one'])[2].dimmed).toBe(true);
  });

  it('scopes UUID relation callouts and attention without treating slugs or missing IDs as UUIDs', () => {
    const messages: AgentMessage[] = [
      { ...message, id: 'topic-ref', topics: [], relations: [{ kind: 'Topic', id: 'topic-uuid' }] },
      { ...message, id: 'workstream-ref', topics: [], relations: [{ kind: 'Workstream', id: 'workstream-uuid' }] },
      { ...message, id: 'wrong-kind', topics: [], relations: [{ kind: 'Workstream', id: 'topic-uuid' }] },
      { ...message, id: 'slug-not-id', topics: [], relations: [{ kind: 'Topic', id: 'one' }] },
      { ...message, id: 'unrelated', topics: [], relations: [{ kind: 'Topic', id: 'other-uuid' }] },
    ];
    const scope = { topicSlugs: ['one'], topicIds: ['topic-uuid'], workstreamIds: ['workstream-uuid'] };
    expect(buildAgentMessageVMs(messages, scope).map((item) => item.id)).toEqual(['topic-ref', 'workstream-ref']);
    expect(agentMessageBubbleForTopics(messages, scope)).toEqual({ count: 2, severity: 'warning' });
    expect(buildAgentMessageVMs(messages, { topicSlugs: ['one'] })).toEqual([]);
    expect(agentMessageBubbleForTopics(messages, { topicSlugs: [], topicIds: [], workstreamIds: [] }))
      .toEqual({ count: 0, severity: null });
  });

  it('counts only open attention messages, deduped across topics, with canonical severity', () => {
    expect(agentMessageBubbleForTopics([
      message, message,
      { ...message, id: 'info', attention: false, severity: 'error' },
      { ...message, id: 'ack', status: 'acknowledged', severity: 'error' },
      { ...message, id: 'resolved', status: 'resolved', severity: 'error' },
      { ...message, id: 'error', severity: 'error' },
    ], ['one', 'two'])).toEqual({ count: 2, severity: 'error' });
  });

  it.each(['open', 'acknowledged', 'resolved'])('IPC lifecycle %s updates only the canonical message', async (status) => {
    const agentMessageUpdate = vi.fn().mockResolvedValue(message);
    await updateAgentMessageStatus({ agentMessageUpdate } as never, message.id, status);
    expect(agentMessageUpdate.mock.calls).toEqual([[{
      id: message.id, status, ...(status !== 'open' ? { attention: false } : {}),
    }]]);
  });

  it.each(['closed', 'alert', '', null, 1])('rejects invalid IPC lifecycle %j', async (status) => {
    const agentMessageUpdate = vi.fn();
    await expect(updateAgentMessageStatus({ agentMessageUpdate } as never, message.id, status)).rejects.toThrow('Invalid');
    expect(agentMessageUpdate).not.toHaveBeenCalled();
  });

  it('routes canonical and historical native/internal links to the same message id', () => {
    expect(desktopDeepLink('agent-message', 'one two')).toBe('working-memory://open/agent-message/one%20two');
    for (const kind of ['agent-message', 'alert']) {
      expect(parseDesktopDeepLink(`working-memory://open/${kind}/one%20two`))
        .toEqual({ kind: 'agent-message', identifier: 'one two' });
      expect(resolveDesktopResourceUri(`working-memory:/${kind}/one%20two.working-memory`))
        .toEqual({ kind: 'agent-message', identifier: 'one two' });
    }
  });

  it('keeps the restricted HTTP allowlist unchanged while historical alerts resolve canonically', () => {
    expect(parseDesktopHttpPath('/open/agent-message/message-1')).toBeNull();
    expect(parseDesktopHttpPath('/open/alert/message-1')).toEqual({ kind: 'agent-message', identifier: 'message-1' });
    expect(desktopHttpLink('agent-message', 'message-1')).toBe('http://127.0.0.1:7718/open/alert/message-1');
  });

  it('lists history on the canonical panel with canonical links', () => {
    expect(buildAgentMessagesPanel({ available: true, agentMessages: [message, { ...message, id: 'old', status: 'resolved' }] }))
      .toMatchObject({ tab: 'agent-messages', items: [
        { kind: 'agent-message', status: 'open', openUri: 'working-memory:/agent-message/message-1.working-memory' },
        { kind: 'agent-message', status: 'resolved', openUri: 'working-memory:/agent-message/old.working-memory' },
      ] });
  });

  it('advertises canonical messages, not deprecated alert tools', () => {
    expect(desktopToolDescriptors([
      { name: 'ws-agent-message-create' }, { name: 'ws-agent-message-read' }, { name: 'ws-alert-create' },
    ]).map((tool) => tool.name)).toEqual(['ws-agent-message-create', 'ws-agent-message-read']);
  });

  it('renders an AgentMessage document with lifecycle and unchanged Markdown', () => {
    const rendered = renderDocumentByKind({
      kind: 'AgentMessage', metadata: { id: 'message-1', slug: null, createdAt: 1, updatedAt: 2, resourceVersion: 1 },
      spec: { ...message },
    } as never);
    expect(rendered).toContain('# Agent message: Review');
    expect(rendered).toContain('**Review**');
    expect(rendered).toContain('`status`: open');
    expect(rendered).toContain('`category`: approval');
  });
});
