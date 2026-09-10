import { describe, expect, it } from 'vitest';
import { planTopicTransfer, topicTransferRefreshTargets } from '../src/renderer/topicTransfer';

describe('topic transfer drag planning', () => {
  it('copies by default and moves when Command is held at drop time', () => {
    const source = { slug: 'parent', sourceWorkstream: 'source' };
    expect(planTopicTransfer(source, 'target', false)).toEqual({
      ...source, targetWorkstream: 'target', move: false,
    });
    expect(planTopicTransfer(source, 'target', true)).toEqual({
      ...source, targetWorkstream: 'target', move: true,
    });
  });

  it('rejects missing and same-workstream targets', () => {
    expect(planTopicTransfer(null, 'target', false)).toBeNull();
    expect(planTopicTransfer({ slug: 'parent', sourceWorkstream: 'source' }, 'source', false)).toBeNull();
  });

  it('refreshes open topics and both affected workstreams without touching unrelated documents', () => {
    expect(topicTransferRefreshTargets([
      { kind: 'topic', slug: 'parent' },
      { kind: 'topic', slug: 'child' },
      { kind: 'workstream', slug: 'source' },
      { kind: 'workstream', slug: 'target' },
      { kind: 'workstream', slug: 'unrelated' },
      { kind: 'Nanite', slug: 'runner' },
    ], 'source', 'target')).toEqual([
      { kind: 'topic', identifier: 'parent', key: 'topic:parent' },
      { kind: 'topic', identifier: 'child', key: 'topic:child' },
      { kind: 'workstream', identifier: 'source', key: 'workstream:source' },
      { kind: 'workstream', identifier: 'target', key: 'workstream:target' },
    ]);
  });
});