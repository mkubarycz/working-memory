/**
 * Windows process supervisor (Task Scheduler at-logon task).
 *
 * Phase 1 stub. The daemon binary is identical cross-platform; only this
 * install manifest differs. Implemented in a later phase.
 */

import {
  NotImplementedLauncherError,
  type LauncherAdapter,
  type LauncherInstallOptions,
  type LauncherStatus,
} from './types.js';

const DETAIL = 'Task Scheduler at-logon task not implemented (Phase 1 stub)';

export class TaskSchedulerLauncher implements LauncherAdapter {
  readonly platform: NodeJS.Platform = 'win32';
  readonly label = 'WorkingMemoryControlPlane';

  install(_opts: LauncherInstallOptions): void {
    throw new NotImplementedLauncherError('win32', DETAIL);
  }

  uninstall(): void {
    throw new NotImplementedLauncherError('win32', DETAIL);
  }

  status(): LauncherStatus {
    throw new NotImplementedLauncherError('win32', DETAIL);
  }
}
