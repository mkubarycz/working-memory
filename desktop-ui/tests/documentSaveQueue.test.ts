import { afterEach, describe, expect, it, vi } from 'vitest';
import { createDocumentSaveQueue } from '../src/renderer/documentSaveQueue';

afterEach(() => vi.useRealTimers());

describe('document save queue', () => {
  it('merges rapid edits for the same document into one save', async () => {
    vi.useFakeTimers();
    const save = vi.fn(async (_key: string, patch: { title?: string; status?: string }) => patch);
    const queue = createDocumentSaveQueue({ delayMs: 350, save });

    queue.schedule('topic:one', { title: 'Renamed' });
    queue.schedule('topic:one', { status: 'closed' });
    await vi.advanceTimersByTimeAsync(350);

    expect(save).toHaveBeenCalledOnce();
    expect(save).toHaveBeenCalledWith('topic:one', { title: 'Renamed', status: 'closed' });
  });

  it('keeps pending saves independent across document tabs', async () => {
    vi.useFakeTimers();
    const save = vi.fn(async (_key: string, patch: { title?: string }) => patch);
    const queue = createDocumentSaveQueue({ delayMs: 350, save });

    queue.schedule('topic:one', { title: 'One' });
    queue.schedule('topic:two', { title: 'Two' });
    await vi.advanceTimersByTimeAsync(350);

    expect(save).toHaveBeenCalledTimes(2);
    expect(save).toHaveBeenCalledWith('topic:one', { title: 'One' });
    expect(save).toHaveBeenCalledWith('topic:two', { title: 'Two' });
  });

  it('serializes writes for one document', async () => {
    vi.useFakeTimers();
    const finishes: Array<() => void> = [];
    const save = vi.fn((_key: string, patch: { title?: string }) => new Promise<{ title?: string }>((resolve) => {
      finishes.push(() => resolve(patch));
    }));
    const queue = createDocumentSaveQueue({ delayMs: 350, save });

    queue.schedule('topic:one', { title: 'First' });
    await vi.advanceTimersByTimeAsync(350);
    queue.schedule('topic:one', { title: 'Second' });
    await vi.advanceTimersByTimeAsync(350);
    expect(save).toHaveBeenCalledTimes(1);

    finishes.shift()?.();
    await vi.waitFor(() => expect(save).toHaveBeenCalledTimes(2));
    expect(save).toHaveBeenLastCalledWith('topic:one', { title: 'Second' });

    queue.schedule('topic:one', { title: 'Third' });
    await vi.advanceTimersByTimeAsync(350);
    expect(save).toHaveBeenCalledTimes(2);

    finishes.shift()?.();
    await vi.waitFor(() => expect(save).toHaveBeenCalledTimes(3));
    expect(save).toHaveBeenLastCalledWith('topic:one', { title: 'Third' });
    finishes.shift()?.();
  });

  it('flushes pending documents before an environment switch', async () => {
    vi.useFakeTimers();
    const save = vi.fn(async (_key: string, patch: { title?: string }) => patch);
    const queue = createDocumentSaveQueue({ delayMs: 350, save });
    queue.schedule('topic:one', { title: 'One' });
    queue.schedule('topic:two', { title: 'Two' });

    await queue.flushAll();

    expect(save).toHaveBeenCalledTimes(2);
  });

  it('rejects a flush and preserves failed intent for a later retry', async () => {
    vi.useFakeTimers();
    const save = vi.fn()
      .mockRejectedValueOnce(new Error('conflict'))
      .mockImplementation(async (_key: string, patch: { title?: string; status?: string }) => patch);
    const queue = createDocumentSaveQueue({ delayMs: 350, save });
    queue.schedule('topic:one', { title: 'Renamed' });

    await expect(queue.flushAll()).rejects.toThrow('conflict');
    queue.schedule('topic:one', { status: 'closed' });
    await queue.flushAll();

    expect(save).toHaveBeenLastCalledWith('topic:one', { title: 'Renamed', status: 'closed' });
  });

  it('drains edits scheduled while an earlier save is in flight', async () => {
    vi.useFakeTimers();
    let finishFirst: (() => void) | undefined;
    const save = vi.fn((_key: string, patch: { title?: string }) => save.mock.calls.length === 1
      ? new Promise<{ title?: string }>((resolve) => { finishFirst = () => resolve(patch); })
      : Promise.resolve(patch));
    const queue = createDocumentSaveQueue({ delayMs: 350, save });
    queue.schedule('topic:one', { title: 'First' });
    const flushing = queue.flushAll();
    await vi.waitFor(() => expect(save).toHaveBeenCalledTimes(1));

    queue.schedule('topic:one', { title: 'Second' });
    finishFirst?.();
    await flushing;

    expect(save).toHaveBeenCalledTimes(2);
    expect(save).toHaveBeenLastCalledWith('topic:one', { title: 'Second' });
  });

  it('suppresses an older error and retries its intent with a newer queued edit', async () => {
    vi.useFakeTimers();
    let failFirst: (() => void) | undefined;
    const onError = vi.fn();
    const save = vi.fn((_key: string, patch: { title?: string; status?: string }) => save.mock.calls.length === 1
      ? new Promise<{ title?: string; status?: string }>((_resolve, reject) => {
          failFirst = () => reject(new Error('stale conflict'));
        })
      : Promise.resolve(patch));
    const queue = createDocumentSaveQueue({ delayMs: 350, save, onError });
    queue.schedule('topic:one', { title: 'Renamed' });
    await vi.advanceTimersByTimeAsync(350);
    queue.schedule('topic:one', { status: 'closed' });
    await vi.advanceTimersByTimeAsync(350);

    failFirst?.();
    await queue.flushAll();

    expect(onError).not.toHaveBeenCalled();
    expect(save).toHaveBeenLastCalledWith('topic:one', { title: 'Renamed', status: 'closed' });
  });

  it('does not start a queued write after the queue is cleared', async () => {
    vi.useFakeTimers();
    let finishFirst: (() => void) | undefined;
    const save = vi.fn((_key: string, patch: { title?: string }) => new Promise<{ title?: string }>((resolve) => {
      finishFirst ??= () => resolve(patch);
    }));
    const queue = createDocumentSaveQueue({ delayMs: 350, save });
    queue.schedule('topic:one', { title: 'First' });
    await vi.advanceTimersByTimeAsync(350);
    queue.schedule('topic:one', { title: 'Second' });
    await vi.advanceTimersByTimeAsync(350);

    queue.clear();
    finishFirst?.();
    await vi.waitFor(() => expect(save).toHaveBeenCalledTimes(1));
  });

  it('does not apply an older result while a newer edit is pending', async () => {
    vi.useFakeTimers();
    let finishFirst: (() => void) | undefined;
    const onSaved = vi.fn();
    const save = vi.fn((_key: string, patch: { title?: string }) => new Promise<{ title?: string }>((resolve) => {
      if (!finishFirst) finishFirst = () => resolve(patch);
      else resolve(patch);
    }));
    const queue = createDocumentSaveQueue({ delayMs: 350, save, onSaved });
    queue.schedule('topic:one', { title: 'First' });
    await vi.advanceTimersByTimeAsync(350);
    queue.schedule('topic:one', { title: 'Second' });

    finishFirst?.();
    await Promise.resolve();
    expect(onSaved).not.toHaveBeenCalled();
  });
});
