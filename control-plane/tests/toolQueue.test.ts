import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, expect, it, vi } from 'vitest';
import { ToolQueue, TOOL_QUEUE_LIMITS } from '../src/toolQueue';
import { DEFAULT_TOOL_QUEUE_SETTINGS } from '../src/diagnosticContract';
import { Observability } from '../src/observability';

const cleanup: Array<() => void | Promise<void>> = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); vi.useRealTimers(); });
function fixture(enabled = true) {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-11-04T18:00:00Z'));
  const db = new DatabaseSync(':memory:');
  let blocked = false;
  const flags = { enabled };
  const exporter = new Observability(db, () => flags.enabled, { intervalMs: 2_000_000_000 });
  const queue = new ToolQueue(db, () => blocked, Date.now, exporter);
  cleanup.push(() => db.close(), () => {
    flags.enabled = false;
    exporter.syncEnabled();
    return exporter.close();
  }, () => queue.close());
  const metadata = () => ({ requestId: randomUUID(), operation: 'wm-document-query', caller: 'owner' });
  return { db, queue, exporter, flags, timerCount: vi.getTimerCount(), metadata,
    block: (value: boolean) => { blocked = value; } };
}
function deferred() {
  let resolve: () => void = () => {};
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}

it('dispatches immediate calls without waiting entries, queue peaks, or queue timers', async () => {
  const f = fixture(), gate = deferred(), signal = new AbortController().signal;
  const calls = Array.from({ length: 4 }, () =>
    f.queue.run(f.metadata(), { private: 'NOT_QUEUED' }, signal, () => gate.promise));
  expect(f.queue.state()).toMatchObject({ running: 4, waiting: 0, peakQueueDepth: 0, maxQueueWaitMs: 0 });
  expect(f.queue.events().map(event => event.event)).toEqual(['started', 'started', 'started', 'started']);
  expect(vi.getTimerCount()).toBe(f.timerCount);
  await vi.advanceTimersByTimeAsync(75);
  gate.resolve();
  await Promise.all(calls);
  expect(f.queue.events().every(event => event.waitMs === 0)).toBe(true);
  expect(f.queue.processing()).toMatchObject({ processedLastMinute: 4, averageWaitMs: 0, averageRunMs: 75 });
});

it('counts only genuine waiters when dispatch slots are occupied', async () => {
  const f = fixture(), gate = deferred(), signal = new AbortController().signal;
  f.queue.configure({ ...DEFAULT_TOOL_QUEUE_SETTINGS, maxConcurrency: 1 }, f.queue.state().settings);
  const immediate = f.metadata(), queued = f.metadata();
  const first = f.queue.run(immediate, {}, signal, () => gate.promise);
  const next = f.queue.run(queued, {}, signal, async () => {});
  expect(f.queue.state()).toMatchObject({ running: 1, waiting: 1, peakQueueDepth: 1 });
  expect(f.queue.events().filter(event => event.event === 'queued').map(event => event.requestId)).toEqual([queued.requestId]);
  await vi.advanceTimersByTimeAsync(50);
  gate.resolve();
  await Promise.all([first, next]);
  expect(f.queue.events().find(event => event.requestId === immediate.requestId && event.event === 'completed'))
    .toMatchObject({ waitMs: 0 });
  expect(f.queue.events().find(event => event.requestId === queued.requestId && event.event === 'completed'))
    .toMatchObject({ waitMs: 50 });
  expect(f.queue.state()).toMatchObject({ running: 0, waiting: 0, peakQueueDepth: 1, maxQueueWaitMs: 50 });
  expect(vi.getTimerCount()).toBe(f.timerCount);
});

it('persists validated settings across queue restarts and rejects stale or failed writes without applying them', () => {
  const f = fixture();
  const settings = { ...DEFAULT_TOOL_QUEUE_SETTINGS, maxConcurrency: 2, maxQueueSize: 8, queueTimeoutMs: 10000, heapDispatchPausePercent: 50 };
  f.queue.configure(settings, f.queue.state().settings);
  expect(f.queue.state()).toMatchObject({ settings, limits: { running: 2, waiting: 8, waitMs: 10000 } });
  expect(() => f.queue.configure(DEFAULT_TOOL_QUEUE_SETTINGS, DEFAULT_TOOL_QUEUE_SETTINGS)).toThrow('settings changed');
  expect(() => f.queue.configure({ ...settings, maxConcurrency: 0 }, settings)).toThrow();
  f.db.exec('PRAGMA query_only=ON');
  expect(() => f.queue.configure({ ...settings, maxConcurrency: 3 }, settings)).toThrow();
  f.db.exec('PRAGMA query_only=OFF');
  expect(f.queue.state().settings).toEqual(settings);
  f.queue.close();
  const restarted = new ToolQueue(f.db, () => false);
  cleanup.push(() => restarted.close());
  expect(restarted.state().settings).toEqual(settings);
});

it('lets running work finish and preserves FIFO waiters when concurrency and queue size are reduced', async () => {
  const f = fixture(), gate = deferred(), order: number[] = [];
  f.queue.configure({ ...DEFAULT_TOOL_QUEUE_SETTINGS, maxConcurrency: 1 }, f.queue.state().settings);
  const calls = Array.from({ length: 3 }, (_, index) => f.queue.run(f.metadata(), {}, new AbortController().signal, async () => {
    order.push(index);
    if (index === 0) await gate.promise;
  }));
  await Promise.resolve();
  expect(f.queue.state()).toMatchObject({ running: 1, waiting: 2 });
  f.queue.configure({ ...f.queue.state().settings, maxQueueSize: 1 }, f.queue.state().settings);
  expect(f.queue.state()).toMatchObject({ running: 1, waiting: 2 });
  await expect(f.queue.run(f.metadata(), {}, new AbortController().signal, async () => {})).rejects.toMatchObject({ code: 'full' });
  gate.resolve();
  await Promise.all(calls);
  expect(order).toEqual([0, 1, 2]);
});

it('increases concurrency immediately but does not cancel running work when it is lowered again', async () => {
  const f = fixture(), gate = deferred(), signal = new AbortController().signal;
  f.queue.configure({ ...DEFAULT_TOOL_QUEUE_SETTINGS, maxConcurrency: 1 }, f.queue.state().settings);
  const calls = [f.queue.run(f.metadata(), {}, signal, () => gate.promise), f.queue.run(f.metadata(), {}, signal, () => gate.promise)];
  expect(f.queue.state()).toMatchObject({ running: 1, waiting: 1 });
  f.queue.configure({ ...f.queue.state().settings, maxConcurrency: 2 }, f.queue.state().settings);
  expect(f.queue.state()).toMatchObject({ running: 2, waiting: 0 });
  f.queue.configure({ ...f.queue.state().settings, maxConcurrency: 1 }, f.queue.state().settings);
  expect(f.queue.state()).toMatchObject({ running: 2, waiting: 0 });
  gate.resolve();
  await Promise.all(calls);
});

it('applies timeout changes only to new arrivals, preserving the deadlines of existing waiters', async () => {
  const f = fixture(), signal = new AbortController().signal, action = vi.fn(async () => {});
  f.block(true);
  const old = f.queue.run(f.metadata(), {}, signal, action);
  f.queue.configure({ ...DEFAULT_TOOL_QUEUE_SETTINGS, queueTimeoutMs: 1000 }, f.queue.state().settings);
  const next = f.queue.run(f.metadata(), {}, signal, action);
  const expired = expect(next).rejects.toMatchObject({ code: 'expired' });
  await vi.advanceTimersByTimeAsync(1100);
  await expired;
  expect(f.queue.state().waiting).toBe(1);
  f.block(false);
  await vi.advanceTimersByTimeAsync(100);
  await old;
  expect(action).toHaveBeenCalledOnce();
});

it('uses the configured heap percentage for dispatch and resumes waiters when the threshold is raised', async () => {
  const f = fixture(), signal = new AbortController().signal, action = vi.fn(async () => {});
  f.queue.close();
  const queue = new ToolQueue(f.db, percent => 55 >= percent);
  cleanup.push(() => queue.close());
  queue.configure({ ...DEFAULT_TOOL_QUEUE_SETTINGS, heapDispatchPausePercent: 50 }, queue.state().settings);
  const pending = queue.run(f.metadata(), {}, signal, action);
  expect(queue.state()).toMatchObject({ memoryBlocked: true, waiting: 1, running: 0 });
  queue.configure({ ...queue.state().settings, heapDispatchPausePercent: 60 }, queue.state().settings);
  await pending;
  expect(action).toHaveBeenCalledOnce();
});

it('counts only capacity, timeout and shutdown drops, excluding cancellations, denials and failed executions', async () => {
  const f = fixture(), signal = new AbortController().signal;
  f.queue.configure({ ...DEFAULT_TOOL_QUEUE_SETTINGS, maxQueueSize: 1, queueTimeoutMs: 1000 }, f.queue.state().settings);
  f.block(true);
  const pending = f.queue.run(f.metadata(), {}, signal, async () => {});
  const expired = expect(pending).rejects.toMatchObject({ code: 'expired' });
  await expect(f.queue.run(f.metadata(), {}, signal, async () => {})).rejects.toMatchObject({ code: 'full' });
  await vi.advanceTimersByTimeAsync(1000);
  await expired;
  await expect(f.queue.run(f.metadata(), {}, AbortSignal.abort(), async () => {})).rejects.toMatchObject({ code: 'cancelled' });
  f.block(false);
  await f.queue.run(f.metadata(), {}, signal, async () => 'not_executed' as const, value => value);
  await expect(f.queue.run(f.metadata(), {}, signal, async () => { throw new Error('Executed failure'); })).rejects.toThrow('Executed failure');
  f.block(true);
  const shutdown = f.queue.run(f.metadata(), {}, signal, async () => {});
  const dropped = expect(shutdown).rejects.toMatchObject({ code: 'shutdown' });
  f.queue.close();
  await dropped;
  expect(f.queue.state().queueDrops).toEqual({ timeouts: 1, rejections: 1, shutdown: 1 });
  expect(f.queue.state().maxQueueWaitMs).toBe(1000);
});

it('retains drop totals after lifecycle-log truncation without recounting snapshots', async () => {
  const f = fixture(), signal = new AbortController().signal;
  f.queue.configure({ ...DEFAULT_TOOL_QUEUE_SETTINGS, maxQueueSize: 1 }, f.queue.state().settings);
  f.block(true);
  const pending = f.queue.run(f.metadata(), {}, signal, async () => {});
  const stopped = expect(pending).rejects.toMatchObject({ code: 'shutdown' });
  for (let index = 0; index < 2005; index++) {
    await expect(f.queue.run(f.metadata(), {}, signal, async () => {})).rejects.toMatchObject({ code: 'full' });
  }
  expect(f.queue.events(2000)).toHaveLength(2000);
  expect(f.queue.state().queueDrops.rejections).toBe(2005);
  expect(f.queue.state().queueDrops.rejections).toBe(2005);
  f.queue.close();
  await stopped;
});

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
  expect(f.queue.state().peakQueueDepth).toBe(16);
  f.queue.resetSamplingPeaks();
  expect(f.queue.state().peakQueueDepth).toBe(0);
  expect(JSON.stringify(f.queue.events())).not.toContain('PRIVATE_REQUEST');
  expect(JSON.stringify(f.queue.events())).not.toContain('PRIVATE_REQUEST');
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
  expect(vi.getTimerCount()).toBe(f.timerCount);
  expect(TOOL_QUEUE_LIMITS).toEqual({ running: 4, waiting: 16, waitMs: 5000 });
});

it('caps enabled in-memory lifecycle history at 2000 rows without creating analytics tables', async () => {
  const f = fixture();
  for (let index = 0; index < 1100; index++) {
    await f.queue.run(f.metadata(), { private: 'NOT_LOGGED' }, new AbortController().signal, async () => {});
  }
  expect(f.db.prepare("SELECT name FROM sqlite_master WHERE name='instance_tool_queue_events'").all()).toEqual([]);
  expect(f.queue.events()).toHaveLength(100);
  expect(f.queue.events(2000)).toHaveLength(2000);
  expect(f.queue.state().requestsByTool).toEqual({ 'wm-document-query': 1100 });
  expect(f.queue.state().timingsByTool?.['wm-document-query'].finished).toBe(1100);
  expect(f.queue.processing()).toMatchObject({ processedPerSecond: 110, processedLastMinute: 1100 });
  await vi.advanceTimersByTimeAsync(86400001);
  await f.queue.run(f.metadata(), {}, new AbortController().signal, async () => {});
  expect(f.queue.events(2000)).toHaveLength(2000);
  expect(vi.getTimerCount()).toBe(f.timerCount);
});

it('samples cumulative per-tool timing totals once per finished request without diluting executed runtimes with denials', async () => {
  const f = fixture(), gate = deferred(), signal = new AbortController().signal;
  f.block(true);
  const pending = f.queue.run(f.metadata(), {}, signal, () => gate.promise);
  await vi.advanceTimersByTimeAsync(200);
  f.block(false);
  await vi.advanceTimersByTimeAsync(100);
  expect(f.queue.state().timingsByTool).toEqual({});
  await vi.advanceTimersByTimeAsync(40);
  gate.resolve();
  await pending;
  await expect(f.queue.run(f.metadata(), {}, signal, async () => {
    await vi.advanceTimersByTimeAsync(30);
    throw new Error('Failed execution');
  })).rejects.toThrow('Failed execution');
  const read = { ...f.metadata(), operation: 'wm-document-read' };
  await expect(f.queue.run(read, {}, AbortSignal.abort(), async () => {})).rejects.toMatchObject({ code: 'cancelled' });
  await f.queue.run({ ...read, requestId: randomUUID() }, {}, signal, async () => {
    await vi.advanceTimersByTimeAsync(100);
    return 'not_executed' as const;
  }, value => value);
  const expected = {
    'wm-document-query': { finished: 2, executed: 2, waitMs: 300, runMs: 70 },
    'wm-document-read': { finished: 2, executed: 0, waitMs: 0, runMs: 0 },
  };
  expect(f.queue.state().timingsByTool).toEqual(expected);
  const prior = f.queue.state();
  if (!prior.timingsByTool) throw new Error('Enabled analytics timing totals are missing.');
  prior.timingsByTool['wm-document-query'].waitMs = 999;
  expect(f.queue.state().timingsByTool).toEqual(expected);
  expect(f.queue.processing()?.processedLastMinute).toBe(2);
});

it('counts arrivals once by tool, including rejected work, without recounting lifecycle events or snapshots', async () => {
  const f = fixture();
  await f.queue.run(f.metadata(), { private: 'NOT_RECORDED' }, new AbortController().signal, async () => {});
  const signal = AbortSignal.abort();
  await expect(f.queue.run({ ...f.metadata(), operation: 'wm-document-read' }, {}, signal, async () => {}))
    .rejects.toMatchObject({ code: 'cancelled' });
  const expected = { 'wm-document-query': 1, 'wm-document-read': 1 };
  expect(f.queue.state().requestsByTool).toEqual(expected);
  expect(f.queue.events().length).toBeGreaterThan(2);
  expect(f.queue.state().requestsByTool).toEqual(expected);
});

it.each(['state', 'events'] as const)('reads bounded in-memory lifecycle records through %s without SQLite', async sample => {
  const f = fixture();
  await f.queue.run(f.metadata(), {}, new AbortController().signal, async () => {});
  expect(f.queue.events()).toHaveLength(2);
  await vi.advanceTimersByTimeAsync(86400001);
  f.queue[sample]();
  expect(f.db.prepare("SELECT name FROM sqlite_master WHERE name='instance_tool_queue_events'").all()).toEqual([]);
  expect(f.queue.events()).toHaveLength(2);
  expect(vi.getTimerCount()).toBe(f.timerCount);
});

it('records explicit tool failures and excludes pre-execution denials from processing metrics', async () => {
  const f = fixture(), signal = new AbortController().signal;
  f.block(true);
  const denied = f.queue.run(f.metadata(), {}, signal, async () => 'not_executed' as const, outcome => outcome);
  await vi.advanceTimersByTimeAsync(1000);
  f.block(false);
  await vi.advanceTimersByTimeAsync(100);
  expect(await denied).toBe('not_executed');
  expect(f.queue.events()[0]).toMatchObject({ event: 'not_executed', waitMs: 1100, runMs: 0 });
  expect(f.queue.processing()).toEqual({
    processedPerSecond: 0, processedLastMinute: 0, averageWaitMs: null, averageRunMs: null,
  });
  expect(await f.queue.run(f.metadata(), {}, signal, async () => ({ isError: true }),
    result => result.isError ? 'failed' : 'completed')).toEqual({ isError: true });
  expect(f.queue.events()[0].event).toBe('failed');
  expect(f.queue.processing()).toMatchObject({ processedPerSecond: 0.1, processedLastMinute: 1 });
});

it('rejects outcome-classification errors and releases the running slot', async () => {
  const f = fixture();
  await expect(f.queue.run(f.metadata(), {}, new AbortController().signal, async () => 'done',
    () => { throw new Error('Invalid execution outcome'); })).rejects.toThrow('Invalid execution outcome');
  expect(f.queue.state().running).toBe(0);
  expect(f.queue.events()[0].event).toBe('failed');
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

it('weights minute averages by processed requests without SQLite aggregate storage', async () => {
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
  expect(f.db.prepare("SELECT name FROM sqlite_master WHERE name='instance_tool_queue_seconds'").all()).toEqual([]);
  expect(f.queue.processing()?.processedLastMinute).toBe(60);
});

it('keeps live queue controls but collects no analytics while disabled, including after a toggle', async () => {
  const f = fixture(false), gate = deferred();
  f.queue.configure({ ...DEFAULT_TOOL_QUEUE_SETTINGS, maxConcurrency: 1 }, f.queue.state().settings);
  const first = f.queue.run(f.metadata(), {}, new AbortController().signal, () => gate.promise);
  const next = f.queue.run(f.metadata(), {}, new AbortController().signal, async () => {});
  await vi.advanceTimersByTimeAsync(100);
  expect(f.queue.state()).toMatchObject({ running: 1, waiting: 1, maxQueueWaitMs: 100 });
  expect(f.queue.state().requestsByTool).toBeUndefined();
  expect(f.queue.state().timingsByTool).toBeUndefined();
  expect(f.queue.state().queueDrops).toBeUndefined();
  expect(f.queue.processing()).toBeUndefined();
  expect(f.queue.events()).toEqual([]);
  gate.resolve();
  await Promise.all([first, next]);
  expect(f.exporter.queueEvents(10)).toEqual([]);
  f.flags.enabled = true;
  await f.queue.run(f.metadata(), {}, new AbortController().signal, async () => {});
  expect(f.queue.state().requestsByTool).toEqual({ 'wm-document-query': 1 });
  f.flags.enabled = false;
  f.exporter.syncEnabled();
  await f.queue.run(f.metadata(), {}, new AbortController().signal, async () => {});
  expect(f.queue.events()).toEqual([]);
  expect(f.queue.state().processing).toBeUndefined();
  expect(f.exporter.queueEvents(10)).toEqual([]);
});

it.each(['running', 'waiting'] as const)('preserves %s calls admitted while disabled without retroactive admission analytics', async state => {
  const f = fixture(false), gate = deferred(), metadata = f.metadata();
  const payload = { private: 'LIVE_ONLY' };
  f.block(state === 'waiting');
  const action = vi.fn(() => gate.promise);
  const pending = f.queue.run(metadata, payload, new AbortController().signal, action);
  await vi.advanceTimersByTimeAsync(1000);
  expect(f.queue.state()[state]).toBe(1);
  if (state === 'waiting') expect(f.queue.inspect(metadata.requestId)).toEqual(payload);
  f.flags.enabled = true; f.exporter.syncEnabled();
  f.block(false);
  await vi.advanceTimersByTimeAsync(100);
  gate.resolve();
  await pending;
  expect(action).toHaveBeenCalledTimes(1);
  expect(f.queue.state()).toMatchObject({ running: 0, waiting: 0, requestsByTool: {}, timingsByTool: {} });
  expect(f.queue.events()).toEqual([]);
  expect(f.queue.processing()?.processedLastMinute).toBe(0);
  await f.queue.run(f.metadata(), {}, new AbortController().signal, async () => {});
  expect(f.queue.state().requestsByTool).toEqual({ 'wm-document-query': 1 });
  expect(f.queue.processing()?.processedLastMinute).toBe(1);
});

it('invalidates running and waiting admission analytics across an off/on collection boundary', async () => {
  const f = fixture(), gate = deferred();
  f.queue.configure({ ...DEFAULT_TOOL_QUEUE_SETTINGS, maxConcurrency: 1 }, f.queue.state().settings);
  const first = f.queue.run(f.metadata(), {}, new AbortController().signal, () => gate.promise);
  const queued = f.metadata(), payload = { private: 'STILL_INSPECTABLE' };
  const next = f.queue.run(queued, payload, new AbortController().signal, async () => {});
  await vi.advanceTimersByTimeAsync(100);
  f.flags.enabled = false; f.exporter.syncEnabled();
  f.flags.enabled = true; f.exporter.syncEnabled();
  expect(f.queue.inspect(queued.requestId)).toEqual(payload);
  expect(JSON.stringify(f.queue.state().items)).not.toContain('collectionGeneration');
  gate.resolve();
  await Promise.all([first, next]);
  expect(f.queue.events()).toEqual([]);
  expect(f.queue.state().timingsByTool).toEqual({});
  expect(f.queue.processing()?.processedLastMinute).toBe(0);
  expect(f.queue.state().requestsByTool).toEqual({ 'wm-document-query': 2 });
});
