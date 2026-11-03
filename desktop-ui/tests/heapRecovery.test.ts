import { expect, it, vi } from 'vitest';
import { recoverHeap } from '../src/main/heapRecovery';
import { heapCategories, heapPressure } from '../src/renderer/heapPresentation';
import { sessionSnapshotSchema } from '../../control-plane/src/sessionPolicy';

function fixture() {
  const snapshot = sessionSnapshotSchema.parse({
    startedAt: 123, policy: { idleMinutes: 60, maxPerClient: 100, maxTotal: 500, handshakesPerMinute: 1000, retentionDays: 10 },
    memory: { heapUsedBytes: 600, heapLimitBytes: 1000, admissionThresholdBytes: 600, admissionBlocked: true, gcAvailable: true,
      spaces: [{ name: 'old_space', usedBytes: 400, sizeBytes: 500, availableBytes: 100 },
        { name: 'new_space', usedBytes: 200, sizeBytes: 300, availableBytes: 100 }] },
    active: [], events: [], nextCursor: null,
  });
  const order: string[] = [];
  const options = {
    snapshot: vi.fn(async () => snapshot), ensureCurrent: vi.fn(),
    confirm: vi.fn(async () => { order.push('confirmed'); return true; }),
    saveReport: vi.fn(async () => { order.push('saved'); return 'report-id'; }),
    collect: vi.fn(async () => {
      order.push('collected');
      return { collection: { beforeBytes: 600, afterBytes: 100, reclaimedBytes: 500, durationMs: 15, idleSessionsReclaimed: 2 }, snapshot };
    }),
  };
  return { options, snapshot, order };
}

it('confirms, persists a report, and only then requests collection', async () => {
  const f = fixture();
  const result = await recoverHeap(f.options);
  expect(f.order).toEqual(['confirmed', 'saved', 'collected']);
  expect(result).toMatchObject({ status: 'collected', topicId: 'report-id', collection: { reclaimedBytes: 500 } });
});

it('does nothing after cancellation, report failure, unavailable GC or a changed instance', async () => {
  const cancelled = fixture();
  cancelled.options.confirm.mockResolvedValue(false);
  expect(await recoverHeap(cancelled.options)).toEqual({ status: 'cancelled' });
  expect(cancelled.options.saveReport).not.toHaveBeenCalled();
  expect(cancelled.options.collect).not.toHaveBeenCalled();
  const failed = fixture();
  failed.options.saveReport.mockRejectedValue(new Error('Inbox unavailable'));
  await expect(recoverHeap(failed.options)).rejects.toThrow('Inbox unavailable');
  expect(failed.options.collect).not.toHaveBeenCalled();
  const unsupported = fixture();
  unsupported.snapshot.memory.gcAvailable = false;
  await expect(recoverHeap(unsupported.options)).rejects.toThrow('unavailable');
  expect(unsupported.options.confirm).not.toHaveBeenCalled();
  const changed = fixture();
  changed.options.ensureCurrent.mockImplementationOnce(() => {}).mockImplementationOnce(() => {})
    .mockImplementationOnce(() => { throw new Error('Selected instance changed'); });
  await expect(recoverHeap(changed.options)).rejects.toThrow('Selected instance changed');
  expect(changed.options.collect).not.toHaveBeenCalled();
});

it('preserves the saved report link and explicit failure when collection fails', async () => {
  const f = fixture();
  f.options.collect.mockRejectedValue(new Error('Backend timed out; collection outcome unknown'));
  const log = vi.spyOn(console, 'error').mockImplementation(() => {});
  expect(await recoverHeap(f.options)).toEqual({ status: 'failed', topicId: 'report-id', error: 'Backend timed out; collection outcome unknown' });
  expect(log).toHaveBeenCalled();
  log.mockRestore();
});

it('labels pressure at the exact 50/60% thresholds and names categories without claiming per-client ownership', () => {
  const f = fixture();
  expect(heapPressure({ ...f.snapshot.memory, heapUsedBytes: 499, admissionBlocked: false }).severity).toBe('normal');
  expect(heapPressure({ ...f.snapshot.memory, heapUsedBytes: 500, admissionBlocked: false }).severity).toBe('warning');
  expect(heapPressure(f.snapshot.memory).severity).toBe('critical');
  const categories = heapCategories(f.snapshot.memory);
  expect(categories.map(category => category.label)).toEqual(['Long-lived objects (old space)', 'Young objects (new space)']);
  expect(categories.reduce((sum, category) => sum + category.percent, 0)).toBeCloseTo(100);
});
