import { describe, expect, it } from 'vitest';
import type { AgentMessage, Topic, Workstream } from '../shared/controlPlaneClient';
import { buildAgentMessagesPanel, buildWorkstreamPanels } from '../shared/panelData';

function workstream(slug: string, status: Workstream['status']): Workstream {
  return {
    id: `id-${slug}`,
    slug,
    title: slug,
    status,
    closure: null,
    position: 0,
    opened_at: 1,
    updated_at: 1,
    closed_at: status === 'closed' ? 1 : null,
    resourceVersion: 1,
  };
}

function topic(slug: string, workstreams: string[], status: Topic['status'] = 'open'): Topic {
  return {
    id: `id-${slug}`,
    slug,
    title: slug,
    body: '',
    status,
    topicType: 'topic',
    parents: [],
    workstreams,
    focusedWorkstreams: [],
    created_at: 1,
    updated_at: 1,
    resourceVersion: 1,
  };
}

describe('active topic backlog', () => {
  it('includes open topics outside active workstreams', () => {
    const panels = buildWorkstreamPanels({
      available: true,
      workstreams: [
        workstream('active', 'progress'),
        workstream('archived', 'closed'),
      ],
      topics: [
        topic('assigned', ['active']),
        topic('unassigned', []),
        topic('archived-only', ['archived']),
        topic('missing-only', ['missing']),
        topic('partly-active', ['archived', 'active']),
        topic('closed-unassigned', [], 'closed'),
      ],
    });

    expect(panels.active.topicBacklog?.map((entry) => entry.label)).toEqual([
      'archived-only',
      'missing-only',
      'unassigned',
    ]);
  });
});

describe('canonical agent message panels', () => {
  const message: AgentMessage = {
    agent_id: 'agent-1', agent_name: 'Review Agent',
    id: 'message-1', slug: null, title: 'Review', description: '**Review**', recommended_action: 'Review PR',
    category: 'approval', severity: 'warning', status: 'open', attention: true, topics: ['one', 'two'],
    relations: [], dedupe_key: null, created_by: 'agent', created_at: 1, updated_at: 2, resourceVersion: 1,
  };

  it('deduplicates workstream attention badges and excludes acknowledged, resolved and non-attention records', () => {
    const panels = buildWorkstreamPanels({
      available: true,
      workstreams: [workstream('active', 'progress')],
      topics: [topic('one', ['active']), topic('two', ['active'])],
      agentMessages: [
        message, message,
        { ...message, id: 'ack', status: 'acknowledged', severity: 'error' },
        { ...message, id: 'resolved', status: 'resolved', severity: 'error' },
        { ...message, id: 'completion', category: 'completion', attention: false, severity: 'error' },
      ],
    });
    const progress = panels.active.items.find((item) => item.kind === 'workstream-section' && item.section === 'progress');
    expect(progress).toMatchObject({
      workstreams: [{ agentMessageCount: 1, agentMessageSeverity: 'warning' }],
    });
  });

  it('retains all lifecycle history with canonical same-id links', () => {
    const history = buildAgentMessagesPanel({
      available: true,
      agentMessages: [message, { ...message, id: 'old', status: 'resolved', updated_at: 1 }],
    });
    expect(history).toMatchObject({
      tab: 'agent-messages',
      items: [
        { kind: 'agent-message', status: 'open', category: 'approval', severity: 'warning', attention: true,
          openUri: 'working-memory:/agent-message/message-1.working-memory' },
        { kind: 'agent-message', status: 'resolved', openUri: 'working-memory:/agent-message/old.working-memory' },
      ],
    });

  });

  it('counts explicit Topic and Workstream UUID references only in their exact scopes', () => {
      const panels = buildWorkstreamPanels({
        available: true,
        workstreams: [workstream('active', 'progress'), workstream('other', 'progress')],
        topics: [topic('one', ['active']), topic('two', ['active']), topic('other-topic', ['other'])],
        agentMessages: [
          { ...message, id: 'topic-ref', topics: [], relations: [{ kind: 'Topic', id: 'id-one' }] },
          { ...message, id: 'ws-ref', topics: [], relations: [{ kind: 'Workstream', id: 'id-active' }] },
          { ...message, id: 'not-a-uuid', topics: [], relations: [{ kind: 'Topic', id: 'one' }] },
        ],
      });
      const progress = panels.active.items.find((item) => item.kind === 'workstream-section' && item.section === 'progress');
      expect(progress).toMatchObject({ workstreams: [
        { slug: 'active', agentMessageCount: 2, children: [{ children: [
          { label: 'one', agentMessageCount: 1 }, { label: 'two', agentMessageCount: 0 },
        ] }] },
        { slug: 'other', agentMessageCount: 0 },
      ] });
  });
});
