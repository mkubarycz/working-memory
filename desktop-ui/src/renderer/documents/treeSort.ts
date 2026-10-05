/**
 * Pure, render-time ordering for the workstream tree's sibling lists. Kept
 * framework-agnostic so it can be unit-tested without mounting Svelte.
 *
 * Ordering intent (primary → secondary): pinned topics first, then open topics,
 * then closed topics last, so completed work recedes to the bottom of each
 * sibling group. The sort is STABLE: ties preserve the incoming order, and it
 * never mutates the input array.
 */

import type { TreeTopicVM } from './types';

export type TreeChild = TreeTopicVM;

/**
 * Lower rank sorts earlier.
 */
export function topicSortRank(node: TreeChild): number {
  const closed = node.status === 'closed';
  if (node.pinned) {
    return closed ? 1 : 0;
  }
  return closed ? 3 : 2;
}

/** New array ordered pinned-first → open → closed-last, stable within tiers. */
export function sortTreeChildren(children: TreeChild[]): TreeChild[] {
  return children
    .map((node, index) => ({ node, index }))
    .sort((a, b) => topicSortRank(a.node) - topicSortRank(b.node) || a.index - b.index)
    .map((entry) => entry.node);
}
