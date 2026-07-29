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
import { readFileSync, rmSync } from 'node:fs';
import { spawn, execFile, type ChildProcess } from 'node:child_process';
import {
  CONTROL_PLANE_HOME_ENV,
  CONTROL_PLANE_HOSTING_ENV,
  CONTROL_PLANE_PORT_ENV,
  controlPlaneHealthUrl,
  controlPlanePortFilePath,
  parseListeningPort,
  parsePortInfo,
  resolveControlPlaneStoreHome,
  resolveHostingMode,
  resolveServicePort,
  terminateDaemonPid,
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

  /**
   * The authoritative port clients + MCP registration should connect to — the
   * port THIS host owns. For `service`/`auto`-as-client it is the resolved
   * service port; for `embedded` it is the ACTUAL port the child reported on
   * stdout (`WM_CONTROL_PLANE_LISTENING <port>`). `undefined` until known.
   * Deliberately NOT derived from the shared port file, so two daemons racing
   * for a port can never cross wires here.
   */
  private endpointPortValue: number | undefined;
  private readonly onDidChangeEndpointPortEmitter = new vscode.EventEmitter<number>();
  /** Fires whenever {@link endpointPort} becomes known or changes. */
  readonly onDidChangeEndpointPort = this.onDidChangeEndpointPortEmitter.event;

  constructor(private readonly context: vscode.ExtensionContext) {
    this.output = vscode.window.createOutputChannel('Working Memory Control Plane');
    this.context.subscriptions.push(this.output);
    this.context.subscriptions.push(this.onDidChangeEndpointPortEmitter);
  }

  /**
   * The `WM_CONTROL_PLANE_HOME` / `WM_CONTROL_PLANE_HOSTING` env overrides are
   * dev-only (the F5 sandbox). In Production they're ignored so a leaked
   * sandbox var can't repoint the installed extension at the sandbox daemon.
   */
  private get allowEnvOverride(): boolean {
    return this.context.extensionMode === vscode.ExtensionMode.Development;
  }

  /**
   * The resolved control-plane store home — the directory the daemon opens its
   * `journal.sqlite` under. `start()` sets `this.home` before its first await,
   * but this getter is robust to being called before/independent of `start()`:
   * when `this.home` is empty it resolves lazily via the SAME precedence the
   * daemon uses (env `WM_CONTROL_PLANE_HOME` > setting > per-OS default) and
   * caches the result. Pure aside from that memoization — no process side
   * effects. Callers (e.g. the panel auto-refresh watcher) use this to locate
   * the SQLite files to watch for out-of-process daemon writes.
   */
  get storeHome(): string {
    if (!this.home) {
      this.home = resolveControlPlaneStoreHome({
        homeEnv: {
          platform: process.platform,
          env: process.env,
          homedir: os.homedir(),
          allowEnvOverride: this.allowEnvOverride,
        },
        settingPath: vscode.workspace
          .getConfiguration('workingMemory')
          .get<string>('controlPlane.storePath'),
      });
    }
    return this.home;
  }

  /**
   * The port clients + MCP registration must use — the port this host owns.
   * `undefined` until resolved (immediately for service/auto-client; once the
   * child reports its bound port for embedded).
   */
  get endpointPort(): number | undefined {
    return this.endpointPortValue;
  }

  /** Set the owned endpoint port and fire the change event (no-op if unchanged). */
  private setEndpointPort(port: number): void {
    if (this.endpointPortValue === port) {
      return;
    }
    this.endpointPortValue = port;
    this.onDidChangeEndpointPortEmitter.fire(port);
  }

  /**
   * Resolve the port to connect to for an EXTERNAL daemon (service mode, or the
   * auto-mode health probe): dev env `WM_CONTROL_PLANE_PORT` > the
   * `controlPlane.port` setting > the well-known default. Never the port file.
   */
  private resolveServicePortNumber(): number {
    return resolveServicePort({
      envValue: process.env[CONTROL_PLANE_PORT_ENV],
      settingValue: vscode.workspace
        .getConfiguration('workingMemory')
        .get<number>('controlPlane.port'),
      allowEnvOverride: this.allowEnvOverride,
    });
  }

  /**
   * The bind port to hand the EMBEDDED child. `0` (ephemeral) by default so two
   * self-hosting hosts never collide on a fixed port; a dev-only
   * `WM_CONTROL_PLANE_PORT` may pin it (Development / tests). The host learns
   * the ACTUAL bound port from the child's stdout regardless.
   */
  private preferredEmbeddedPort(): number {
    if (this.allowEnvOverride) {
      const raw = process.env[CONTROL_PLANE_PORT_ENV];
      if (raw && raw.trim()) {
        const n = Number.parseInt(raw.trim(), 10);
        if (Number.isInteger(n) && n >= 0 && n <= 65535) {
          return n;
        }
      }
    }
    return 0;
  }
  async start(): Promise<void> {
    try {
      const config = vscode.workspace.getConfiguration('workingMemory');
      const settingMode = config.get<string>('controlPlane.hosting');
      const settingPath = config.get<string>('controlPlane.storePath');

      this.mode = resolveHostingMode({
        envValue: process.env[CONTROL_PLANE_HOSTING_ENV],
        settingValue: settingMode,
        allowEnvOverride: this.allowEnvOverride,
      });
      this.home = resolveControlPlaneStoreHome({
        homeEnv: {
          platform: process.platform,
          env: process.env,
          homedir: os.homedir(),
          allowEnvOverride: this.allowEnvOverride,
        },
        settingPath,
      });

      this.log(`hosting mode = ${this.mode}; store home = ${this.home}`);

      if (this.mode === 'service') {
        const port = this.resolveServicePortNumber();
        this.log(
          `service mode — external OS service owns the daemon; not spawning. ` +
            `Connecting on 127.0.0.1:${port}.`,
        );
        this.setEndpointPort(port);
        return;
      }

      if (this.mode === 'auto') {
        const healthyPort = await this.probeRunningService();
        if (healthyPort !== null) {
          this.log(
            `auto mode — a healthy control-plane is already running on ` +
              `127.0.0.1:${healthyPort}; acting as client.`,
          );
          this.setEndpointPort(healthyPort);
          return;
        }
        this.log('auto mode — no healthy control-plane found; self-hosting (embedded).');
      }

      void this.logChildNodeVersion(process.execPath);
      await this.freeStalePort();
      this.spawnSupervised();
    } catch (err) {
      this.log(`start failed: ${(err as Error).message}`);
      console.error('[working-memory] control-plane host start failed:', err);
    }
  }

  /**
   * Best-effort cleanup of a stale daemon left bound to our port by a previous
   * ext-host that didn't shut it down — e.g. a debugger *reload/restart*, which
   * (unlike a fresh launch) does NOT re-run the `kill-stale-control-plane`
   * preLaunchTask. OPT-IN via `WM_CONTROL_PLANE_KILL_STALE=1` (set only by the
   * solo sandbox F5 config) so it can never disturb a legitimately separate
   * daemon — e.g. the standalone service in the compound launch. POSIX only;
   * no-ops on Windows and never throws into activation.
   *
   * Kills strictly by the pid recorded in THIS home's port file — never by an
   * entry-path substring. The dev and installed builds share the same
   * `out/control-plane/index.js` suffix, so a `pkill -f` on it would also match
   * (and bounce) the user's production daemon; targeting the sandbox pid keeps
   * the kill scoped to our own process.
   */
  private async freeStalePort(): Promise<void> {
    if (
      process.env.WM_CONTROL_PLANE_KILL_STALE !== '1' ||
      process.platform === 'win32'
    ) {
      return;
    }
    try {
      const portFile = controlPlanePortFilePath(this.home);
      let pid: number | undefined;
      try {
        pid = parsePortInfo(readFileSync(portFile, 'utf8'))?.pid;
      } catch {
        // No/unreadable port file → nothing recorded to kill.
      }
      if (pid !== undefined) {
        await terminateDaemonPid(
          pid,
          (p, signal) => process.kill(p, signal),
          (ms) => new Promise((r) => setTimeout(r, ms)),
        );
        this.log(`freed stale sandbox daemon pid ${pid} before spawning.`);
      }
      // Clear the single-instance lock + port file so the fresh daemon doesn't
      // refuse to start behind the just-killed one.
      for (const name of ['control-plane.lock', 'control-plane.port.json']) {
        try {
          rmSync(path.join(this.home, 'run', name), { force: true });
        } catch {
          /* best-effort */
        }
      }
    } catch (err) {
      this.log(`freeStalePort best-effort failure: ${(err as Error).message}`);
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
    // Bind an ephemeral port by default (WM_CONTROL_PLANE_PORT=0) so two
    // self-hosting hosts never race for a fixed port; we learn the actual bound
    // port from the child's stdout below. A dev-only override may pin it.
    const bindPort = this.preferredEmbeddedPort();
    const env = {
      ...process.env,
      ELECTRON_RUN_AS_NODE: '1',
      [CONTROL_PLANE_HOME_ENV]: this.home,
      [CONTROL_PLANE_PORT_ENV]: String(bindPort),
    };

    this.log(
      `spawning daemon via ${useExecPath ? 'VS Code bundled node (process.execPath)' : 'node on PATH'}: ` +
        `${command} ${args.join(' ')} (bind port ${bindPort === 0 ? 'ephemeral' : bindPort})`,
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

    // Accumulate stdout until the daemon announces its bound port. The port is
    // read from THIS child's own stdout stream, so it is inherently tied to our
    // child.pid — we never adopt a port from a foreign process or the port file.
    let stdoutBuf = '';
    let portReported = false;
    child.stdout?.on('data', (chunk: Buffer) => {
      if (!portReported) {
        stdoutBuf += chunk.toString();
        const port = parseListeningPort(stdoutBuf);
        if (port !== null) {
          portReported = true;
          stdoutBuf = '';
          if (this.child === child) {
            this.log(`daemon reported listening on 127.0.0.1:${port} (pid ${child.pid}).`);
            this.setEndpointPort(port);
          }
        } else if (stdoutBuf.length > 8_192) {
          // Cap the buffer so a chatty daemon that never prints the marker can't
          // grow it unbounded; keep the tail in case the marker straddles.
          stdoutBuf = stdoutBuf.slice(-1_024);
        }
      }
      this.pipe(chunk);
    });
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

  /**
   * Probe the CONFIGURED service port (not the shared port file) for a healthy
   * running daemon. Returns the port on a 200 `/health`, else `null`. Using the
   * configured/known port — never a foreign port file — keeps auto-mode from
   * latching onto a daemon it didn't spawn and can't identify.
   */
  private async probeRunningService(): Promise<number | null> {
    const port = this.resolveServicePortNumber();
    const ok = await httpHealthOk(controlPlaneHealthUrl(port), HEALTH_PROBE_TIMEOUT_MS);
    return ok ? port : null;
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
