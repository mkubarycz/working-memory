import { describe, expect, it, vi } from 'vitest';
import {
  moveTopicToNewWorkstream,
  planTopicTransfer,
  topicTransferRefreshTargets,
  type NewWorkstreamMoveDraft,
  type TopicTransferRequest,
} from '../src/renderer/topicTransfer';

describe('topic transfer drag planning', () => {
  it('copies by default and moves when Command is held at drop time', () => {
    const source = { id: 'parent', sourceWorkstream: 'source' };
    expect(planTopicTransfer(source, 'target', false)).toEqual({
      ...source, targetWorkstream: 'target', move: false,
    });
    expect(planTopicTransfer(source, 'target', true)).toEqual({
      ...source, targetWorkstream: 'target', move: true,
    });
  });

  describe('moving to a new workstream', () => {
    function draft(): NewWorkstreamMoveDraft {
      return { id: 'parent', sourceWorkstream: 'source', title: 'Edited workstream name', targetWorkstream: '' };
    }

    it('creates the named workstream then uses the existing topic-tree move operation', async () => {
      const value = draft();
      const createWorkstream = vi.fn().mockResolvedValue({ id: 'new-target', title: value.title });
      const transfer = vi.fn<(request: TopicTransferRequest) => Promise<void>>().mockResolvedValue();
      await moveTopicToNewWorkstream(value, { createWorkstream }, transfer);
      expect(createWorkstream).toHaveBeenCalledExactlyOnceWith('Edited workstream name');
      expect(transfer).toHaveBeenCalledExactlyOnceWith({
        id: 'parent', sourceWorkstream: 'source', targetWorkstream: 'new-target', move: true,
      });
    });

    it('reuses the created workstream after a failed move', async () => {
      const value = draft();
      const createWorkstream = vi.fn().mockResolvedValue({ id: 'new-target', title: value.title });
      const transfer = vi.fn<(request: TopicTransferRequest) => Promise<void>>()
        .mockRejectedValueOnce(new Error('Backend unavailable')).mockResolvedValue();
      await expect(moveTopicToNewWorkstream(value, { createWorkstream }, transfer))
        .rejects.toThrow('Retry to move it to the same workstream.');
      expect(value.targetWorkstream).toBe('new-target');
      await moveTopicToNewWorkstream(value, { createWorkstream }, transfer);
      expect(createWorkstream).toHaveBeenCalledTimes(1);
      expect(transfer).toHaveBeenCalledTimes(2);
    });

    it('does not move the topic when creating the workstream fails', async () => {
      const value = draft();
      const createWorkstream = vi.fn().mockRejectedValue(new Error('Backend unavailable'));
      const transfer = vi.fn<(request: TopicTransferRequest) => Promise<void>>();
      await expect(moveTopicToNewWorkstream(value, { createWorkstream }, transfer)).rejects.toThrow('Backend unavailable');
      expect(value.targetWorkstream).toBe('');
      expect(transfer).not.toHaveBeenCalled();
    });
  });

  it('rejects missing and same-workstream targets', () => {
    expect(planTopicTransfer(null, 'target', false)).toBeNull();
    expect(planTopicTransfer({ id: 'parent', sourceWorkstream: 'source' }, 'source', false)).toBeNull();
  });

  it('refreshes open topics and both affected workstreams without touching unrelated documents', () => {
    expect(topicTransferRefreshTargets([
      { kind: 'topic', id: 'parent' },
      { kind: 'topic', id: 'child' },
      { kind: 'workstream', id: 'source' },
      { kind: 'workstream', id: 'target' },
      { kind: 'workstream', id: 'unrelated' },
      { kind: 'Config', id: 'runner' },
    ], 'source', 'target')).toEqual([
      { kind: 'topic', identifier: 'parent', key: 'topic:parent' },
      { kind: 'topic', identifier: 'child', key: 'topic:child' },
      { kind: 'workstream', identifier: 'source', key: 'workstream:source' },
      { kind: 'workstream', identifier: 'target', key: 'workstream:target' },
    ]);
  });
});