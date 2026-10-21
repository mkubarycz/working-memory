import { describe, expect, it } from 'vitest';
import type { AgentMessage, Topic, TopicType, Workstream } from '../../shared/controlPlaneClient';
import {
  chooseWorkstream,
  loadActivePanelData,
  loadTopicViewModel,
  loadWorkstreamViewModel,
  localWorkstreamQuery,
  persistWorkstreamReorder,
  resolveDesktopAction,
  resolveDesktopResourceUri,
} from '../src/main/resolver';

const roadmap: Workstream = {
  id: '1',
  slug: 'working-memory-0-15-0',
  title: 'Working Memory 0.15.0',
  status: 'queue',
  closure: null,
  opened_at: 1,
  updated_at: 1,
  closed_at: null,
  resourceVersion: 1,
};

describe('workstream resolver', () => {
  it('extracts a deterministic query from a navigation request', () => {
    expect(localWorkstreamQuery('Show me the 0.15.0 roadmap workstream')).toBe('0.15.0 roadmap');
  });

  it('matches a workstream when all meaningful query tokens are present', () => {
    const genericRoadmap = { ...roadmap, id: '2', slug: 'product-roadmap', title: 'Product Roadmap' };
    expect(chooseWorkstream('0.15.0 roadmap', [genericRoadmap, roadmap])).toBe(roadmap);
  });

  it('loads the shared workstream tree, alerts, icons, and focus state', async () => {
    const topic: Topic = {
      id: 'topic-1', slug: 'desktop-parity', title: 'Desktop parity', body: '', status: 'open',
      topicType: 'feature', parents: [], workstreams: [roadmap.slug!],
      focusedWorkstreams: [roadmap.slug!], created_at: 1, updated_at: 2, resourceVersion: 3,
    };
    const topicType: TopicType = {
      id: 'type-1', slug: 'feature', label: 'Feature', description: '', icon: 'rocket', body_template: '',
      created_at: 1, updated_at: 1, resourceVersion: 1,
    };
    const alert: AgentMessage = {
      id: 'alert-1', slug: null, title: 'Verify desktop', description: 'Links must work',
      recommended_action: 'Click a topic', status: 'open', topics: [topic.slug!],
      category: 'request', severity: 'warning', attention: true, relations: [],
      dedupe_key: null, created_by: 'test', created_at: 1, updated_at: 10, resourceVersion: 1,
    };
    const client = {
      wsRead: async () => [roadmap],
      topicRead: async () => [topic],
      topicTypeRead: async () => [topicType],
      agentMessageRead: async () => [alert],
    } as never;

    const vm = await loadWorkstreamViewModel(client, roadmap.slug!, 10_000);

    expect(vm?.editable).toBe(true);
    expect(vm?.agentMessages).toMatchObject([{ id: 'alert-1', status: 'open' }]);
    expect(vm?.tree[0].children[0]).toMatchObject({
      kind: 'topic', slug: 'desktop-parity', icon: 'rocket', pinned: true,
      agentMessageCount: 1, agentMessageSeverity: 'warning',
    });
  });

  it('maps the shared Active panel sections, nested topics, focus, and alerts', async () => {
    const topic: Topic = {
      id: 'topic-1', slug: 'desktop-parity', title: 'Desktop parity', body: '', status: 'open',
      topicType: 'feature', parents: [], workstreams: [roadmap.slug!],
      focusedWorkstreams: [roadmap.slug!], created_at: 1, updated_at: 2, resourceVersion: 3,
    };
    const closedTopic: Topic = {
      ...topic,
      id: 'topic-closed',
      slug: 'completed-desktop-work',
      title: 'Completed desktop work',
      status: 'closed',
      focusedWorkstreams: [roadmap.slug!],
    };
    const alert: AgentMessage = {
      id: 'alert-1', slug: null, title: 'Verify desktop', description: 'Links must work',
      recommended_action: 'Click a topic', status: 'open', topics: [topic.slug!],
      category: 'request', severity: 'warning', attention: true, relations: [],
      dedupe_key: null, created_by: 'test', created_at: 1, updated_at: 10, resourceVersion: 1,
    };
    const client = {
      wsRead: async () => [roadmap], topicRead: async () => [topic, closedTopic], agentMessageRead: async () => [alert],
      topicTypeRead: async () => [],
    } as never;

    const active = await loadActivePanelData(client);
    const queue = active.items[0];

    expect(active.tab).toBe('active');
    expect(active.items.map((item) => item.kind === 'workstream-section' ? item.section : '')).toEqual([
      'queue', 'progress', 'backlog',
    ]);
    expect(queue).toMatchObject({
      kind: 'workstream-section',
      workstreams: [{
        slug: roadmap.slug,
        agentMessageCount: 1,
        focused_topics: [{ label: 'Desktop parity', focused: true }],
        children: [{ children: [
          { kind: 'topic', label: 'Desktop parity', agentMessageCount: 1 },
          { kind: 'topic', label: 'Completed desktop work', status: 'closed', focused: true },
        ] }],
      }],
    });
  });

  it('orders Active workstreams by their persisted section position', async () => {
    const client = {
      wsRead: async () => [
        { ...roadmap, slug: 'later', title: 'Later', position: 20 },
        { ...roadmap, slug: 'first', title: 'First', position: 5 },
      ],
      topicRead: async () => [], agentMessageRead: async () => [], topicTypeRead: async () => [],
    } as never;

    const active = await loadActivePanelData(client);
    const queue = active.items[0];
    expect(queue.kind === 'workstream-section' && queue.workstreams.map((item) => item.slug))
      .toEqual(['first', 'later']);
  });

  it('persists normalized section and position updates atomically', async () => {
    const writes: unknown[] = [];
    const client = { wsReorder: async (input: unknown) => { writes.push(input); } } as never;
    await persistWorkstreamReorder(client, [
      { slug: 'one', section: 'queue', position: 0 },
      { slug: 'two', section: 'queue', position: 1 },
    ]);
    expect(writes).toEqual([{ updates: [
      { slug: 'one', status: 'queue', position: 0 },
      { slug: 'two', status: 'queue', position: 1 },
    ] }]);
    await expect(persistWorkstreamReorder(client, [
      { slug: '', section: 'queue', position: 0 },
    ])).rejects.toThrow('Invalid workstream reorder request');
  });

  it('decodes Active rail document routes and rejects non-document routes', () => {
    expect(resolveDesktopResourceUri('working-memory:/topic/desktop%20parity.working-memory')).toEqual({
      kind: 'topic', identifier: 'desktop parity',
    });
    expect(resolveDesktopResourceUri('https://example.com/topic/desktop-parity')).toBeNull();
  });

  it('loads UUID-related messages into exact topic/workstream callouts and relation badges', async () => {
      const topic: Topic = {
        id: 'topic-uuid', slug: 'scoped-topic', title: 'Scoped topic', body: '', status: 'open',
        topicType: 'feature', parents: [], workstreams: [roadmap.slug!], focusedWorkstreams: [],
        created_at: 1, updated_at: 2, resourceVersion: 1,
      };
      const base: AgentMessage = {
        id: 'topic-message', slug: null, title: 'Review', description: 'Review', recommended_action: '',
        category: 'approval', severity: 'warning', attention: true, status: 'open', topics: [],
        relations: [{ kind: 'Topic', id: topic.id }], dedupe_key: null, created_by: 'agent',
        created_at: 1, updated_at: 2, resourceVersion: 1,
      };
      const client = {
        wsRead: async () => [roadmap], topicRead: async () => [topic], topicTypeRead: async () => [],
        agentMessageRead: async () => [
          base,
          { ...base, id: 'ws-message', relations: [{ kind: 'Workstream', id: roadmap.id }] },
          { ...base, id: 'other-message', relations: [{ kind: 'Topic', id: 'other-uuid' }] },
        ],
      } as never;
      const topicVm = await loadTopicViewModel(client, topic.slug!);
      expect(topicVm?.id).toBe(topic.id);
      expect(topicVm?.agentMessages.map((item) => item.id)).toEqual(['topic-message']);
      expect(topicVm?.workstreams).toMatchObject([{ agentMessageCount: 2, agentMessageSeverity: 'warning' }]);
      const workstreamVm = await loadWorkstreamViewModel(client, roadmap.slug!);
      expect(workstreamVm?.id).toBe(roadmap.id);
      expect(workstreamVm?.topics[0].id).toBe(topic.id);
      expect(workstreamVm?.tree[0].children[0].documentId).toBe(topic.id);
      expect(workstreamVm?.agentMessages.map((item) => item.id)).toEqual(['topic-message', 'ws-message']);
      expect(workstreamVm?.tree[0].children[0]).toMatchObject({ agentMessageCount: 1, agentMessageSeverity: 'warning' });
  });

  it('routes visible workstream actions and rejects unsupported commands', () => {
    expect(resolveDesktopAction(
      'working-memory.setWorkstreamSection',
      [{ slug: roadmap.slug, section: 'progress' }],
      roadmap.slug!,
    )).toEqual({ kind: 'workstream', operation: 'move', slug: roadmap.slug, section: 'progress' });
    expect(resolveDesktopAction(
      'workingMemory.topic.removeFromWorkstream',
      [{ topicSlug: 'desktop-parity' }],
      roadmap.slug!,
    )).toEqual({
      kind: 'topic', operation: 'detach', slug: 'desktop-parity', workstream: roadmap.slug,
    });
    expect(resolveDesktopAction(
      'workingMemory.topic.transfer',
      [{ topicSlug: 'desktop-parity', sourceWorkstream: 'source', move: true }],
      roadmap.slug!,
    )).toEqual({
      kind: 'topic', operation: 'transfer', slug: 'desktop-parity',
      sourceWorkstream: 'source', targetWorkstream: roadmap.slug, move: true,
    });
    expect(() => resolveDesktopAction('workingMemory.unknown', [], roadmap.slug!))
      .toThrow('Unsupported desktop action');
  });
});