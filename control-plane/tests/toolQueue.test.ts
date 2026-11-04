import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, expect, it, vi } from 'vitest';
import { ToolQueue, TOOL_QUEUE_LIMITS } from '../src/toolQueue';

const cleanup: Array<() => void> = [];
afterEach(() => { for (const close of cleanup.splice(0).reverse()) close(); vi.useRealTimers(); });
function fixture() {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-11-04T18:00:00Z'));
  const db = new DatabaseSync(':memory:');
  let blocked = false;
  const queue = new ToolQueue(db, () => blocked);
  cleanup.push(() => db.close(), () => queue.close());
  const metadata = () => ({ requestId: randomUUID(), operation: 'wm-document-query', caller: 'owner' });
  return { db, queue, metadata, block: (value: boolean) => { blocked = value; } };
}
function deferred() {
  let resolve: () => void = () => {};
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}

it('runs four calls, bounds the FIFO queue at sixteen, and never executes rejected work', async () => {
  const f = fixture(), gate = deferred(), order: number[] = [];
  const calls = Array.from({ length: 20 }, (_, index) =>
    f.queue.run(f.metadata(), { private: 'PRIVATE_REQUEST' }, new AbortController().signal, async () => {
      order.push(index); await gate.promise; return index;
    }));
  expect(f.queue.state()).toMatchObject({ running: 4, waiting: 16 });
  const rejected = vi.fn(async () => {});
  await expect(f.queue.run(f.metadata(), {}, new AbortController().signal, rejected)).rejects.toMatchObject({ code: 'full' });
  expect(rejected).not.toHaveBeenCalled();
  gate.resolve();
  expect(await Promise.all(calls)).toEqual(Array.from({ length: 20 }, (_, index) => index));
  expect(order).toEqual(Array.from({ length: 20 }, (_, index) => index));
  expect(f.queue.state()).toMatchObject({ running: 0, waiting: 0 });
  expect(f.queue.takePeakDepth()).toBe(16);
  expect(f.queue.takePeakDepth()).toBe(0);
  expect(JSON.stringify(f.queue.events())).not.toContain('PRIVATE_REQUEST');
  expect(JSON.stringify(f.db.prepare('SELECT * FROM instance_tool_queue_events').all())).not.toContain('PRIVATE_REQUEST');
});

it('pauses dispatch under memory pressure, exposes only waiting payloads, and resumes without forced GC', async () => {
  const f = fixture(), metadata = f.metadata(), controller = new AbortController();
  f.block(true);
  const action = vi.fn(async () => 'saved');
  const body = { method: 'tools/call', params: { arguments: { body: 'PRIVATE_CONTENT' } } };
  const pending = f.queue.run(metadata, body, controller.signal, action);
  const expired = expect(pending).rejects.toMatchObject({ code: 'expired' });
  expect(f.queue.inspect(metadata.requestId)).toEqual(body);
  expect(f.queue.state()).toMatchObject({ memoryBlocked: true, running: 0, waiting: 1 });
  await vi.advanceTimersByTimeAsync(4900);
  expect(action).not.toHaveBeenCalled();
  f.block(false);
  await vi.advanceTimersByTimeAsync(99);
  expect(action).not.toHaveBeenCalled();
  // The headroom must return before the five-second deadline, not at it.
  await vi.advanceTimersByTimeAsync(1);
  await expired;
  expect(action).not.toHaveBeenCalled();
  expect(f.queue.inspect(metadata.requestId)).toBeUndefined();
  const next = f.queue.run(f.metadata(), body, controller.signal, action);
  expect(await next).toBe('saved');
  expect(f.queue.events().some(event => event.event === 'expired')).toBe(true);
});

it('dispatches queued work once headroom returns before the deadline', async () => {
  const f = fixture(), action = vi.fn(async () => 'done');
  f.block(true);
  const pending = f.queue.run(f.metadata(), {}, new AbortController().signal, action);
  await vi.advanceTimersByTimeAsync(1000);
  f.block(false);
  await vi.advanceTimersByTimeAsync(100);
  expect(await pending).toBe('done');
  expect(action).toHaveBeenCalledOnce();
});

it('cancels disconnected queued calls but does not interrupt work already dispatched', async () => {
  const f = fixture(), controller = new AbortController(), metadata = f.metadata();
  f.block(true);
  const action = vi.fn(async () => {});
  const pending = f.queue.run(metadata, { secret: true }, controller.signal, action);
  const cancelled = expect(pending).rejects.toMatchObject({ code: 'cancelled' });
  controller.abort();
  await cancelled;
  expect(f.queue.inspect(metadata.requestId)).toBeUndefined();
  expect(action).not.toHaveBeenCalled();
  f.block(false);
  const gate = deferred(), runningController = new AbortController();
  const running = f.queue.run(f.metadata(), {}, runningController.signal, () => gate.promise);
  runningController.abort();
  expect(f.queue.state().running).toBe(1);
  gate.resolve();
  await running;
  expect(f.queue.state().running).toBe(0);
});

it('rejects waiting work during shutdown, allows started work to settle and releases timers', async () => {
  const f = fixture(), gate = deferred();
  const started = f.queue.run(f.metadata(), {}, new AbortController().signal, () => gate.promise);
  f.block(true);
  const waiting = f.queue.run(f.metadata(), {}, new AbortController().signal, async () => {});
  const stopped = expect(waiting).rejects.toMatchObject({ code: 'shutdown' });
  f.queue.close();
  await stopped;
  gate.resolve();
  await started;
  expect(f.queue.state()).toMatchObject({ running: 0, waiting: 0 });
  expect(vi.getTimerCount()).toBe(0);
  expect(TOOL_QUEUE_LIMITS).toEqual({ running: 4, waiting: 16, waitMs: 5000 });
});

it('caps lifecycle persistence at 2000 rows and expires events after 24 hours', async () => {
  const f = fixture();
  for (let index = 0; index < 700; index++) {
    await f.queue.run(f.metadata(), { private: 'NOT_LOGGED' }, new AbortController().signal, async () => {});
  }
  expect(f.db.prepare('SELECT COUNT(*) AS count FROM instance_tool_queue_events').get()?.count).toBe(2000);
  expect(f.queue.events()).toHaveLength(100);
  expect(f.queue.processing()).toMatchObject({ processedPerSecond: 70, processedLastMinute: 700 });
  await vi.advanceTimersByTimeAsync(86400001);
  await f.queue.run(f.metadata(), {}, new AbortController().signal, async () => {});
  expect(f.db.prepare('SELECT COUNT(*) AS count FROM instance_tool_queue_events').get()?.count).toBe(3);
  expect(vi.getTimerCount()).toBe(0);
});

it('measures completed and failed work, excludes unfinished/rejected calls, and expires rolling windows', async () => {
  const f = fixture();
  f.block(true);
  const pending = f.queue.run(f.metadata(), {}, new AbortController().signal,
    () => new Promise(resolve => setTimeout(resolve, 40)));
  expect(f.queue.processing()).toEqual({
    processedPerSecond: 0, processedLastMinute: 0, averageWaitMs: null, averageRunMs: null,
  });
  await vi.advanceTimersByTimeAsync(1000);
  f.block(false);
  await vi.advanceTimersByTimeAsync(100);
  expect(f.queue.processing().processedLastMinute).toBe(0);
  await vi.advanceTimersByTimeAsync(40);
  await pending;
  expect(f.queue.processing()).toEqual({
    processedPerSecond: 0.1, processedLastMinute: 1, averageWaitMs: 1100, averageRunMs: 40,
  });
  const failed = f.queue.run(f.metadata(), {}, new AbortController().signal, async () => {
    await new Promise(resolve => setTimeout(resolve, 20));
    throw new Error('test failure');
  });
  const rejected = expect(failed).rejects.toThrow('test failure');
  await vi.advanceTimersByTimeAsync(20);
  await rejected;
  const cancelled = new AbortController();
  cancelled.abort();
  await expect(f.queue.run(f.metadata(), {}, cancelled.signal, async () => {})).rejects.toMatchObject({ code: 'cancelled' });
  expect(f.queue.processing()).toEqual({
    processedPerSecond: 0.2, processedLastMinute: 2, averageWaitMs: 550, averageRunMs: 30,
  });
  await vi.advanceTimersByTimeAsync(10000);
  expect(f.queue.processing()).toMatchObject({ processedPerSecond: 0, processedLastMinute: 2, averageRunMs: 30 });
  await vi.advanceTimersByTimeAsync(50000);
  expect(f.queue.processing()).toEqual({
    processedPerSecond: 0, processedLastMinute: 0, averageWaitMs: null, averageRunMs: null,
  });
});

it('weights minute averages by processed requests rather than by second buckets and bounds aggregate storage', async () => {
  const f = fixture();
  for (const duration of [10, 10, 70]) {
    if (duration === 70) await vi.advanceTimersByTimeAsync(2000);
    const pending = f.queue.run(f.metadata(), {}, new AbortController().signal,
      () => new Promise(resolve => setTimeout(resolve, duration)));
    await vi.advanceTimersByTimeAsync(duration);
    await pending;
  }
  expect(f.queue.processing()).toMatchObject({ processedLastMinute: 3, averageRunMs: 30 });
  for (let second = 0; second < 70; second++) {
    await vi.advanceTimersByTimeAsync(1000);
    await f.queue.run(f.metadata(), {}, new AbortController().signal, async () => {});
  }
  expect(Number(f.db.prepare('SELECT COUNT(*) AS count FROM instance_tool_queue_seconds').get()?.count)).toBeLessThanOrEqual(61);
});
