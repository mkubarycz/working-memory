/**
 * Launcher adapter factory + public surface.
 */

import type { LauncherAdapter } from './types.js';
import { LaunchdLauncher } from './launchd.js';
import { TaskSchedulerLauncher } from './windows.js';
import { SystemdLauncher } from './linux.js';

export * from './types.js';
export { renderLaunchdPlist, launchAgentPlistPath, LaunchdLauncher } from './launchd.js';
export type { LaunchdPlistOptions } from './launchd.js';
export { TaskSchedulerLauncher } from './windows.js';
export { SystemdLauncher } from './linux.js';

/**
 * Return the process-supervisor adapter for the given platform (defaults to
 * the current one). Unknown POSIX platforms fall back to the systemd adapter.
 */
export function getLauncher(platform: NodeJS.Platform = process.platform): LauncherAdapter {
  switch (platform) {
    case 'darwin':
      return new LaunchdLauncher();
    case 'win32':
      return new TaskSchedulerLauncher();
    case 'linux':
      return new SystemdLauncher();
    default:
      return new SystemdLauncher();
  }
}
