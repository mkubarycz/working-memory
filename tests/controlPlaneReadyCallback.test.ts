/**
 * Regression test for the "Workstreams panel blank on first load" bug.
 *
 * On activation the control-plane daemon spawns concurrently, so its port file
 * does not exist yet when the panel first renders. `initControlPlaneIntegration`
 * accepts an `onControlPlaneReady` callback that the port-file discovery poll
 * fires once the daemon is discovered — the extension uses it to refresh the
 * panel so it populates without a manual refresh.
 *
 * These tests prove the callback is invoked on discovery success and NOT on
 * discovery timeout.
 */

import { test, expect, vi, afterEach } from 'vitest';

// Mutable port-file read behaviour, hoisted so the node:fs mock can reference it.
const fsMock = vi.hoisted(() => ({
  readImpl: (_p: string): string => {
    throw new Error('ENOENT: port file missing');
  },
}));

vi.mock('node:fs', () => ({
  readFileSync: (p: string) => fsMock.readImpl(p),
  mkdirSync: () => {},
  writeFileSync: () => {},
}));

vi.mock('vscode', () => {
  class EventEmitter<T> {
    private _listeners: Array<(e: T) => void> = [];
    get event() {
      return (listener: (e: T) => void) => {
        this._listeners.push(listener);
        return { dispose: () => {} };
      };
    }
    fire(data: T): void {
      for (const l of this._listeners) {
        l(data);
      }
    }
  }
  return {
    EventEmitter,
    Uri: { parse: (s: string) => ({ toString: () => s }) },
    ExtensionMode: { Production: 2, Development: 1, Test: 3 },
    workspace: { workspaceFolders: [] },
    lm: {
      registerMcpServerDefinitionProvider: () => ({ dispose: () => {} }),
    },
    McpHttpServerDefinition: class {
      constructor(
        public label: string,
        public uri: unknown,
        public headers?: unknown,
        public version?: string,
      ) {}
    },
  };
});

function makeContext(): unknown {
  return {
    subscriptions: [] as Array<{ dispose: () => void }>,
    extensionMode: 2, // Production → maybeInstallWm2Agent returns early
  };
}

afterEach(() => {
  vi.useRealTimers();
});

test('onControlPlaneReady fires once the port file is discovered', async () => {
  fsMock.readImpl = () => JSON.stringify({ port: 7717, pid: 4242 });
  const { initControlPlaneIntegration } = await import('../src/controlPlane');
  const ready = vi.fn();

  initControlPlaneIntegration(makeContext() as never, ready);

  // Discovery reads the port file immediately (first poll iteration) and
  // resolves on the microtask queue — flush a couple of turns.
  await Promise.resolve();
  await Promise.resolve();

  expect(ready).toHaveBeenCalledTimes(1);
});

test('onControlPlaneReady is NOT invoked when discovery times out', async () => {
  vi.useFakeTimers();
  fsMock.readImpl = () => {
    throw new Error('ENOENT: port file missing');
  };
  const { initControlPlaneIntegration } = await import('../src/controlPlane');
  const ready = vi.fn();

  initControlPlaneIntegration(makeContext() as never, ready);

  // Advance past the 10s discovery deadline so the poll gives up.
  await vi.advanceTimersByTimeAsync(11_000);

  expect(ready).not.toHaveBeenCalled();
});
