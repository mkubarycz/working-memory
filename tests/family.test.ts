/**
 * Unit tests for the pure family-tree builder (WM 13.0.2
 * `feature-family-tree-display`). No VS Code, no control-plane — a pure
 * function of injected slug/title/parents data. Covers the bounded parent walk
 * (ancestors), the reverse parent→child lookup (descendants), cycle + depth
 * guards, and the dangling-ref title fallback.
 */

import { describe, it, expect } from 'vitest';
import { buildFamilyTree } from '../src/documentRenderers/family';
import type { FamilyTopic } from '../src/documentRenderers/family';

/** Flatten the tree to `{slug,isCurrent,depth}` rows for easy assertions. */
function flatten(
  nodes: ReturnType<typeof buildFamilyTree>,
  depth = 0,
): { slug: string; title: string; isCurrent: boolean; depth: number }[] {
  const out: { slug: string; title: string; isCurrent: boolean; depth: number }[] =
    [];
  for (const n of nodes) {
    out.push({ slug: n.slug, title: n.title, isCurrent: n.isCurrent, depth });
    out.push(...flatten(n.children, depth + 1));
  }
  return out;
}

describe('buildFamilyTree', () => {
  it('returns a single current-only node when there are no parents or children', () => {
    const tree = buildFamilyTree('solo', 'Solo', [], []);
    expect(flatten(tree)).toEqual([
      { slug: 'solo', title: 'Solo', isCurrent: true, depth: 0 },
    ]);
  });

  it('walks parents upward so the top ancestor is the root and current is deepest', () => {
    const topics: FamilyTopic[] = [
      { slug: 'grandparent', title: 'Grandparent', parents: [] },
      { slug: 'parent', title: 'Parent', parents: ['grandparent'] },
      { slug: 'current', title: 'Current', parents: ['parent'] },
    ];
    const tree = buildFamilyTree('current', 'Current', topics, ['parent']);
    expect(flatten(tree)).toEqual([
      { slug: 'grandparent', title: 'Grandparent', isCurrent: false, depth: 0 },
      { slug: 'parent', title: 'Parent', isCurrent: false, depth: 1 },
      { slug: 'current', title: 'Current', isCurrent: true, depth: 2 },
    ]);
  });

  it('nests descendants below the current node via the reverse parent lookup', () => {
    const topics: FamilyTopic[] = [
      { slug: 'current', title: 'Current', parents: [] },
      { slug: 'child-b', title: 'Child B', parents: ['current'] },
      { slug: 'child-a', title: 'Child A', parents: ['current'] },
      { slug: 'grandchild', title: 'Grandchild', parents: ['child-a'] },
    ];
    const tree = buildFamilyTree('current', 'Current', topics, []);
    // Children are sorted by title, so Child A precedes Child B.
    expect(flatten(tree)).toEqual([
      { slug: 'current', title: 'Current', isCurrent: true, depth: 0 },
      { slug: 'child-a', title: 'Child A', isCurrent: false, depth: 1 },
      { slug: 'grandchild', title: 'Grandchild', isCurrent: false, depth: 2 },
      { slug: 'child-b', title: 'Child B', isCurrent: false, depth: 1 },
    ]);
  });

  it('renders the full ancestor + current + descendant chain in one tree', () => {
    const topics: FamilyTopic[] = [
      { slug: 'parent', title: 'Parent', parents: [] },
      { slug: 'current', title: 'Current', parents: ['parent'] },
      { slug: 'child', title: 'Child', parents: ['current'] },
    ];
    const tree = buildFamilyTree('current', 'Current', topics, ['parent']);
    expect(flatten(tree)).toEqual([
      { slug: 'parent', title: 'Parent', isCurrent: false, depth: 0 },
      { slug: 'current', title: 'Current', isCurrent: true, depth: 1 },
      { slug: 'child', title: 'Child', isCurrent: false, depth: 2 },
    ]);
  });

  it('falls back to the slug as the label for a dangling parent ref', () => {
    // `ghost` is referenced as a parent but has no topic record.
    const topics: FamilyTopic[] = [
      { slug: 'current', title: 'Current', parents: ['ghost'] },
    ];
    const tree = buildFamilyTree('current', 'Current', topics, ['ghost']);
    const rows = flatten(tree);
    expect(rows[0]).toEqual({
      slug: 'ghost',
      title: 'ghost',
      isCurrent: false,
      depth: 0,
    });
  });

  it('breaks a parent cycle (current ↔ parent) without looping forever', () => {
    const topics: FamilyTopic[] = [
      { slug: 'current', title: 'Current', parents: ['loop'] },
      { slug: 'loop', title: 'Loop', parents: ['current'] },
    ];
    const tree = buildFamilyTree('current', 'Current', topics, ['loop']);
    const rows = flatten(tree);
    // Bounded (no infinite loop): the top ancestor is `loop`, `current` is the
    // focus node, and the back-edge is cut so the tree stays small.
    expect(rows.length).toBeLessThan(10);
    expect(rows[0]).toEqual({
      slug: 'loop',
      title: 'Loop',
      isCurrent: false,
      depth: 0,
    });
    expect(rows.some((r) => r.slug === 'current' && r.isCurrent)).toBe(true);
  });

  it('breaks a descendant cycle without looping forever', () => {
    const topics: FamilyTopic[] = [
      { slug: 'current', title: 'Current', parents: [] },
      { slug: 'a', title: 'A', parents: ['current', 'b'] },
      { slug: 'b', title: 'B', parents: ['a'] },
    ];
    const tree = buildFamilyTree('current', 'Current', topics, []);
    const slugs = flatten(tree).map((r) => r.slug);
    // The a↔b cycle is bounded — every slug appears, no infinite expansion.
    expect(slugs).toContain('a');
    expect(slugs).toContain('b');
    expect(slugs.length).toBeLessThan(10);
  });

  it('caps runaway ancestor depth at maxDepth', () => {
    // A long single-parent chain; cap the walk at depth 2.
    const topics: FamilyTopic[] = [
      { slug: 'g3', title: 'G3', parents: [] },
      { slug: 'g2', title: 'G2', parents: ['g3'] },
      { slug: 'g1', title: 'G1', parents: ['g2'] },
      { slug: 'current', title: 'Current', parents: ['g1'] },
    ];
    const tree = buildFamilyTree('current', 'Current', topics, ['g1'], 2);
    const slugs = flatten(tree).map((r) => r.slug);
    // Walk stops before reaching g3.
    expect(slugs).toContain('g1');
    expect(slugs).toContain('current');
    expect(slugs).not.toContain('g3');
  });
});
