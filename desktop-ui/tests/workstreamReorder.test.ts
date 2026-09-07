import { describe, expect, it } from 'vitest';
import { planWorkstreamReorder, workstreamDropIndex } from '../src/renderer/workstreamReorder';

const order = {
  queue: ['q1', 'q2'],
  progress: ['p1', 'p2', 'p3'],
  backlog: ['b1'],
};

describe('planWorkstreamReorder', () => {
  it('reorders within a lifecycle section', () => {
    expect(planWorkstreamReorder(order, 'p3', 'progress', 0)).toEqual([
      { slug: 'p3', section: 'progress', position: 0 },
      { slug: 'p1', section: 'progress', position: 1 },
      { slug: 'p2', section: 'progress', position: 2 },
    ]);
  });

  it('moves into Queue and normalizes both affected sections', () => {
    expect(planWorkstreamReorder(order, 'p2', 'queue', 1)).toEqual([
      { slug: 'p1', section: 'progress', position: 0 },
      { slug: 'p3', section: 'progress', position: 1 },
      { slug: 'q1', section: 'queue', position: 0 },
      { slug: 'p2', section: 'queue', position: 1 },
      { slug: 'q2', section: 'queue', position: 2 },
    ]);
  });

  it('moves into an empty Backlog and clamps the target index', () => {
    expect(planWorkstreamReorder({ ...order, backlog: [] }, 'q1', 'backlog', 99)).toEqual([
      { slug: 'q2', section: 'queue', position: 0 },
      { slug: 'q1', section: 'backlog', position: 0 },
    ]);
  });

  it('ignores an unknown workstream', () => {
    expect(planWorkstreamReorder(order, 'missing', 'queue', 0)).toEqual([]);
  });

  it('adjusts original-list boundaries when moving downward in the same section', () => {
    expect(planWorkstreamReorder(order, 'p1', 'progress', 3)).toEqual([
      { slug: 'p2', section: 'progress', position: 0 },
      { slug: 'p3', section: 'progress', position: 1 },
      { slug: 'p1', section: 'progress', position: 2 },
    ]);
    expect(planWorkstreamReorder(order, 'p2', 'progress', 2)).toEqual([]);
  });
});

describe('workstreamDropIndex', () => {
  it('uses compact header centers instead of expanded card centers', () => {
    const headers = [
      { top: 100, height: 32 },
      { top: 500, height: 32 },
      { top: 700, height: 32 },
    ];
    expect(workstreamDropIndex(headers, 120)).toBe(1);
    expect(workstreamDropIndex(headers, 510)).toBe(1);
    expect(workstreamDropIndex(headers, 520)).toBe(2);
    expect(workstreamDropIndex(headers, 900)).toBe(3);
  });
});