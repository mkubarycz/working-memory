/**
 * Pure builder for a topic's hierarchical "family" — the unified ancestor +
 * self + descendant tree rendered under the topic virtual doc's `## Family`
 * section (WM 13.0.2 `feature-family-tree-display`).
 *
 * This file is I/O-free and a pure function of already-fetched topic data
 * (slug / title / parents triples). The graph-walking (bounded parent walk
 * upward, reverse-children lookup downward, cycle + depth guards) lives here so
 * it can be unit-tested directly; the content provider fetches the topic
 * neighborhood and the pure renderer (`renderTopicDocument`) walks the returned
 * tree.
 *
 * The result is a single unified display tree: the top-most ancestors are the
 * roots, nesting descends through intermediate ancestors to the CURRENT node
 * (flagged `isCurrent`), and the current node's own descendants nest below it.
 * `parents` is a flat slug array (a DAG), so a topic reachable via two parent
 * paths is expanded once per path — bounded by a per-path visited set and a
 * depth cap so a cycle can never loop forever.
 */

/** A resolved node in the unified family display tree. */
export interface FamilyNode {
  /** The topic slug (used to build the deep link). */
  slug: string;
  /** The friendly title; falls back to the slug for a dangling ref. */
  title: string;
  /** True for the topic whose doc is being rendered (the focus node). */
  isCurrent: boolean;
  /** Nested tree children (ancestors nest toward current; descendants below). */
  children: FamilyNode[];
}

/** The minimal topic shape the family builder needs (slug / title / parents). */
export interface FamilyTopic {
  slug: string;
  title: string;
  parents: string[];
}

/** Guard against runaway depth on either the ancestor walk or the descendant walk. */
const DEFAULT_MAX_DEPTH = 20;

/**
 * Build the unified family display tree for `currentSlug`.
 *
 * - Ancestors: walk `parents` upward, grafting the current node (and its
 *   descendants) at the bottom so the top-most ancestor is the root.
 * - Descendants: reverse lookup over `topics` whose `parents` include a given
 *   slug, nested downward.
 *
 * A topic with no parents and no children yields a single-node tree (just the
 * current node). Cycles and over-deep chains are cut by a per-path visited set
 * plus `maxDepth`. Titles resolve from `topics`; a slug with no matching topic
 * (dangling ref) falls back to the slug itself so links never break.
 */
export function buildFamilyTree(
  currentSlug: string,
  currentTitle: string,
  topics: FamilyTopic[],
  currentParents: string[],
  maxDepth: number = DEFAULT_MAX_DEPTH,
): FamilyNode[] {
  const bySlug = new Map<string, FamilyTopic>();
  for (const t of topics) {
    bySlug.set(t.slug, t);
  }

  // Reverse adjacency: parent slug → child topics (dedup by child slug).
  const childrenBySlug = new Map<string, FamilyTopic[]>();
  for (const t of topics) {
    for (const p of t.parents) {
      const arr = childrenBySlug.get(p) ?? [];
      if (!arr.some((c) => c.slug === t.slug)) {
        arr.push(t);
      }
      childrenBySlug.set(p, arr);
    }
  }

  const titleOf = (slug: string): string =>
    slug === currentSlug ? currentTitle : bySlug.get(slug)?.title ?? slug;

  const parentsOf = (slug: string): string[] =>
    slug === currentSlug ? currentParents : bySlug.get(slug)?.parents ?? [];

  const buildDescendants = (
    slug: string,
    visited: Set<string>,
    depth: number,
  ): FamilyNode[] => {
    if (depth >= maxDepth) {
      return [];
    }
    const kids = (childrenBySlug.get(slug) ?? [])
      .filter((k) => !visited.has(k.slug))
      .sort((a, b) => titleOf(a.slug).localeCompare(titleOf(b.slug)));
    return kids.map((k) => ({
      slug: k.slug,
      title: titleOf(k.slug),
      isCurrent: false,
      children: buildDescendants(
        k.slug,
        new Set(visited).add(k.slug),
        depth + 1,
      ),
    }));
  };

  const currentNode: FamilyNode = {
    slug: currentSlug,
    title: currentTitle,
    isCurrent: true,
    children: buildDescendants(currentSlug, new Set([currentSlug]), 0),
  };

  // Climb upward from `slug` (a parent grafted directly above `downNode`),
  // returning the top-most ancestor roots for that branch.
  const climb = (
    slug: string,
    downNode: FamilyNode,
    visited: Set<string>,
    depth: number,
  ): FamilyNode[] => {
    const node: FamilyNode = {
      slug,
      title: titleOf(slug),
      isCurrent: false,
      children: [downNode],
    };
    if (depth >= maxDepth) {
      return [node];
    }
    const grandparents = dedupeParents(parentsOf(slug), visited);
    if (grandparents.length === 0) {
      return [node];
    }
    const roots: FamilyNode[] = [];
    for (const gp of grandparents) {
      roots.push(...climb(gp, node, new Set(visited).add(slug), depth + 1));
    }
    return roots;
  };

  const directParents = dedupeParents(
    parentsOf(currentSlug),
    new Set([currentSlug]),
  );
  if (directParents.length === 0) {
    return [currentNode];
  }
  const roots: FamilyNode[] = [];
  for (const p of directParents) {
    roots.push(...climb(p, currentNode, new Set([currentSlug]), 1));
  }
  return roots;
}

/** Drop self-references, already-visited slugs (cycle guard), and duplicates. */
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
