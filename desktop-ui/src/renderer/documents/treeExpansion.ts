/**
 * Framework-agnostic expansion logic for the workstream tree, kept pure so it
 * can be unit-tested without mounting the Svelte component.
 *
 * Model: an EXPANDED set of node ids (absent = collapsed). Seeding the set to
 * just the top-level groups makes the first level of topics visible while every
 * deeper subtree stays collapsed by default.
 */

/** Minimal shape both group and topic view-models satisfy structurally. */
export interface ExpandableNode {
  id: string;
  children?: ExpandableNode[];
}

/**
 * Ids expanded by default: only the top-level groups. Expanding a group reveals
 * its direct children (the first level of topics); each topic's own subtree
 * stays collapsed until the user expands it.
 */
export function defaultExpandedIds(groups: ExpandableNode[]): string[] {
  return groups.map((group) => group.id);
}

/**
 * Ids to mark expanded when the user expands `node`: the node itself plus
 * `extraLevels` further levels of descendants. With `extraLevels = 2` a single
 * expand reveals the node's children, grandchildren, and great-grandchildren
 * (the node + its children + its grandchildren all become "expanded").
 */
export function cascadeExpandIds(node: ExpandableNode, extraLevels: number): string[] {
  const ids: string[] = [];
  const walk = (current: ExpandableNode, depth: number): void => {
    ids.push(current.id);
    if (depth >= extraLevels) {
      return;
    }
    for (const child of current.children ?? []) {
      walk(child, depth + 1);
    }
  };
  walk(node, 0);
  return ids;
}
