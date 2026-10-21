/**
 * Unit tests for the pure family-tree builder (WM 13.0.2
 * `feature-family-tree-display`). No VS Code, no control-plane — a pure
 * function of injected id/title/parents data. Covers the bounded parent walk
 * (ancestors), the reverse parent→child lookup (descendants), cycle + depth
 * guards, and the dangling-ref title fallback.
 */

import { describe, it, expect } from 'vitest';
import { buildFamilyTree } from '../src/main/documentRenderers/family';
import type { FamilyTopic } from '../src/main/documentRenderers/family';

/** Flatten the tree to `{id,isCurrent,depth}` rows for easy assertions. */
function flatten(
  nodes: ReturnType<typeof buildFamilyTree>,
  depth = 0,
): { id: string; title: string; isCurrent: boolean; depth: number }[] {
  const out: { id: string; title: string; isCurrent: boolean; depth: number }[] =
    [];
  for (const n of nodes) {
    out.push({ id: n.id, title: n.title, isCurrent: n.isCurrent, depth });
    out.push(...flatten(n.children, depth + 1));
  }
  return out;
}

describe('buildFamilyTree', () => {
  it('returns a single current-only node when there are no parents or children', () => {
    const tree = buildFamilyTree('solo', 'Solo', [], []);
    expect(flatten(tree)).toEqual([
      { id: 'solo', title: 'Solo', isCurrent: true, depth: 0 },
    ]);
  });

  it('walks parents upward so the top ancestor is the root and current is deepest', () => {
    const topics: FamilyTopic[] = [
      { id: 'grandparent', title: 'Grandparent', parents: [] },
      { id: 'parent', title: 'Parent', parents: ['grandparent'] },
      { id: 'current', title: 'Current', parents: ['parent'] },
    ];
    const tree = buildFamilyTree('current', 'Current', topics, ['parent']);
    expect(flatten(tree)).toEqual([
      { id: 'grandparent', title: 'Grandparent', isCurrent: false, depth: 0 },
      { id: 'parent', title: 'Parent', isCurrent: false, depth: 1 },
      { id: 'current', title: 'Current', isCurrent: true, depth: 2 },
    ]);
  });

  it('nests descendants below the current node via the reverse parent lookup', () => {
    const topics: FamilyTopic[] = [
      { id: 'current', title: 'Current', parents: [] },
      { id: 'child-b', title: 'Child B', parents: ['current'] },
      { id: 'child-a', title: 'Child A', parents: ['current'] },
      { id: 'grandchild', title: 'Grandchild', parents: ['child-a'] },
    ];
    const tree = buildFamilyTree('current', 'Current', topics, []);
    // Children are sorted by title, so Child A precedes Child B.
    expect(flatten(tree)).toEqual([
      { id: 'current', title: 'Current', isCurrent: true, depth: 0 },
      { id: 'child-a', title: 'Child A', isCurrent: false, depth: 1 },
      { id: 'grandchild', title: 'Grandchild', isCurrent: false, depth: 2 },
      { id: 'child-b', title: 'Child B', isCurrent: false, depth: 1 },
    ]);
  });

  it('renders the full ancestor + current + descendant chain in one tree', () => {
    const topics: FamilyTopic[] = [
      { id: 'parent', title: 'Parent', parents: [] },
      { id: 'current', title: 'Current', parents: ['parent'] },
      { id: 'child', title: 'Child', parents: ['current'] },
    ];
    const tree = buildFamilyTree('current', 'Current', topics, ['parent']);
    expect(flatten(tree)).toEqual([
      { id: 'parent', title: 'Parent', isCurrent: false, depth: 0 },
      { id: 'current', title: 'Current', isCurrent: true, depth: 1 },
      { id: 'child', title: 'Child', isCurrent: false, depth: 2 },
    ]);
  });

  it('falls back to the id as the label for a dangling parent ref', () => {
    // `ghost` is referenced as a parent but has no topic record.
    const topics: FamilyTopic[] = [
      { id: 'current', title: 'Current', parents: ['ghost'] },
    ];
    const tree = buildFamilyTree('current', 'Current', topics, ['ghost']);
    const rows = flatten(tree);
    expect(rows[0]).toEqual({
      id: 'ghost',
      title: 'ghost',
      isCurrent: false,
      depth: 0,
    });
  });

  it('breaks a parent cycle (current ↔ parent) without looping forever', () => {
    const topics: FamilyTopic[] = [
      { id: 'current', title: 'Current', parents: ['loop'] },
      { id: 'loop', title: 'Loop', parents: ['current'] },
    ];
    const tree = buildFamilyTree('current', 'Current', topics, ['loop']);
    const rows = flatten(tree);
    // Bounded (no infinite loop): the top ancestor is `loop`, `current` is the
    // focus node, and the back-edge is cut so the tree stays small.
    expect(rows.length).toBeLessThan(10);
    expect(rows[0]).toEqual({
      id: 'loop',
      title: 'Loop',
      isCurrent: false,
      depth: 0,
    });
    expect(rows.some((r) => r.id === 'current' && r.isCurrent)).toBe(true);
  });

  it('breaks a descendant cycle without looping forever', () => {
    const topics: FamilyTopic[] = [
      { id: 'current', title: 'Current', parents: [] },
      { id: 'a', title: 'A', parents: ['current', 'b'] },
      { id: 'b', title: 'B', parents: ['a'] },
    ];
    const tree = buildFamilyTree('current', 'Current', topics, []);
    const ids = flatten(tree).map((r) => r.id);
    // The a↔b cycle is bounded — every id appears, no infinite expansion.
    expect(ids).toContain('a');
    expect(ids).toContain('b');
    expect(ids.length).toBeLessThan(10);
  });

  it('caps runaway ancestor depth at maxDepth', () => {
    // A long single-parent chain; cap the walk at depth 2.
    const topics: FamilyTopic[] = [
      { id: 'g3', title: 'G3', parents: [] },
      { id: 'g2', title: 'G2', parents: ['g3'] },
      { id: 'g1', title: 'G1', parents: ['g2'] },
      { id: 'current', title: 'Current', parents: ['g1'] },
    ];
    const tree = buildFamilyTree('current', 'Current', topics, ['g1'], 2);
    const ids = flatten(tree).map((r) => r.id);
    // Walk stops before reaching g3.
    expect(ids).toContain('g1');
    expect(ids).toContain('current');
    expect(ids).not.toContain('g3');
  });
});
