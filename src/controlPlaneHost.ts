/**
 * Control-plane process supervisor (WM 13.0 "control-plane-hosting-modes",
 * Phase 1 — embedded hosting).
 *
 * Lets the EXTENSION host own the control-plane daemon rather than requiring a
 * separately-installed OS service. Three modes (resolved from env override →
 * setting → default `auto`):
 *
 *  - `service`  — an external OS service owns the process; we do NOT spawn.
 *  - `embedded` — we spawn + supervise the daemon; one ext-host restart fully
 *                 resets the sandbox.
 *  - `auto`     — probe for a healthy running service first; if reachable act
 *                 as a pure client, otherwise behave like `embedded`.
 *
 * The daemon (`out/control-plane/index.js`) opens SQLite via `node:sqlite`,
 * which needs Node ≥ 22.5 (+ `--experimental-sqlite`). VS Code's bundled node
 * (reached via `process.execPath` + `ELECTRON_RUN_AS_NODE=1`) may be older, so
 * embedded spawn has a fallback: if the first child fails fast with the
 * `node:sqlite` unavailable error (or exits non-zero before it could become
 * healthy), we retry once with `node` on PATH and log a clear warning.
 *
 * The MCP registration + port-file discovery still live in `controlPlane.ts`;
 * this module only owns the process lifecycle. The daemon's single-instance
 * lock coordinates with any externally-launched instance, so `auto`/`service`
 * mode won't double-spawn even if a compound also runs the daemon.
 *
 * Pure, VS Code-free helpers (mode + store-home resolution, health-probe URL)
 * live in `controlPlaneShared.ts` so they're unit-testable under vitest.
 */

import * as vscode from 'vscode';
import * as os from 'node:os';
import * as http from 'node:http';
import * as path from 'node:path';
import { readFileSync } from 'node:fs';
import { spawn, execFile, type ChildProcess } from 'node:child_process';
import {
  CONTROL_PLANE_HOME_ENV,
  CONTROL_PLANE_HOSTING_ENV,
  controlPlaneHealthUrl,
  controlPlanePortFilePath,
  parsePortInfo,
  resolveControlPlaneStoreHome,
  resolveHostingMode,
  type ControlPlaneHostingMode,
} from './controlPlaneShared';

/** The daemon entry point, relative to the extension root. */
const DAEMON_ENTRY = path.join('out', 'control-plane', 'index.js');

/** Substring the daemon prints when `node:sqlite` can't be loaded. */
const SQLITE_UNAVAILABLE_MARKER = 'node:sqlite is unavailable';

/** A child that exits within this window is treated as a fast startup failure. */
const QUICK_FAIL_MS = 6_000;

/** Cap on supervised restarts before we give up (avoids a hot crash loop). */
const MAX_RESTARTS = 5;

/** Base backoff between supervised restarts (grows linearly, capped). */
const RESTART_BACKOFF_MS = 1_000;
const RESTART_BACKOFF_CAP_MS = 10_000;

/** Timeout for the `auto`-mode health probe. */
const HEALTH_PROBE_TIMEOUT_MS = 1_500;

/**
 * Supervises the control-plane child process for the lifetime of the extension.
 * Construct once in `activate()`, call `start()`, and `dispose()` from
 * `deactivate()` so the child never outlives the ext host.
 */
export class ControlPlaneHost implements vscode.Disposable {
  private readonly output: vscode.OutputChannel;
  private child: ChildProcess | undefined;
  private disposed = false;
  private restarts = 0;
  private restartTimer: NodeJS.Timeout | undefined;
  /** Flipped once we fall back from `process.execPath` to `node` on PATH. */
  private usedPathNodeFallback = false;
  /** Set when the current child printed the node:sqlite unavailable marker. */
  private sawSqliteError = false;

  private mode: ControlPlaneHostingMode = 'auto';
  private home = '';

  constructor(private readonly context: vscode.ExtensionContext) {
    this.output = vscode.window.createOutputChannel('Working Memory Control Plane');
    this.context.subscriptions.push(this.output);
  }

  /**
   * Resolve mode + store home, then act: `service` → client-only (no spawn);
   * `auto` → probe a running service and only self-host if none is healthy;
   * `embedded` → spawn + supervise. Best-effort: never throws into activation.
   */
  async start(): Promise<void> {
    try {
      const config = vscode.workspace.getConfiguration('workingMemory');
      const settingMode = config.get<string>('controlPlane.hosting');
      const settingPath = config.get<string>('controlPlane.storePath');

      this.mode = resolveHostingMode({
        envValue: process.env[CONTROL_PLANE_HOSTING_ENV],
        settingValue: settingMode,
      });
      this.home = resolveControlPlaneStoreHome({
        homeEnv: { platform: process.platform, env: process.env, homedir: os.homedir() },
        settingPath,
      });

      this.log(`hosting mode = ${this.mode}; store home = ${this.home}`);

      if (this.mode === 'service') {
        this.log('service mode — external OS service owns the daemon; not spawning.');
        return;
      }

      if (this.mode === 'auto') {
        const healthy = await this.probeRunningService();
        if (healthy) {
          this.log('auto mode — a healthy control-plane is already running; acting as client.');
          return;
        }
        this.log('auto mode — no healthy control-plane found; self-hosting (embedded).');
      }

      void this.logChildNodeVersion(process.execPath);
      this.spawnSupervised();
    } catch (err) {
      this.log(`start failed: ${(err as Error).message}`);
      console.error('[working-memory] control-plane host start failed:', err);
    }
  }

  /**
   * Kill the child (SIGTERM then SIGKILL) and stop supervising. Synchronous by
   * design — `deactivate()` isn't reliably awaited, so we fire the kill and
   * return rather than waiting on the child's exit.
   */
  dispose(): void {
    this.disposed = true;
    if (this.restartTimer) {
      clearTimeout(this.restartTimer);
      this.restartTimer = undefined;
    }
    const child = this.child;
    this.child = undefined;
    if (child && child.exitCode === null && child.signalCode === null) {
      try {
        child.kill('SIGTERM');
      } catch {
        /* already gone */
      }
      const killTimer = setTimeout(() => {
        try {
          child.kill('SIGKILL');
        } catch {
          /* already gone */
        }
      }, 2_000);
      child.once('exit', () => clearTimeout(killTimer));
    }
  }

  /** Spawn the daemon and wire supervision + the runtime fallback. */
  private spawnSupervised(): void {
    if (this.disposed) {
      return;
    }
    const useExecPath = !this.usedPathNodeFallback;
    const command = useExecPath ? process.execPath : 'node';
    const indexPath = path.join(this.context.extensionPath, DAEMON_ENTRY);
    const args = ['--experimental-sqlite', indexPath];
    const env = {
      ...process.env,
      ELECTRON_RUN_AS_NODE: '1',
      [CONTROL_PLANE_HOME_ENV]: this.home,
    };

    this.log(
      `spawning daemon via ${useExecPath ? 'VS Code bundled node (process.execPath)' : 'node on PATH'}: ` +
        `${command} ${args.join(' ')}`,
    );

    this.sawSqliteError = false;
    const startedAt = Date.now();
    let child: ChildProcess;
    try {
      child = spawn(command, args, { env, stdio: 'pipe' });
    } catch (err) {
      this.log(`spawn threw: ${(err as Error).message}`);
      this.maybeFallbackOrRestart(startedAt, null);
      return;
    }
    this.child = child;

    child.stdout?.on('data', (chunk: Buffer) => this.pipe(chunk));
    child.stderr?.on('data', (chunk: Buffer) => {
      const text = chunk.toString();
      if (text.includes(SQLITE_UNAVAILABLE_MARKER)) {
        this.sawSqliteError = true;
      }
      this.pipe(chunk);
    });
    child.on('error', (err) => this.log(`child process error: ${err.message}`));
    child.on('exit', (code, signal) => {
      if (this.child === child) {
        this.child = undefined;
      }
      if (this.disposed) {
        return;
      }
      this.log(`daemon exited (code=${code ?? 'null'}, signal=${signal ?? 'null'}).`);
      this.maybeFallbackOrRestart(startedAt, code);
    });
  }

  /**
   * Decide what to do after an unexpected child exit: fall back to PATH node on
   * a fast node:sqlite/startup failure, otherwise restart with backoff up to a
   * cap.
   */
  private maybeFallbackOrRestart(startedAt: number, code: number | null): void {
    if (this.disposed) {
      return;
    }
    const quickFail = Date.now() - startedAt < QUICK_FAIL_MS;
    const nonZero = code === null || code !== 0;
    const shouldFallback =
      !this.usedPathNodeFallback && (this.sawSqliteError || (quickFail && nonZero));

    if (shouldFallback) {
      this.usedPathNodeFallback = true;
      this.log(
        'embedded daemon failed fast under VS Code bundled node ' +
          `(${this.sawSqliteError ? 'node:sqlite unavailable' : 'non-zero quick exit'}); ` +
          'retrying with `node` on PATH. Packaged embedded mode may need a bundled Node >= 22.5.',
      );
      void this.logChildNodeVersion('node');
      this.spawnSupervised();
      return;
    }

    if (this.restarts >= MAX_RESTARTS) {
      this.log(`giving up after ${this.restarts} restart attempts. Check the log above for the cause.`);
      return;
    }
    this.restarts += 1;
    const delay = Math.min(this.restarts * RESTART_BACKOFF_MS, RESTART_BACKOFF_CAP_MS);
    this.log(`restarting daemon in ${delay}ms (attempt ${this.restarts}/${MAX_RESTARTS}).`);
    this.restartTimer = setTimeout(() => {
      this.restartTimer = undefined;
      this.spawnSupervised();
    }, delay);
  }

  /** Read the port file + probe `GET /health`; true only on a 200 response. */
  private async probeRunningService(): Promise<boolean> {
    const portFile = controlPlanePortFilePath(this.home);
    let info: ReturnType<typeof parsePortInfo>;
    try {
      info = parsePortInfo(readFileSync(portFile, 'utf8'));
    } catch {
      return false;
    }
    if (!info) {
      return false;
    }
    return httpHealthOk(controlPlaneHealthUrl(info.port), HEALTH_PROBE_TIMEOUT_MS);
  }

  /** Best-effort: log the node version of `command` (helps diagnose the spike). */
  private async logChildNodeVersion(command: string): Promise<void> {
    try {
      const version = await new Promise<string>((resolve, reject) => {
        execFile(
          command,
          ['-e', 'process.stdout.write(process.version)'],
          { env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }, timeout: 3_000 },
          (err, stdout) => (err ? reject(err) : resolve(stdout.trim())),
        );
      });
      this.log(`  ↳ ${command} reports node ${version || '(unknown)'}`);
    } catch {
      /* non-fatal; version is a nicety */
    }
  }

  private pipe(chunk: Buffer): void {
    this.output.append(chunk.toString());
  }

  private log(msg: string): void {
    this.output.appendLine(`[host] ${msg}`);
  }
}

/** Resolve true iff `url` answers 200 within `timeoutMs`. Never throws. */
function httpHealthOk(url: string, timeoutMs: number): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    let settled = false;
    const done = (ok: boolean): void => {
      if (!settled) {
        settled = true;
        resolve(ok);
      }
    };
    try {
      const req = http.get(url, (res) => {
        const ok = res.statusCode === 200;
        res.resume();
        done(ok);
      });
      req.setTimeout(timeoutMs, () => {
        req.destroy();
        done(false);
      });
      req.on('error', () => done(false));
    } catch {
      done(false);
    }
  });
}
