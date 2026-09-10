import { describe, expect, it } from 'vitest';
import {
  setNodeAndChildrenExpanded,
  setSubtreeExpanded,
  type ExpandableTreeNode,
} from '../src/renderer/treeExpansion';

const tree: ExpandableTreeNode = {
  id: 'workstream',
  children: [
    {
      id: 'topics-group',
      children: [
        {
          id: 'parent-topic',
          children: [{ id: 'child-topic', children: [{ id: 'nanite' }] }],
        },
      ],
    },
  ],
};

describe('setSubtreeExpanded', () => {
  it('expands every descendant of a workstream', () => {
    const expanded = new Set<string>();

    setSubtreeExpanded(expanded, tree, true);

    expect([...expanded]).toEqual([
      'workstream',
      'topics-group',
      'parent-topic',
      'child-topic',
      'nanite',
    ]);
  });

  it('collapses the entire subtree without disturbing unrelated state', () => {
    const expanded = new Set(['other', 'workstream', 'topics-group', 'parent-topic', 'child-topic']);

    setSubtreeExpanded(expanded, tree, false);

    expect([...expanded]).toEqual(['other']);
  });
});

describe('setNodeAndChildrenExpanded', () => {
  it('opens a workstream and its Topics group without expanding nested topic branches', () => {
    const expanded = new Set(['other']);

    setNodeAndChildrenExpanded(expanded, tree);

    expect([...expanded]).toEqual(['other', 'workstream', 'topics-group']);
  });
});