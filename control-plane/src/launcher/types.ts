/**
 * Process-supervisor launcher adapter.
 *
 * The daemon binary is identical on every OS; only the install manifest for
 * the platform's process supervisor differs (launchd / Task Scheduler /
 * systemd). This small interface isolates that seam.
 */

export interface LauncherInstallOptions {
  /** Absolute path to the Node executable that runs the daemon. */
  nodePath: string;
  /** Absolute path to the compiled daemon entry script. */
  scriptPath: string;
  /** Extra Node flags (e.g. `--experimental-sqlite`), inserted before the script. */
  nodeArgs?: string[];
  /** Environment variables injected into the service process. */
  env?: Record<string, string>;
  /** Where the supervisor should write the service's stdout. */
  stdoutPath?: string;
  /** Where the supervisor should write the service's stderr. */
  stderrPath?: string;
  /** Working directory for the service process. */
  workingDirectory?: string;
}

export interface LauncherStatus {
  /** True when an install manifest exists for the service. */
  installed: boolean;
  /** True/false when liveness could be determined; undefined when unknown. */
  running?: boolean;
  /** Human-readable detail (e.g. the manifest path). */
  detail?: string;
}

export interface LauncherAdapter {
  readonly platform: NodeJS.Platform;
  /** Supervisor-specific identifier (launchd Label / task name / unit name). */
  readonly label: string;
  install(opts: LauncherInstallOptions): void | Promise<void>;
  uninstall(): void | Promise<void>;
  status(): LauncherStatus | Promise<LauncherStatus>;
}

export class NotImplementedLauncherError extends Error {
  constructor(
    public readonly targetPlatform: string,
    detail?: string,
  ) {
    super(
      `control-plane process supervisor for '${targetPlatform}' is not implemented yet` +
        (detail ? `: ${detail}` : ''),
    );
    this.name = 'NotImplementedLauncherError';
  }
}
