import { describe, expect, it } from 'vitest';
import type { Alert, Topic, TopicType, Workstream } from '../../src/controlPlaneClient';
import {
  chooseWorkstream,
  loadActivePanelData,
  loadWorkstreamViewModel,
  localWorkstreamQuery,
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
    const alert: Alert = {
      id: 'alert-1', slug: null, title: 'Verify desktop', description: 'Links must work',
      recommended_action: 'Click a topic', status: 'alert', topics: [topic.slug!],
      dedupe_key: null, created_by: 'test', created_at: 1, updated_at: 10, resourceVersion: 1,
    };
    const client = {
      wsRead: async () => [roadmap],
      topicRead: async () => [topic],
      naniteRead: async () => [],
      naniteTemplateRead: async () => [],
      topicTypeRead: async () => [topicType],
      alertRead: async () => [alert],
    } as never;

    const vm = await loadWorkstreamViewModel(client, roadmap.slug!, 10_000);

    expect(vm?.editable).toBe(true);
    expect(vm?.alerts).toMatchObject([{ id: 'alert-1', status: 'alert' }]);
    expect(vm?.tree[0].children[0]).toMatchObject({
      kind: 'topic', slug: 'desktop-parity', icon: 'rocket', pinned: true,
      alertCount: 1, alertSeverity: 'alert',
    });
  });

  it('maps the shared Active panel sections, nested topics, focus, and alerts', async () => {
    const topic: Topic = {
      id: 'topic-1', slug: 'desktop-parity', title: 'Desktop parity', body: '', status: 'open',
      topicType: 'feature', parents: [], workstreams: [roadmap.slug!],
      focusedWorkstreams: [roadmap.slug!], created_at: 1, updated_at: 2, resourceVersion: 3,
    };
    const alert: Alert = {
      id: 'alert-1', slug: null, title: 'Verify desktop', description: 'Links must work',
      recommended_action: 'Click a topic', status: 'alert', topics: [topic.slug!],
      dedupe_key: null, created_by: 'test', created_at: 1, updated_at: 10, resourceVersion: 1,
    };
    const client = {
      wsRead: async () => [roadmap], topicRead: async () => [topic], alertRead: async () => [alert],
      topicTypeRead: async () => [], naniteRead: async () => [], naniteTemplateRead: async () => [],
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
        alertCount: 1,
        focused_topics: [{ label: 'Desktop parity', focused: true }],
        children: [{ children: [{ kind: 'topic', label: 'Desktop parity', alertCount: 1 }] }],
      }],
    });
  });

  it('decodes Active rail document routes and rejects non-document routes', () => {
    expect(resolveDesktopResourceUri('working-memory:/topic/desktop%20parity.working-memory')).toEqual({
      kind: 'topic', identifier: 'desktop parity',
    });
    expect(resolveDesktopResourceUri('https://example.com/topic/desktop-parity')).toBeNull();
  });

  it('routes visible workstream actions and rejects unsupported commands', () => {
    expect(resolveDesktopAction(
      'working-memory.setWorkstreamSection',
      [{ slug: roadmap.slug, section: 'progress' }],
      roadmap.slug!,
    )).toEqual({ kind: 'workstream', operation: 'move', slug: roadmap.slug, section: 'progress' });
    expect(resolveDesktopAction('workingMemory.nanite.restart', [{ id: 'nanite-1' }], roadmap.slug!))
      .toEqual({ kind: 'nanite', operation: 'restart', id: 'nanite-1' });
    expect(resolveDesktopAction(
      'workingMemory.topic.removeFromWorkstream',
      [{ topicSlug: 'desktop-parity' }],
      roadmap.slug!,
    )).toEqual({
      kind: 'topic', operation: 'detach', slug: 'desktop-parity', workstream: roadmap.slug,
    });
    expect(() => resolveDesktopAction('workingMemory.unknown', [], roadmap.slug!))
      .toThrow('Unsupported desktop action');
  });
});