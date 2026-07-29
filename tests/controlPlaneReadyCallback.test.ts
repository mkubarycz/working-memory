/**
 * Tests for the control-plane MCP registration path (WM 13.0.1
 * "mcp-registration-shared-port-crossover" fix).
 *
 * The registration NO LONGER discovers the endpoint by polling the shared
 * `control-plane.port.json` file (which two racing daemons can cross). Instead
 * it sources the endpoint port from the {@link ControlPlaneHost} — the
 * authoritative owner of the port we spawned (embedded) or the configured
 * service port (service / auto-as-client).
 *
 * These tests prove:
 *  - the `onControlPlaneReady` callback fires once the host reports a port
 *    (both the already-known-at-registration and the fire-later cases);
 *  - the registered MCP endpoint URL uses EXACTLY the host's owned port;
 *  - registration reads nothing from the port file (node:fs is not consulted).
 */

import { test, expect, vi, afterEach } from 'vitest';

// If any code path tried to read the shared port file, this mock would let us
// notice — the fix must NOT touch it during registration.
const fsMock = vi.hoisted(() => ({ readCalls: 0 }));

vi.mock('node:fs', () => ({
  readFileSync: () => {
    fsMock.readCalls += 1;
    throw new Error('ENOENT: registration must not read the port file');
  },
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
    dispose(): void {
      this._listeners = [];
    }
  }
  return {
    EventEmitter,
    Uri: { parse: (s: string) => ({ toString: () => s }) },
    ExtensionMode: { Production: 2, Development: 1, Test: 3 },
    workspace: { workspaceFolders: [] },
    lm: {
      registerMcpServerDefinitionProvider: (_id: string, provider: unknown) => {
        capturedProvider = provider as ProviderLike;
        return { dispose: () => {} };
      },
    },
    McpHttpServerDefinition: class {
      constructor(
        public label: string,
        public uri: { toString(): string },
        public headers?: unknown,
        public version?: string,
      ) {}
    },
  };
});

interface ProviderLike {
  onDidChangeMcpServerDefinitions?: (l: () => void) => { dispose: () => void };
  provideMcpServerDefinitions: () => Array<{ uri: { toString(): string }; version?: string }>;
}

let capturedProvider: ProviderLike | undefined;

// Minimal fake of the ControlPlaneHost's port-source surface, so we can drive
// endpoint-port resolution deterministically without spawning a daemon.
function makePortSource(initial: number | undefined) {
  type Listener = (p: number) => void;
  const listeners: Listener[] = [];
  return {
    _port: initial,
    get endpointPort(): number | undefined {
      return this._port;
    },
    onDidChangeEndpointPort: (l: Listener) => {
      listeners.push(l);
      return { dispose: () => {} };
    },
    fire(port: number): void {
      this._port = port;
      for (const l of listeners) {
        l(port);
      }
    },
  };
}

function makeContext(): unknown {
  return {
    subscriptions: [] as Array<{ dispose: () => void }>,
    extensionMode: 2, // Production → maybeInstallWm2Agent returns early
  };
}

afterEach(() => {
  capturedProvider = undefined;
  fsMock.readCalls = 0;
});

test('onControlPlaneReady fires when the host reports a port later (embedded)', async () => {
  const { initControlPlaneIntegration } = await import('../src/controlPlane');
  const host = makePortSource(undefined);
  const ready = vi.fn();

  initControlPlaneIntegration(makeContext() as never, host as never, ready);

  // Not known yet at registration → provider returns nothing, ready not called.
  expect(host.endpointPort).toBeUndefined();
  expect(capturedProvider?.provideMcpServerDefinitions()).toEqual([]);
  expect(ready).not.toHaveBeenCalled();

  // Host learns the embedded child's ephemeral bound port.
  host.fire(54123);

  expect(ready).toHaveBeenCalledTimes(1);
  const defs = capturedProvider!.provideMcpServerDefinitions();
  expect(defs).toHaveLength(1);
  expect(defs[0].uri.toString()).toBe('http://127.0.0.1:54123/mcp');
});

test('onControlPlaneReady fires immediately when the port is already known (service)', async () => {
  const { initControlPlaneIntegration } = await import('../src/controlPlane');
  const host = makePortSource(7717);
  const ready = vi.fn();

  initControlPlaneIntegration(makeContext() as never, host as never, ready);

  expect(ready).toHaveBeenCalledTimes(1);
  const defs = capturedProvider!.provideMcpServerDefinitions();
  expect(defs[0].uri.toString()).toBe('http://127.0.0.1:7717/mcp');
});

test('registration registers EXACTLY the host-owned port, not the port file', async () => {
  const { initControlPlaneIntegration } = await import('../src/controlPlane');
  const host = makePortSource(60001);
  const ready = vi.fn();

  initControlPlaneIntegration(makeContext() as never, host as never, ready);

  const defs = capturedProvider!.provideMcpServerDefinitions();
  expect(defs[0].uri.toString()).toBe('http://127.0.0.1:60001/mcp');
  // The port file must never be read on the registration path.
  expect(fsMock.readCalls).toBe(0);
});

test('a new host port updates the registered definition (fresh embedded daemon)', async () => {
  const { initControlPlaneIntegration } = await import('../src/controlPlane');
  const host = makePortSource(50000);
  const ready = vi.fn();

  initControlPlaneIntegration(makeContext() as never, host as never, ready);
  expect(capturedProvider!.provideMcpServerDefinitions()[0].uri.toString()).toBe(
    'http://127.0.0.1:50000/mcp',
  );

  // A fresh daemon binds a new ephemeral port; the version must change too so
  // VS Code busts its cached tool manifest.
  const before = capturedProvider!.provideMcpServerDefinitions()[0].version;
  host.fire(50999);
  const after = capturedProvider!.provideMcpServerDefinitions()[0];
  expect(after.uri.toString()).toBe('http://127.0.0.1:50999/mcp');
  expect(after.version).not.toBe(before);
  // ready still only fires once, on the first resolution.
  expect(ready).toHaveBeenCalledTimes(1);
});
