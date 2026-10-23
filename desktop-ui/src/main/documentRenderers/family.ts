/**
 * Pure builder for a topic's hierarchical "family" — the unified ancestor +
 * self + descendant tree rendered under the topic export's `## Family`
 * section (WM 13.0.2 `feature-family-tree-display`).
 *
 * This file is I/O-free and a pure function of already-fetched topic data
 * (id / title / parents triples). The graph-walking (bounded parent walk
 * upward, reverse-children lookup downward, cycle + depth guards) lives here so
 * it can be unit-tested directly; the caller fetches the topic neighborhood
 * and the pure renderer (`renderTopicDocument`) walks the returned tree.
 *
 * The result is a single unified display tree: the top-most ancestors are the
 * roots, nesting descends through intermediate ancestors to the CURRENT node
 * (flagged `isCurrent`), and the current node's own descendants nest below it.
 * `parents` is a flat id array (a DAG), so a topic reachable via two parent
 * paths is expanded once per path — bounded by a per-path visited set and a
 * depth cap so a cycle can never loop forever.
 */

/** A resolved node in the unified family display tree. */
export interface FamilyNode {
  /** The topic id (used to build the deep link). */
  id: string;
  /** The friendly title; falls back to the id for a dangling ref. */
  title: string;
  /** True for the topic whose doc is being rendered (the focus node). */
  isCurrent: boolean;
  /** Nested tree children (ancestors nest toward current; descendants below). */
  children: FamilyNode[];
}

/** The minimal topic shape the family builder needs (id / title / parents). */
export interface FamilyTopic {
  id: string;
  title: string;
  parents: string[];
}

/** Guard against runaway depth on either the ancestor walk or the descendant walk. */
const DEFAULT_MAX_DEPTH = 20;

/**
 * Build the unified family display tree for `currentId`.
 *
 * - Ancestors: walk `parents` upward, grafting the current node (and its
 *   descendants) at the bottom so the top-most ancestor is the root.
 * - Descendants: reverse lookup over `topics` whose `parents` include a given
 *   id, nested downward.
 *
 * A topic with no parents and no children yields a single-node tree (just the
 * current node). Cycles and over-deep chains are cut by a per-path visited set
 * plus `maxDepth`. Titles resolve from `topics`; a id with no matching topic
 * (dangling ref) falls back to the id itself so links never break.
 */
export function buildFamilyTree(
  currentId: string,
  currentTitle: string,
  topics: FamilyTopic[],
  currentParents: string[],
  maxDepth: number = DEFAULT_MAX_DEPTH,
): FamilyNode[] {
  const byId = new Map<string, FamilyTopic>();
  for (const t of topics) {
    byId.set(t.id, t);
  }

  // Reverse adjacency: parent id → child topics (dedup by child id).
  const childrenById = new Map<string, FamilyTopic[]>();
  for (const t of topics) {
    for (const p of t.parents) {
      const arr = childrenById.get(p) ?? [];
      if (!arr.some((c) => c.id === t.id)) {
        arr.push(t);
      }
      childrenById.set(p, arr);
    }
  }

  const titleOf = (id: string): string =>
    id === currentId ? currentTitle : byId.get(id)?.title ?? id;

  const parentsOf = (id: string): string[] =>
    id === currentId ? currentParents : byId.get(id)?.parents ?? [];

  const buildDescendants = (
    id: string,
    visited: Set<string>,
    depth: number,
  ): FamilyNode[] => {
    if (depth >= maxDepth) {
      return [];
    }
    const kids = (childrenById.get(id) ?? [])
      .filter((k) => !visited.has(k.id))
      .sort((a, b) => titleOf(a.id).localeCompare(titleOf(b.id)));
    return kids.map((k) => ({
      id: k.id,
      title: titleOf(k.id),
      isCurrent: false,
      children: buildDescendants(
        k.id,
        new Set(visited).add(k.id),
        depth + 1,
      ),
    }));
  };

  const currentNode: FamilyNode = {
    id: currentId,
    title: currentTitle,
    isCurrent: true,
    children: buildDescendants(currentId, new Set([currentId]), 0),
  };

  // Climb upward from `id` (a parent grafted directly above `downNode`),
  // returning the top-most ancestor roots for that branch.
  const climb = (
    id: string,
    downNode: FamilyNode,
    visited: Set<string>,
    depth: number,
  ): FamilyNode[] => {
    const node: FamilyNode = {
      id,
      title: titleOf(id),
      isCurrent: false,
      children: [downNode],
    };
    if (depth >= maxDepth) {
      return [node];
    }
    const grandparents = dedupeParents(parentsOf(id), visited);
    if (grandparents.length === 0) {
      return [node];
    }
    const roots: FamilyNode[] = [];
    for (const gp of grandparents) {
      roots.push(...climb(gp, node, new Set(visited).add(id), depth + 1));
    }
    return roots;
  };

  const directParents = dedupeParents(
    parentsOf(currentId),
    new Set([currentId]),
  );
  if (directParents.length === 0) {
    return [currentNode];
  }
  const roots: FamilyNode[] = [];
  for (const p of directParents) {
    roots.push(...climb(p, currentNode, new Set([currentId]), 1));
  }
  return roots;
}

/** Drop self-references, already-visited ids (cycle guard), and duplicates. */
function dedupeParents(parents: string[], visited: Set<string>): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const p of parents) {
    if (typeof p !== 'string' || p.length === 0) {
      continue;
    }
    if (visited.has(p) || seen.has(p)) {
      continue;
    }
    seen.add(p);
    out.push(p);
  }
  return out;
}
