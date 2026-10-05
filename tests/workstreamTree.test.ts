/**
 * Focused unit test for the shared workstream-tree composition
 * (`buildWorkstreamTree` in shared/panelData.ts) — the SAME structure the left
 * rail's workstream card renders and the Svelte workstream editor mirrors below
 * its flat topics list. Covers parent→child topic nesting and membership.
 */

import { describe, test, expect } from 'vitest';
import { buildWorkstreamTree } from '../shared/panelData';
import type { Topic, TopicType } from '../shared/controlPlaneClient';

function topic(partial: Partial<Topic> & { slug: string; title: string }): Topic {
  return {
    id: `id-${partial.slug}`,
    body: '',
    status: 'open',
    topicType: 'feature',
    parents: [],
    workstreams: [],
    focusedWorkstreams: [],
    created_at: 0,
    updated_at: 0,
    resourceVersion: 1,
    ...partial,
  };
}

describe('buildWorkstreamTree', () => {
  const topics: Topic[] = [
    topic({ slug: 'parent', title: 'Parent', workstreams: ['ws'] }),
    topic({ slug: 'child', title: 'Child', parents: ['parent'], workstreams: ['ws'] }),
    // Not a member of this workstream — must be excluded.
    topic({ slug: 'other', title: 'Other', workstreams: ['ws-2'] }),
  ];


  const tree = buildWorkstreamTree(
    'ws-id',
    'ws',
    'active',
    topics,
    new Map(),
    [],
  );

  test('nests child topics under their in-set parent', () => {
    const topicsGroup = tree.groups[0];
    expect(topicsGroup.kind).toBe('topics-group');
    expect(topicsGroup.label).toBe('Topics (2)');
    // Only the parentless member is a root.
    expect(topicsGroup.children).toHaveLength(1);
    const parent = topicsGroup.children[0];
    expect(parent.kind).toBe('topic');
    expect(parent.label).toBe('Parent');
    const childTopic = (parent.children ?? []).find((c) => c.kind === 'topic');
    expect(childTopic?.label).toBe('Child');
  });

  test('excludes topics that are not members of the workstream', () => {
    const topicsGroup = tree.groups[0];
    const labels = topicsGroup.children.map((c) => c.label);
    expect(labels).not.toContain('Other');
  });

  test('retains closed members but includes only open focused topics in the pinned strip', () => {
    const typeMap = new Map<string, TopicType>([
      ['feature', {
        id: 'type-feature',
        slug: 'feature',
        label: 'Feature',
        icon: 'lightbulb',
        description: '',
        body_template: '',
        created_at: 0,
        updated_at: 0,
        resourceVersion: 1,
      }],
    ]);
    const activeTree = buildWorkstreamTree(
      'ws-id',
      'ws',
      'active',
      [
        topic({ slug: 'closed-focused', title: 'Closed focused', status: 'closed', workstreams: ['ws'], focusedWorkstreams: ['ws'] }),
        topic({ slug: 'open-focused', title: 'Open focused', workstreams: ['ws'], focusedWorkstreams: ['ws'] }),
      ],
      typeMap,
      [],
    );

    const topicsGroup = activeTree.groups[0];
    expect(topicsGroup.label).toBe('Topics (2)');
    expect(topicsGroup.children.map((child) => child.label)).toEqual([
      'Closed focused',
      'Open focused',
    ]);
    expect(activeTree.focusedTopics.map((focused) => focused.label)).toEqual(['Open focused']);
    expect(activeTree.focusedTopics[0].icon).toBe('lightbulb');
  });
});
