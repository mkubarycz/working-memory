import { describe, expect, it, vi } from 'vitest';
import { createGracefulShutdown } from '../src/main/gracefulShutdown';

describe('graceful shutdown', () => {
  it('interrupts active agent runs before disposing and reissuing quit', async () => {
    const calls: string[] = [];
    const shutdown = createGracefulShutdown({
      resetAgent: async () => { calls.push('reset'); },
      disposeEnvironment: async () => { calls.push('dispose'); },
      quit: () => { calls.push('quit'); },
    });
    const event = { preventDefault: vi.fn() };

    await shutdown(event);

    expect(event.preventDefault).toHaveBeenCalledOnce();
    expect(calls).toEqual(['reset', 'dispose', 'quit']);

    const finalEvent = { preventDefault: vi.fn() };
    await shutdown(finalEvent);
    expect(finalEvent.preventDefault).not.toHaveBeenCalled();
  });

  it('still disposes and quits when interruption fails', async () => {
    const calls: string[] = [];
    const onError = vi.fn();
    const shutdown = createGracefulShutdown({
      resetAgent: async () => { calls.push('reset'); throw new Error('failed'); },
      disposeEnvironment: async () => { calls.push('dispose'); },
      quit: () => { calls.push('quit'); },
      onError,
    });

    await shutdown({ preventDefault() {} });
    expect(calls).toEqual(['reset', 'dispose', 'quit']);
    expect(onError).toHaveBeenCalledWith(expect.objectContaining({ message: 'failed' }));
  });

  it('quits after the timeout when interruption never settles', async () => {
    vi.useFakeTimers();
    const calls: string[] = [];
    const onError = vi.fn();
    const shutdown = createGracefulShutdown({
      resetAgent: () => new Promise(() => {}),
      disposeEnvironment: async () => { calls.push('dispose'); },
      quit: () => { calls.push('quit'); },
      onError,
      timeoutMs: 100,
    });

    const result = shutdown({ preventDefault() {} });
    await vi.advanceTimersByTimeAsync(100);
    await result;

    expect(calls).toEqual(['dispose', 'quit']);
    expect(onError).toHaveBeenCalledWith(expect.objectContaining({ message: 'Agent reset timed out after 100ms' }));
    vi.useRealTimers();
  });
});
