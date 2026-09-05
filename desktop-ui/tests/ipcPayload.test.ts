import { describe, expect, it } from 'vitest';
import { toIpcPayload } from '../src/preload/ipcPayload';

function reactiveProxy<T extends object>(value: T, cache = new WeakMap<object, object>()): T {
  const existing = cache.get(value);
  if (existing) return existing as T;
  const proxy = new Proxy(value, {
    get(target, property, receiver) {
      const nested = Reflect.get(target, property, receiver) as unknown;
      return nested !== null && typeof nested === 'object'
        ? reactiveProxy(nested as object, cache)
        : nested;
    },
  });
  cache.set(value, proxy);
  return proxy;
}

describe('toIpcPayload', () => {
  it('converts nested reactive-style proxies into structured-cloneable values', () => {
    const menuItem = reactiveProxy({
      kind: 'action' as const,
      title: 'Send to In Progress',
      icon: 'arrow-circle-down',
      enabled: true,
      action: {
        command: 'working-memory.setWorkstreamSection',
        title: 'Send to In Progress',
        args: [{ slug: 'queued-item', section: 'progress' }],
      },
    });
    const args = menuItem.action.args;

    expect(() => structuredClone(args)).toThrow();

    const payload = toIpcPayload(args);
    expect(payload).toEqual([{ slug: 'queued-item', section: 'progress' }]);
    expect(() => structuredClone(payload)).not.toThrow();
  });

  it('preserves an omitted optional argument', () => {
    expect(toIpcPayload(undefined)).toBeUndefined();
  });

  it('preserves structured-clone values that JSON serialization loses', () => {
    const payload = toIpcPayload({ count: 1n, missing: undefined, created: new Date(0) });

    expect(payload).toEqual({ count: 1n, missing: undefined, created: new Date(0) });
    expect(() => structuredClone(payload)).not.toThrow();
  });

  it('normalizes null-prototype records to ordinary cloneable objects', () => {
    const input = Object.assign(Object.create(null) as Record<string, unknown>, {
      slug: 'queued-item',
      section: 'progress',
    });

    const payload = toIpcPayload(input);

    expect(Object.getPrototypeOf(payload)).toBe(Object.prototype);
    expect(payload).toEqual({ slug: 'queued-item', section: 'progress' });
    expect(() => structuredClone(payload)).not.toThrow();
  });

  it('rejects unsupported values instead of silently dropping them', () => {
    expect(() => toIpcPayload({ callback: () => undefined })).toThrow('Unsupported IPC payload value: function');
  });
});