/**
 * A per-run wrapper over the `@devcontainers/cli` (`up` / `exec` / `down`),
 * giving a headless nanite run the ability to execute arbitrary shell commands
 * inside an isolated VS Code dev container — so it can clone, branch, build and
 * test without touching the host filesystem.
 *
 * This file runs in the EXTENSION HOST (it shells out via `child_process`), but
 * it takes NO `vscode` dependency. The process spawner is injected through the
 * {@link ProcessRunner} seam so the whole class is unit-testable without Docker
 * or the devcontainer CLI present — tests pass a scripted runner (mirroring how
 * the runner core fakes the {@link NaniteLmBridge}).
 *
 * v0 decisions (see the `devcontainer-terminal-commands` topic):
 *  - Container lifecycle: a FRESH container per run (simple).
 *    TODO(devcontainer-terminal-commands): add a warm-pool optimisation so runs
 *    don't each pay full `up` cost.
 *  - Teardown policy: auto-remove on SUCCESS, KEEP on failure (so a human can
 *    attach VS Code to the surviving container to debug), gated by
 *    {@link DevContainerConfig.keepOnFailure}.
 *  - File edits happen via the shell inside the container (`sed`, heredocs,
 *    `apply_patch`) — there are deliberately no structured file tools yet.
 */

import { spawn } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type {
  NaniteContainer,
  NaniteContainerExecResult,
  RunnerToken,
} from '../../nanites/types';

/** Default image: the standard devcontainers TypeScript/Node 22 base. */
const DEFAULT_IMAGE = 'mcr.microsoft.com/devcontainers/typescript-node:22';
/** Sub-directory under the extension's global storage for scratch workspaces. */
const CONTAINER_SUBDIR = 'nanite-containers';
/** The id-label key stamped on every container so it can be found + removed. */
export const ID_LABEL_KEY = 'wm-nanite';

export interface ProcessRunResult {
  stdout: string;
  stderr: string;
  /** Process exit code (`-1` when it was killed / never produced one). */
  exitCode: number;
}

export interface ProcessRunOptions {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  /** Cancellation flag — polled; the child is killed when it flips true. */
  token?: RunnerToken;
  /** Hard wall-clock cap after which the child is force-killed. */
  timeoutMs?: number;
}

/**
 * The injected process spawner — the seam that keeps {@link DevContainer}
 * unit-testable. Runs `command args` and resolves with the captured output +
 * exit code. Never rejects for a non-zero exit (that is data, not an error);
 * only rejects when the process cannot be spawned at all.
 */
export type ProcessRunner = (
  command: string,
  args: string[],
  options?: ProcessRunOptions,
) => Promise<ProcessRunResult>;

/** The real spawner: `child_process.spawn` with output capture + token kill. */
export const defaultProcessRunner: ProcessRunner = (command, args, options = {}) =>
  new Promise<ProcessRunResult>((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: options.env ?? process.env,
    });
    let stdout = '';
    let stderr = '';
    let settled = false;

    const poll = setInterval(() => {
      if (options.token?.isCancellationRequested) {
        child.kill('SIGTERM');
      }
    }, 250);
    const timer = options.timeoutMs
      ? setTimeout(() => child.kill('SIGKILL'), options.timeoutMs)
      : undefined;
    const cleanup = (): void => {
      clearInterval(poll);
      if (timer) {
        clearTimeout(timer);
      }
    };

    child.stdout?.on('data', (d: Buffer) => {
      stdout += d.toString();
    });
    child.stderr?.on('data', (d: Buffer) => {
      stderr += d.toString();
    });
    child.on('error', (err) => {
      if (settled) {
        return;
      }
      settled = true;
      cleanup();
      reject(err);
    });
    child.on('close', (code) => {
      if (settled) {
        return;
      }
      settled = true;
      cleanup();
      resolve({ stdout, stderr, exitCode: code ?? -1 });
    });
  });

export interface DevContainerConfig {
  /** Unique run id — used as the id-label value AND the scratch dir name. */
  id: string;
  /** Base dir for scratch workspaces (the extension's global storage path). */
  storageDir: string;
  /** Container image (defaults to typescript-node:22). */
  image?: string;
  /** Git identity written into the container so commits are attributable. */
  gitUserName?: string;
  gitUserEmail?: string;
  /**
   * STUB(nanite-container-credentials): an optional GitHub token plumbed into
   * the container via `--remote-env GITHUB_TOKEN=…` when one is trivially
   * available. The full per-run credential story (scoped tokens, secret
   * handling, revocation) is tracked by the `nanite-container-credentials`
   * child story and is intentionally NOT solved here.
   */
  githubToken?: string | null;
  /** Keep the container on failure so a human can attach + debug (default). */
  keepOnFailure?: boolean;
  /** CLI binary for the devcontainer CLI (default `devcontainer`). */
  devcontainerBin?: string;
  /** CLI binary for Docker, used only for label-based teardown (default `docker`). */
  dockerBin?: string;
}

/** Single-quote a value for safe interpolation into a `bash -lc` string. */
function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

/**
 * A per-run dev container. Construct it, {@link up} it once, {@link exec} any
 * number of shell commands against it, then {@link down} it (respecting the
 * keep-on-failure policy). All CLI calls are time-boxed via the run's
 * cancellation token so a hung build can't strand a nanite.
 */
export class DevContainer implements NaniteContainer {
  private readonly workspaceDir: string;
  private readonly devcontainerBin: string;
  private readonly dockerBin: string;
  private upDone = false;

  constructor(
    private readonly config: DevContainerConfig,
    private readonly run: ProcessRunner = defaultProcessRunner,
  ) {
    this.workspaceDir = join(config.storageDir, CONTAINER_SUBDIR, config.id);
    this.devcontainerBin = config.devcontainerBin ?? 'devcontainer';
    this.dockerBin = config.dockerBin ?? 'docker';
  }

  private idLabel(): string {
    return `${ID_LABEL_KEY}=${this.config.id}`;
  }

  /** The generated `.devcontainer/devcontainer.json` for this run. */
  buildDevcontainerJson(): Record<string, unknown> {
    const containerEnv: Record<string, string> = {};
    if (this.config.gitUserName) {
      containerEnv.GIT_AUTHOR_NAME = this.config.gitUserName;
      containerEnv.GIT_COMMITTER_NAME = this.config.gitUserName;
    }
    if (this.config.gitUserEmail) {
      containerEnv.GIT_AUTHOR_EMAIL = this.config.gitUserEmail;
      containerEnv.GIT_COMMITTER_EMAIL = this.config.gitUserEmail;
    }
    const json: Record<string, unknown> = {
      name: `wm-nanite-${this.config.id}`,
      image: this.config.image ?? DEFAULT_IMAGE,
      features: {
        'ghcr.io/devcontainers/features/github-cli:1': {},
      },
    };
    if (Object.keys(containerEnv).length > 0) {
      json.containerEnv = containerEnv;
      // Also set the durable git identity so `git commit` works out of the box.
      json.postCreateCommand =
        `git config --global user.name ${shellQuote(this.config.gitUserName ?? '')} && ` +
        `git config --global user.email ${shellQuote(this.config.gitUserEmail ?? '')}`;
    }
    return json;
  }

  private writeConfig(): void {
    const dcDir = join(this.workspaceDir, '.devcontainer');
    mkdirSync(dcDir, { recursive: true });
    writeFileSync(
      join(dcDir, 'devcontainer.json'),
      JSON.stringify(this.buildDevcontainerJson(), null, 2),
    );
  }

  /** Create the scratch workspace + bring the container up. Throws on failure. */
  async up(token: RunnerToken): Promise<void> {
    this.writeConfig();
    const args = [
      'up',
      '--workspace-folder',
      this.workspaceDir,
      '--id-label',
      this.idLabel(),
    ];
    // STUB(nanite-container-credentials): pass a token through only if present.
    if (this.config.githubToken) {
      args.push('--remote-env', `GITHUB_TOKEN=${this.config.githubToken}`);
    }
    const res = await this.run(this.devcontainerBin, args, { token });
    if (res.exitCode !== 0) {
      const detail = (res.stderr || res.stdout).trim().slice(-500);
      throw new Error(
        `devcontainer up failed (exit ${res.exitCode})${detail ? `: ${detail}` : ''}`,
      );
    }
    this.upDone = true;
  }

  /** Run one shell command inside the container via `bash -lc`. */
  async exec(
    command: string,
    opts: { cwd?: string; token?: RunnerToken } = {},
  ): Promise<NaniteContainerExecResult> {
    const script = opts.cwd ? `cd ${shellQuote(opts.cwd)} && ${command}` : command;
    const args = [
      'exec',
      '--workspace-folder',
      this.workspaceDir,
      '--id-label',
      this.idLabel(),
      '--',
      'bash',
      '-lc',
      script,
    ];
    const res = await this.run(this.devcontainerBin, args, { token: opts.token });
    return { stdout: res.stdout, stderr: res.stderr, exitCode: res.exitCode };
  }

  /**
   * Tear the container down by label. Honors the keep-on-failure policy: when
   * the run failed AND `keepOnFailure` is set, the container is left running so
   * a human can attach VS Code and debug.
   */
  async down(opts: { failed: boolean }): Promise<void> {
    if (opts.failed && this.config.keepOnFailure) {
      return;
    }
    if (!this.upDone) {
      return;
    }
    const ps = await this.run(this.dockerBin, [
      'ps',
      '-aq',
      '--filter',
      `label=${this.idLabel()}`,
    ]);
    const ids = ps.stdout
      .split('\n')
      .map((s) => s.trim())
      .filter(Boolean);
    if (ids.length > 0) {
      await this.run(this.dockerBin, ['rm', '--force', ...ids]);
    }
  }

  /** The id of this run's currently-running container (empty when none is up). */
  private async runningContainerId(token?: RunnerToken): Promise<string> {
    const ps = await this.run(
      this.dockerBin,
      ['ps', '-q', '--filter', `label=${this.idLabel()}`],
      { token },
    );
    return ps.stdout.split('\n').map((s) => s.trim()).find(Boolean) ?? '';
  }

  /**
   * Resolve the container's OrbStack per-container name (used to build the
   * `<name>.orb.local` domain). OrbStack derives that domain from the
   * container's Docker name, so we read the name via `docker inspect` and strip
   * the leading slash. Returns an empty string when the name can't be resolved.
   */
  private async orbStackName(id: string, token?: RunnerToken): Promise<string> {
    const res = await this.run(
      this.dockerBin,
      ['inspect', '--format', '{{.Name}}', id],
      { token },
    );
    return res.stdout.trim().replace(/^\//, '');
  }

  /**
   * Resolve this run's container to a host-reachable URL at runtime — no
   * pre-declaration, no container recreation.
   *
   * OrbStack publishes every container at the bare HTTPS domain
   * `https://<name>.orb.local/`, routing to whatever the container serves. It
   * does NOT route ports as a `:port` suffix — `https://<name>.orb.local:3000`
   * is unreachable — so we never append the port to the host. `port` is
   * accepted for informational/logging purposes only.
   *
   * TODO(expose-dev-container-ports-to-host): if a SPECIFIC container port ever
   * needs its own URL, OrbStack's scheme is the subdomain form
   * `https://<port>.<name>.orb.local` — never a `:port` suffix. Not needed now.
   */
  async exposePort(
    port?: number,
    opts: { token?: RunnerToken } = {},
  ): Promise<{ url: string; name?: string }> {
    if (port !== undefined && (!Number.isInteger(port) || port <= 0 || port > 65535)) {
      throw new Error(`exposePort port must be a valid TCP port (1-65535), got ${port}`);
    }
    const id = await this.runningContainerId(opts.token);
    if (!id) {
      throw new Error('cannot expose port: no running container for this run');
    }
    const name = await this.orbStackName(id, opts.token);
    if (!name) {
      throw new Error(
        'could not expose port: the container name (OrbStack domain) is unavailable',
      );
    }
    return { url: `https://${name}.orb.local/`, name };
  }
}
