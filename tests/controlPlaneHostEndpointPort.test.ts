/**
 * Unit tests for `ControlPlaneHost` endpoint-port resolution in SERVICE mode
 * (WM 13.0.1 "mcp-registration-shared-port-crossover" fix).
 *
 * In service mode the extension does NOT spawn a daemon — an external OS
 * service owns it — so the host resolves the endpoint port synchronously from
 * the `workingMemory.controlPlane.port` setting (dev env override > setting >
 * well-known default) and exposes it via `endpointPort` + fires
 * `onDidChangeEndpointPort`. No process is spawned, so this stays a pure unit
 * test.
 */

import { test, expect, vi, afterEach } from 'vitest';

// Mutable config the mocked vscode returns, so each test drives precedence.
const cfg = vi.hoisted(() => ({
  hosting: 'service' as string | undefined,
  storePath: '/tmp/wm-store' as string | undefined,
  port: undefined as number | undefined,
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
    ExtensionMode: { Production: 2, Development: 1, Test: 3 },
    window: { createOutputChannel: () => ({ append: () => {}, appendLine: () => {}, dispose: () => {} }) },
    workspace: {
      getConfiguration: () => ({
        get: (key: string) => {
          if (key === 'controlPlane.hosting') return cfg.hosting;
          if (key === 'controlPlane.storePath') return cfg.storePath;
          if (key === 'controlPlane.port') return cfg.port;
          return undefined;
        },
      }),
    },
  };
});

function makeContext(extensionMode = 2 /* Production */): unknown {
  return {
    subscriptions: [] as Array<{ dispose: () => void }>,
    extensionPath: '/ext',
    extensionMode,
  };
}

afterEach(() => {
  cfg.hosting = 'service';
  cfg.storePath = '/tmp/wm-store';
  cfg.port = undefined;
  delete process.env.WM_CONTROL_PLANE_PORT;
});

test('service mode drives the endpoint from the controlPlane.port setting', async () => {
  cfg.port = 8080;
  const { ControlPlaneHost } = await import('../src/controlPlaneHost');
  const host = new ControlPlaneHost(makeContext(2) as never);

  const seen: number[] = [];
  host.onDidChangeEndpointPort((p) => seen.push(p));

  await host.start();

  expect(host.endpointPort).toBe(8080);
  expect(seen).toEqual([8080]);
});

test('service mode falls back to the well-known default (7717) when unset', async () => {
  cfg.port = undefined;
  const { ControlPlaneHost } = await import('../src/controlPlaneHost');
  const host = new ControlPlaneHost(makeContext(2) as never);

  await host.start();

  expect(host.endpointPort).toBe(7717);
});

test('service mode IGNORES the WM_CONTROL_PLANE_PORT env in Production', async () => {
  process.env.WM_CONTROL_PLANE_PORT = '9999';
  cfg.port = 8080;
  const { ControlPlaneHost } = await import('../src/controlPlaneHost');
  const host = new ControlPlaneHost(makeContext(2 /* Production */) as never);

  await host.start();

  // Env skipped → resolves from the setting, not the leaked sandbox port.
  expect(host.endpointPort).toBe(8080);
});

test('service mode honours the WM_CONTROL_PLANE_PORT env in Development', async () => {
  process.env.WM_CONTROL_PLANE_PORT = '9999';
  cfg.port = 8080;
  const { ControlPlaneHost } = await import('../src/controlPlaneHost');
  const host = new ControlPlaneHost(makeContext(1 /* Development */) as never);

  await host.start();

  expect(host.endpointPort).toBe(9999);
});
