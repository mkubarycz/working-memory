import { afterEach, expect, it, vi } from 'vitest';
import { startVisiblePolling } from '../src/renderer/visiblePolling';

class Visibility extends EventTarget {
  hidden = false;
  show(visible: boolean): void {
    this.hidden = !visible;
    this.dispatchEvent(new Event('visibilitychange'));
  }
}
const cleanup: Array<() => void> = [];
afterEach(() => { for (const stop of cleanup.splice(0)) stop(); vi.useRealTimers(); vi.restoreAllMocks(); });

it('refreshes only while visible, clears background timers and refreshes immediately on return', async () => {
  vi.useFakeTimers();
  const visibility = new Visibility(), refresh = vi.fn(async () => {});
  cleanup.push(startVisiblePolling(refresh, 2000, visibility));
  expect(refresh).toHaveBeenCalledOnce();
  await vi.advanceTimersByTimeAsync(2000);
  expect(refresh).toHaveBeenCalledTimes(2);
  visibility.show(false);
  expect(vi.getTimerCount()).toBe(0);
  await vi.advanceTimersByTimeAsync(30000);
  expect(refresh).toHaveBeenCalledTimes(2);
  visibility.show(true);
  expect(refresh).toHaveBeenCalledTimes(3);
});

it('does not make the initial request for a hidden view', async () => {
  vi.useFakeTimers();
  const visibility = new Visibility(), refresh = vi.fn(async () => {});
  visibility.show(false);
  cleanup.push(startVisiblePolling(refresh, 10000, visibility));
  await vi.advanceTimersByTimeAsync(60000);
  expect(refresh).not.toHaveBeenCalled();
  expect(vi.getTimerCount()).toBe(0);
  visibility.show(true);
  expect(refresh).toHaveBeenCalledOnce();
});

it('honors the fifteen-second default cadence without refreshing early', async () => {
  vi.useFakeTimers();
  const visibility = new Visibility(), refresh = vi.fn(async () => {});
  cleanup.push(startVisiblePolling(refresh, 15000, visibility));
  await vi.advanceTimersByTimeAsync(14999);
  expect(refresh).toHaveBeenCalledOnce();
  await vi.advanceTimersByTimeAsync(1);
  expect(refresh).toHaveBeenCalledTimes(2);
});

it('never overlaps slow requests and refreshes once after returning during an in-flight request', async () => {
  vi.useFakeTimers();
  const visibility = new Visibility();
  let release!: () => void;
  const pending = new Promise<void>(resolve => { release = resolve; });
  const refresh = vi.fn(async () => { await pending; });
  cleanup.push(startVisiblePolling(refresh, 2000, visibility));
  await vi.advanceTimersByTimeAsync(10000);
  expect(refresh).toHaveBeenCalledOnce();
  visibility.show(false);
  visibility.show(true);
  expect(refresh).toHaveBeenCalledOnce();
  release();
  await vi.advanceTimersByTimeAsync(0);
  expect(refresh).toHaveBeenCalledTimes(2);
  expect(vi.getTimerCount()).toBe(1);
});

it('does not schedule more requests after disposal, including completion of an in-flight request', async () => {
  vi.useFakeTimers();
  const visibility = new Visibility();
  let release!: () => void;
  const pending = new Promise<void>(resolve => { release = resolve; });
  const refresh = vi.fn(() => pending);
  const stop = startVisiblePolling(refresh, 10000, visibility);
  cleanup.push(stop);
  stop();
  release();
  await vi.advanceTimersByTimeAsync(30000);
  visibility.show(false);
  visibility.show(true);
  expect(refresh).toHaveBeenCalledOnce();
  expect(vi.getTimerCount()).toBe(0);
});

it('reports unexpected refresh failures and retries only while visible', async () => {
  vi.useFakeTimers();
  const visibility = new Visibility(), failure = new Error('test failure');
  const log = vi.spyOn(console, 'error').mockImplementation(() => {});
  const refresh = vi.fn(async () => { throw failure; });
  cleanup.push(startVisiblePolling(refresh, 2000, visibility));
  await vi.advanceTimersByTimeAsync(0);
  expect(log).toHaveBeenCalledWith('[diagnostics] Automatic refresh failed:', failure);
  visibility.show(false);
  await vi.advanceTimersByTimeAsync(10000);
  expect(refresh).toHaveBeenCalledOnce();
});
