/**
 * Pure, render-time ordering for the workstream tree's sibling lists. Kept
 * framework-agnostic so it can be unit-tested without mounting Svelte.
 *
 * Ordering intent (primary → secondary): pinned topics first, then open topics,
 * then closed topics last, so completed work recedes to the bottom of each
 * sibling group. Nanites carry no status/pin, so they ride with the open tier
 * and — because a topic's runs live in that topic's own `children` — they stay
 * attached beneath their parent topic wherever it lands. The sort is STABLE:
 * ties preserve the incoming order, and it never mutates the input array.
 */

import type { TreeTopicVM, TreeNaniteVM } from './types';

export type TreeChild = TreeTopicVM | TreeNaniteVM;

/**
 * Lower rank sorts earlier. Only topics carry pin/closed distinctions; nanites
 * sit in the same tier as open topics so they keep their relative slot.
 */
export function topicSortRank(node: TreeChild): number {
  if (node.kind === 'topic') {
    const closed = node.status === 'closed';
    if (node.pinned) {
      return closed ? 1 : 0;
    }
    return closed ? 3 : 2;
  }
  return 2;
}

/** New array ordered pinned-first → open → closed-last, stable within tiers. */
export function sortTreeChildren(children: TreeChild[]): TreeChild[] {
  return children
    .map((node, index) => ({ node, index }))
    .sort((a, b) => topicSortRank(a.node) - topicSortRank(b.node) || a.index - b.index)
    .map((entry) => entry.node);
}
