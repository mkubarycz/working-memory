/**
 * Focused unit test for the pure workstream-tree expansion helpers
 * (`defaultExpandedIds` / `cascadeExpandIds` in
 * webview-ui/src/lib/treeExpansion.ts). Verifies the default reveals only the
 * first level (groups expanded, topic subtrees collapsed) and that expanding a
 * node cascades exactly two additional levels of descendants.
 */

import { describe, test, expect } from 'vitest';
import {
  defaultExpandedIds,
  cascadeExpandIds,
  type ExpandableNode,
} from '../webview-ui/src/lib/treeExpansion';

// group → topic → child topic → grandchild topic → great-grandchild topic.
const greatGrandchild: ExpandableNode = { id: 'gg' };
const grandchild: ExpandableNode = { id: 'g', children: [greatGrandchild] };
const child: ExpandableNode = { id: 'c', children: [grandchild] };
const topic: ExpandableNode = { id: 't', children: [child] };
const group: ExpandableNode = { id: 'grp', children: [topic] };

describe('defaultExpandedIds', () => {
  test('expands only the top-level groups (first level visible, deeper collapsed)', () => {
    const groups: ExpandableNode[] = [
      { id: 'grp-1', children: [{ id: 't-1', children: [{ id: 'c-1' }] }] },
      { id: 'grp-2', children: [{ id: 't-2' }] },
    ];
    expect(defaultExpandedIds(groups)).toEqual(['grp-1', 'grp-2']);
  });
});

describe('cascadeExpandIds', () => {
  test('expanding a node opens exactly two more levels of descendants', () => {
    // Expanding `topic` marks: topic + its children + its grandchildren.
    // (Great-grandchildren are revealed but not themselves expanded.)
    expect(cascadeExpandIds(topic, 2)).toEqual(['t', 'c', 'g']);
  });

  test('stops at leaves when the subtree is shallower than the cascade', () => {
    const shallow: ExpandableNode = { id: 'a', children: [{ id: 'b' }] };
    expect(cascadeExpandIds(shallow, 2)).toEqual(['a', 'b']);
  });

  test('expanding a group cascades two levels beneath it', () => {
    expect(cascadeExpandIds(group, 2)).toEqual(['grp', 't', 'c']);
  });
});
