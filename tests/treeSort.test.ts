/**
 * Focused unit test for the pure workstream-tree ordering helper
 * (`sortTreeChildren` in webview-ui/src/lib/treeSort.ts). Verifies the
 * pinned-first → open → closed-last ordering, stability within tiers, that
 * nanites keep their slot with the open tier, and that the input is not mutated.
 */

import { describe, test, expect } from 'vitest';
import { sortTreeChildren, type TreeChild } from '../webview-ui/src/lib/treeSort';

function topic(id: string, status: string, pinned = false): TreeChild {
  return {
    kind: 'topic',
    id,
    label: id,
    icon: 'circle',
    status,
    slug: id,
    pinned,
    alertCount: 0,
    alertSeverity: null,
    children: [],
    actions: [],
  };
}

function nanite(id: string, phase = 'Succeeded'): TreeChild {
  return {
    kind: 'nanite',
    id,
    label: id,
    icon: 'play',
    phase,
    openId: id,
    actions: [],
  };
}

const ids = (nodes: TreeChild[]): string[] => nodes.map((n) => n.id);

describe('sortTreeChildren', () => {
  test('orders pinned-first, then open, then closed last', () => {
    const input = [
      topic('closed-a', 'closed'),
      topic('open-a', 'open'),
      topic('pinned-a', 'open', true),
    ];
    expect(ids(sortTreeChildren(input))).toEqual(['pinned-a', 'open-a', 'closed-a']);
  });

  test('is stable within each tier (preserves incoming order otherwise)', () => {
    const input = [
      topic('open-1', 'open'),
      topic('closed-1', 'closed'),
      topic('open-2', 'open'),
      topic('closed-2', 'closed'),
    ];
    expect(ids(sortTreeChildren(input))).toEqual([
      'open-1',
      'open-2',
      'closed-1',
      'closed-2',
    ]);
  });

  test('pinned-open sorts before pinned-closed', () => {
    const input = [topic('pin-closed', 'closed', true), topic('pin-open', 'open', true)];
    expect(ids(sortTreeChildren(input))).toEqual(['pin-open', 'pin-closed']);
  });

  test('nanites ride with the open tier ahead of closed topics, stable', () => {
    const input = [
      topic('closed-x', 'closed'),
      nanite('run-1', 'Failed'),
      topic('open-x', 'open'),
    ];
    expect(ids(sortTreeChildren(input))).toEqual(['run-1', 'open-x', 'closed-x']);
  });

  test('does not mutate the input array', () => {
    const input = [topic('closed-a', 'closed'), topic('open-a', 'open')];
    const before = ids(input);
    sortTreeChildren(input);
    expect(ids(input)).toEqual(before);
  });
});
