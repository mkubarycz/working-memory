/**
 * Unit tests for `ControlPlaneHost.storeHome`.
 *
 * The getter locates the directory the daemon opens `journal.sqlite` under so
 * the panel auto-refresh watcher (feature:panel-auto-refresh) can watch those
 * files for out-of-process daemon writes. It must resolve lazily — WITHOUT
 * `start()` having run — using the same precedence the daemon uses:
 *   env `WM_CONTROL_PLANE_HOME` > setting `controlPlane.storePath` > per-OS default.
 * And it must cache the result so repeated reads are cheap and stable.
 */

import { test, expect, vi, afterEach } from 'vitest';

// Mutable setting value the mocked vscode config returns for
// `controlPlane.storePath`, so each test can drive the resolution precedence.
const cfg = vi.hoisted(() => ({ storePath: undefined as string | undefined }));

vi.mock('vscode', () => ({
  window: { createOutputChannel: () => ({ dispose: () => {} }) },
  workspace: {
    getConfiguration: () => ({
      get: (key: string) => (key === 'controlPlane.storePath' ? cfg.storePath : undefined),
    }),
  },
}));

function makeContext(): unknown {
  return { subscriptions: [] as Array<{ dispose: () => void }>, extensionPath: '/ext' };
}

afterEach(() => {
  cfg.storePath = undefined;
  delete process.env.WM_CONTROL_PLANE_HOME;
});

test('storeHome honours the WM_CONTROL_PLANE_HOME env override (before start())', async () => {
  process.env.WM_CONTROL_PLANE_HOME = '/tmp/wm-override';
  const { ControlPlaneHost } = await import('../src/controlPlaneHost');
  const host = new ControlPlaneHost(makeContext() as never);

  expect(host.storeHome).toBe('/tmp/wm-override');
});

test('storeHome falls back to the controlPlane.storePath setting when no env override', async () => {
  cfg.storePath = '/opt/wm-setting';
  const { ControlPlaneHost } = await import('../src/controlPlaneHost');
  const host = new ControlPlaneHost(makeContext() as never);

  expect(host.storeHome).toBe('/opt/wm-setting');
});

test('storeHome caches its first resolution (env change afterwards is ignored)', async () => {
  process.env.WM_CONTROL_PLANE_HOME = '/tmp/wm-first';
  const { ControlPlaneHost } = await import('../src/controlPlaneHost');
  const host = new ControlPlaneHost(makeContext() as never);

  const first = host.storeHome;
  process.env.WM_CONTROL_PLANE_HOME = '/tmp/wm-second';

  expect(host.storeHome).toBe(first);
  expect(first).toBe('/tmp/wm-first');
});
