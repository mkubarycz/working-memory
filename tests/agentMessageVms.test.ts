import { describe, expect, it } from 'vitest';
import type { AgentMessage, Topic } from '../shared/controlPlaneClient';
import { agentMessageBubbleForTopic, agentMessageBubbleForTopics, buildAgentMessageVMs, toAgentMessageVM } from '../shared/viewModels/agentMessageVms';
import { buildAgentMessagesPanel, buildTopicsPanel, buildWorkstreamTree } from '../shared/panelData';

function message(extra: Partial<AgentMessage> = {}): AgentMessage {
  return {
    id: 'message-1', slug: null, title: 'Review required', description: '# Original\n\n**Markdown**',
    recommended_action: 'Review the proposal', category: 'approval', severity: 'info',
    status: 'open', attention: false, topics: ['topic-one'], relations: [],
    dedupe_key: null, created_by: 'agent', created_at: 10, updated_at: 20,
    resourceVersion: 1, ...extra,
  };
}

describe('canonical AgentMessage view models', () => {
  it('preserves Markdown, canonical categories, lifecycle and object relations', () => {
    const original = message({
      relations: [{ kind: 'Workstream', id: 'ws-id' }], provenance: { agent: 'reviewer' },
      decision: { outcome: 'approved', decided_by: 'human', reason: 'Reviewed the design', decided_at: 15 },
    });
    const vm = toAgentMessageVM(original);
    expect(vm).toMatchObject({
      description: original.description, recommendedAction: original.recommended_action,
      category: 'approval', status: 'open', severity: 'info', attention: false,
      relations: [{ kind: 'Workstream', id: 'ws-id' }], provenance: { agent: 'reviewer' },
      decision: { outcome: 'approved', decided_by: 'human', reason: 'Reviewed the design', decided_at: 15 },
      createdAt: 10, updatedAt: 20,
    });
    expect(vm.topics).not.toBe(original.topics);
    expect(vm.relations).not.toBe(original.relations);
  });
  it('scopes by topic slug and preserves old resolved history indefinitely', () => {
    const messages = [
      message({ id: 'resolved', status: 'resolved', updated_at: 1 }),
      message({ id: 'other', topics: ['different-topic'] }),
    ];
    expect(buildAgentMessageVMs(messages, ['topic-one'], Date.now())).toMatchObject([{ id: 'resolved', dimmed: true }]);
  });
  it('sorts open, acknowledged, resolved, then newest-first without mutating input', () => {
    const messages = [
      message({ id: 'resolved', status: 'resolved' }),
      message({ id: 'older', updated_at: 10 }),
      message({ id: 'ack', status: 'acknowledged' }),
      message({ id: 'newer', updated_at: 30 }),
    ];
    expect(buildAgentMessageVMs(messages, ['topic-one']).map((vm) => vm.id)).toEqual(['newer', 'older', 'ack', 'resolved']);
    expect(messages.map((item) => item.id)).toEqual(['resolved', 'older', 'ack', 'newer']);
  });
  it('derives a display title without rewriting the stored Markdown source', () => {
    const original = message({ title: ' ', description: '# Source title\n\nbody' });
    expect(toAgentMessageVM(original).title).toBe('# Source title');
    expect(original.title).toBe(' ');
    expect(original.description).toBe('# Source title\n\nbody');
  });
  it('counts only open explicit attention; informational completions never create badges', () => {
    const messages = [
      message({ id: 'human', attention: true }),
      message({ id: 'completion', category: 'completion' }),
      message({ id: 'ack', status: 'acknowledged', attention: true }),
      message({ id: 'resolved', status: 'resolved', attention: true }),
      message({ id: 'other', attention: true, topics: ['other'] }),
    ];
    expect(agentMessageBubbleForTopic(messages, 'topic-one')).toEqual({ count: 1, severity: 'info' });
  });
  it('deduplicates cross-topic attention and chooses canonical maximum severity', () => {
    const shared = message({ id: 'shared', attention: true, severity: 'warning', topics: ['topic-one', 'topic-two'] });
    const messages = [shared, shared, message({ id: 'error', attention: true, severity: 'error', topics: ['topic-two'] })];
    expect(agentMessageBubbleForTopics(messages, ['topic-one', 'topic-two'])).toEqual({ count: 2, severity: 'error' });
    expect(agentMessageBubbleForTopic(messages, 'missing')).toEqual({ count: 0, severity: null });
  });
  it('keeps canonical message history rows and same-id native routes, including resolved records', () => {
    const panel = buildAgentMessagesPanel({
      available: true,
      agentMessages: [message({ id: 'resolved', status: 'resolved' }), message({ id: 'request', attention: true })],
    });
    expect(panel.tab).toBe('agent-messages');
    expect(panel.items.map((row) => row.kind)).toEqual(['agent-message', 'agent-message']);
    expect(panel.items.map((row) => row.id)).toEqual(['agent-message:request', 'agent-message:resolved']);
    expect(panel.items[0].openUri).toContain('/agent-message/request');
  });
  it('uses canonical attention summaries in both topic panels and workstream trees', () => {
    const topic: Topic = {
      id: 'topic-id', slug: 'topic-one', title: 'Topic', body: '', status: 'open',
      topicType: 'feature', parents: [], workstreams: ['workstream'], focusedWorkstreams: [],
      created_at: 10, updated_at: 20, resourceVersion: 1,
    };
    const messages = [
      message({ id: 'error', attention: true, severity: 'error' }),
      message({ id: 'done', category: 'completion', attention: false }),
    ];
    const panel = buildTopicsPanel({ available: true, topics: [topic], agentMessages: messages });
    expect(panel.items[0]).toMatchObject({ agentMessageCount: 1, agentMessageSeverity: 'error' });
    const tree = buildWorkstreamTree('ws-id', 'workstream', 'active', [topic], new Map(), messages);
    expect(tree.groups[0].children[0]).toMatchObject({ agentMessageCount: 1, agentMessageSeverity: 'error' });
    expect(topic.status).toBe('open');
  });
});
