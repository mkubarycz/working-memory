import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { acquireOfflineMaintenanceLock } from '../src/lockfile';
import { runDaemon } from '../src/daemon';

const directories: string[] = [];
const previousHome = process.env.WM_CONTROL_PLANE_HOME;

afterEach(() => {
  if (previousHome === undefined) delete process.env.WM_CONTROL_PLANE_HOME;
  else process.env.WM_CONTROL_PLANE_HOME = previousHome;
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

it('refuses to open the store while an offline maintenance tool holds the marker', async () => {
  const home = mkdtempSync(join(tmpdir(), 'wm-daemon-maintenance-'));
  directories.push(home);
  process.env.WM_CONTROL_PLANE_HOME = home;
  const maintenance = acquireOfflineMaintenanceLock(join(home, 'journal.sqlite'));
  try {
    await expect(runDaemon()).rejects.toThrow('offline database maintenance operation is active');
  } finally {
    maintenance.release();
  }
});
