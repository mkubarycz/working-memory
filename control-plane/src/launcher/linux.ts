/**
 * Linux process supervisor (systemd user service).
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

const DETAIL = 'systemd user service not implemented (Phase 1 stub)';

export class SystemdLauncher implements LauncherAdapter {
  readonly platform: NodeJS.Platform = 'linux';
  readonly label = 'working-memory-control-plane';

  install(_opts: LauncherInstallOptions): void {
    throw new NotImplementedLauncherError('linux', DETAIL);
  }

  uninstall(): void {
    throw new NotImplementedLauncherError('linux', DETAIL);
  }

  status(): LauncherStatus {
    throw new NotImplementedLauncherError('linux', DETAIL);
  }
}
