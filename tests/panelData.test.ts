import { describe, expect, it } from 'vitest';
import type { Topic, Workstream } from '../shared/controlPlaneClient';
import { buildWorkstreamPanels } from '../shared/panelData';

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
