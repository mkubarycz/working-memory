import { describe, expect, test } from 'vitest';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  DevContainer,
  type ProcessRunResult,
  type ProcessRunner,
} from '../src/tools/NaniteDevContainer/devcontainer';
import {
  formatRunCommandResult,
  invokeContainerCommand,
  isRunCommandTool,
  parseRunCommandInput,
  isExposePortTool,
  parseExposePortInput,
  invokeExposePort,
} from '../src/tools/NaniteDevContainer/containerTool';
import {
  registerContainerTools,
  isContainerTool,
  invokeContainerTool,
} from '../src/tools/NaniteDevContainer';
import type { NaniteContainer } from '../src/nanites/types';

const NEVER_CANCELLED = { isCancellationRequested: false };

/** A scripted process runner: records every call, returns queued results. */
class FakeRunner {
  public readonly calls: Array<{ command: string; args: string[] }> = [];
  private readonly queue: ProcessRunResult[];
  constructor(results: ProcessRunResult[] = []) {
    this.queue = [...results];
  }
  readonly run: ProcessRunner = async (command, args) => {
    this.calls.push({ command, args });
    return (
      this.queue.shift() ?? { stdout: '', stderr: '', exitCode: 0 }
    );
  };
}

function scratchDir(): string {
  return mkdtempSync(join(tmpdir(), 'wm-devcontainer-'));
}

describe('DevContainer.up', () => {
  test('writes a generated devcontainer.json and runs `devcontainer up` with the id-label', async () => {
    const storageDir = scratchDir();
    const runner = new FakeRunner([{ stdout: 'ok', stderr: '', exitCode: 0 }]);
    const dc = new DevContainer(
      {
        id: 'run-1',
        storageDir,
        gitUserName: 'Nanite',
        gitUserEmail: 'nanite@example.com',
      },
      runner.run,
    );

    await dc.up(NEVER_CANCELLED);

    // The scratch workspace + generated config exist with the expected shape.
    const jsonPath = join(
      storageDir,
      'nanite-containers',
      'run-1',
      '.devcontainer',
      'devcontainer.json',
    );
    const config = JSON.parse(readFileSync(jsonPath, 'utf8'));
    expect(config.image).toContain('typescript-node:22');
    expect(config.features).toHaveProperty(
      'ghcr.io/devcontainers/features/github-cli:1',
    );
    expect(config.containerEnv.GIT_AUTHOR_NAME).toBe('Nanite');
    expect(config.containerEnv.GIT_AUTHOR_EMAIL).toBe('nanite@example.com');

    // The CLI call carries the workspace folder + the wm-nanite id-label.
    expect(runner.calls).toHaveLength(1);
    expect(runner.calls[0].command).toBe('devcontainer');
    expect(runner.calls[0].args).toContain('up');
    expect(runner.calls[0].args).toContain('--id-label');
    expect(runner.calls[0].args).toContain('wm-nanite=run-1');
    // No token given → no --remote-env.
    expect(runner.calls[0].args).not.toContain('--remote-env');
  });

  test('passes GITHUB_TOKEN via --remote-env when a token is supplied', async () => {
    const runner = new FakeRunner([{ stdout: '', stderr: '', exitCode: 0 }]);
    const dc = new DevContainer(
      { id: 'run-2', storageDir: scratchDir(), githubToken: 'gho_secret' },
      runner.run,
    );

    await dc.up(NEVER_CANCELLED);

    const idx = runner.calls[0].args.indexOf('--remote-env');
    expect(idx).toBeGreaterThan(-1);
    expect(runner.calls[0].args[idx + 1]).toBe('GITHUB_TOKEN=gho_secret');
  });

  test('throws when the CLI exits non-zero', async () => {
    const runner = new FakeRunner([
      { stdout: '', stderr: 'docker not found', exitCode: 1 },
    ]);
    const dc = new DevContainer(
      { id: 'run-3', storageDir: scratchDir() },
      runner.run,
    );

    await expect(dc.up(NEVER_CANCELLED)).rejects.toThrow(/devcontainer up failed/);
  });
});

describe('DevContainer.exec', () => {
  test('runs the command via `devcontainer exec -- bash -lc` and returns the result', async () => {
    const runner = new FakeRunner([
      { stdout: 'hello\n', stderr: '', exitCode: 0 },
    ]);
    const dc = new DevContainer(
      { id: 'run-4', storageDir: scratchDir() },
      runner.run,
    );

    const res = await dc.exec('echo hello', { token: NEVER_CANCELLED });

    expect(res).toEqual({ stdout: 'hello\n', stderr: '', exitCode: 0 });
    const args = runner.calls[0].args;
    expect(args.slice(0, 2)).toEqual(['exec', '--workspace-folder']);
    expect(args).toContain('wm-nanite=run-4');
    // The trailing script is passed to bash -lc after the `--` separator.
    expect(args.slice(-3)).toEqual(['bash', '-lc', 'echo hello']);
  });

  test('prefixes a cd into the requested cwd', async () => {
    const runner = new FakeRunner([{ stdout: '', stderr: '', exitCode: 0 }]);
    const dc = new DevContainer(
      { id: 'run-5', storageDir: scratchDir() },
      runner.run,
    );

    await dc.exec('npm test', { cwd: '/workspaces/repo' });

    const script = runner.calls[0].args.at(-1);
    expect(script).toBe(`cd '/workspaces/repo' && npm test`);
  });
});

describe('DevContainer.down', () => {
  test('on success, removes containers by label via docker', async () => {
    const runner = new FakeRunner([
      { stdout: '', stderr: '', exitCode: 0 }, // up
      { stdout: 'abc123\n', stderr: '', exitCode: 0 }, // docker ps
      { stdout: '', stderr: '', exitCode: 0 }, // docker rm
    ]);
    const dc = new DevContainer(
      { id: 'run-6', storageDir: scratchDir(), keepOnFailure: true },
      runner.run,
    );
    await dc.up(NEVER_CANCELLED);

    await dc.down({ failed: false });

    const dockerCalls = runner.calls.filter((c) => c.command === 'docker');
    expect(dockerCalls[0].args).toEqual([
      'ps',
      '-aq',
      '--filter',
      'label=wm-nanite=run-6',
    ]);
    expect(dockerCalls[1].args).toEqual(['rm', '--force', 'abc123']);
  });

  test('keep-on-failure: a failed run with keepOnFailure leaves the container running', async () => {
    const runner = new FakeRunner([{ stdout: '', stderr: '', exitCode: 0 }]);
    const dc = new DevContainer(
      { id: 'run-7', storageDir: scratchDir(), keepOnFailure: true },
      runner.run,
    );
    await dc.up(NEVER_CANCELLED);

    await dc.down({ failed: true });

    // Only the `up` call happened — no docker teardown.
    expect(runner.calls.every((c) => c.command !== 'docker')).toBe(true);
  });

  test('is a no-op when the container was never brought up', async () => {
    const runner = new FakeRunner();
    const dc = new DevContainer(
      { id: 'run-8', storageDir: scratchDir() },
      runner.run,
    );

    await dc.down({ failed: false });

    expect(runner.calls).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// run_command tool: schema parsing, result formatting, and container routing.
// ---------------------------------------------------------------------------
describe('run_command tool helpers', () => {
  test('isRunCommandTool matches only the clean name', () => {
    expect(isRunCommandTool('run_command')).toBe(true);
    expect(isRunCommandTool('ws-topic-read')).toBe(false);
  });

  test('parseRunCommandInput requires a non-empty command', () => {
    expect(parseRunCommandInput({ command: 'ls' })).toEqual({ command: 'ls' });
    expect(parseRunCommandInput({ command: 'ls', cwd: '/x' })).toEqual({
      command: 'ls',
      cwd: '/x',
    });
    expect(() => parseRunCommandInput({})).toThrow(/non-empty/);
    expect(() => parseRunCommandInput({ command: '   ' })).toThrow(/non-empty/);
  });

  test('formatRunCommandResult emits compact JSON with exit code', () => {
    const out = formatRunCommandResult({ stdout: 'a', stderr: 'b', exitCode: 2 });
    expect(JSON.parse(out)).toEqual({ exitCode: 2, stdout: 'a', stderr: 'b' });
  });

  test('formatRunCommandResult keeps the tail of very long output', () => {
    const big = 'x'.repeat(20000);
    const parsed = JSON.parse(
      formatRunCommandResult({ stdout: big, stderr: '', exitCode: 0 }),
    );
    expect(parsed.stdout).toContain('truncated');
    expect(parsed.stdout.length).toBeLessThan(big.length);
  });

  test('invokeContainerCommand routes to container.exec and formats the result', async () => {
    const calls: Array<{ command: string; cwd?: string }> = [];
    const container: NaniteContainer = {
      up: async () => {},
      exec: async (command, opts) => {
        calls.push({ command, cwd: opts.cwd });
        return { stdout: 'built', stderr: '', exitCode: 0 };
      },
      down: async () => {},
    };

    const result = await invokeContainerCommand(
      container,
      { command: 'npm run build', cwd: '/workspaces/repo' },
      NEVER_CANCELLED,
    );

    expect(calls).toEqual([{ command: 'npm run build', cwd: '/workspaces/repo' }]);
    expect(JSON.parse(result)).toEqual({
      exitCode: 0,
      stdout: 'built',
      stderr: '',
    });
  });
});

// ---------------------------------------------------------------------------
// DevContainer.exposePort: the bare OrbStack per-container HTTPS domain
// (`https://<name>.orb.local/`) — no port suffix — all via the injected runner.
// ---------------------------------------------------------------------------
describe('DevContainer.exposePort', () => {
  test('returns the bare OrbStack HTTPS domain (leading slash stripped, no port)', async () => {
    const runner = new FakeRunner([
      { stdout: 'abc123\n', stderr: '', exitCode: 0 }, // docker ps -q
      { stdout: '/wm-nanite-run-9\n', stderr: '', exitCode: 0 }, // docker inspect .Name
    ]);
    const dc = new DevContainer(
      { id: 'run-9', storageDir: scratchDir() },
      runner.run,
    );

    const res = await dc.exposePort(5173, { token: NEVER_CANCELLED });

    // HTTPS, leading '/' stripped from the name, and NO ':port' suffix.
    expect(res).toEqual({
      url: 'https://wm-nanite-run-9.orb.local/',
      name: 'wm-nanite-run-9',
    });
    // Resolves the RUNNING container by label, then inspects its name.
    expect(runner.calls[0].args).toEqual([
      'ps',
      '-q',
      '--filter',
      'label=wm-nanite=run-9',
    ]);
    expect(runner.calls[1].args).toEqual([
      'inspect',
      '--format',
      '{{.Name}}',
      'abc123',
    ]);
  });

  test('works with no port argument (port is informational only)', async () => {
    const runner = new FakeRunner([
      { stdout: 'abc123\n', stderr: '', exitCode: 0 }, // docker ps -q
      { stdout: '/inspiring_engelbart\n', stderr: '', exitCode: 0 }, // inspect .Name
    ]);
    const dc = new DevContainer(
      { id: 'run-10', storageDir: scratchDir() },
      runner.run,
    );

    const res = await dc.exposePort();

    expect(res).toEqual({
      url: 'https://inspiring_engelbart.orb.local/',
      name: 'inspiring_engelbart',
    });
    // Never shells out to `docker port` — no legacy :port fallback path.
    expect(runner.calls.every((c) => !c.args.includes('port'))).toBe(true);
  });

  test('throws when no running container exists for the run', async () => {
    const runner = new FakeRunner([{ stdout: '\n', stderr: '', exitCode: 0 }]);
    const dc = new DevContainer(
      { id: 'run-11', storageDir: scratchDir() },
      runner.run,
    );

    await expect(dc.exposePort(3000)).rejects.toThrow(/no running container/);
  });

  test('throws when the container name (OrbStack domain) is unavailable', async () => {
    const runner = new FakeRunner([
      { stdout: 'abc123\n', stderr: '', exitCode: 0 }, // ps
      { stdout: '\n', stderr: '', exitCode: 0 }, // inspect → empty
    ]);
    const dc = new DevContainer(
      { id: 'run-12', storageDir: scratchDir() },
      runner.run,
    );

    await expect(dc.exposePort(3000)).rejects.toThrow(/could not expose port/);
  });

  test('rejects an invalid port before shelling out', async () => {
    const runner = new FakeRunner();
    const dc = new DevContainer(
      { id: 'run-13', storageDir: scratchDir() },
      runner.run,
    );

    await expect(dc.exposePort(0)).rejects.toThrow(/valid TCP port/);
    await expect(dc.exposePort(70000)).rejects.toThrow(/valid TCP port/);
    expect(runner.calls).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// expose_port tool: schema parsing, container routing, and the per-run tool set.
// ---------------------------------------------------------------------------
describe('expose_port tool helpers', () => {
  test('isExposePortTool matches only the clean name', () => {
    expect(isExposePortTool('expose_port')).toBe(true);
    expect(isExposePortTool('run_command')).toBe(false);
  });

  test('parseExposePortInput allows an optional integer port in range', () => {
    expect(parseExposePortInput({ port: 5173 })).toEqual({ port: 5173 });
    // Port is now optional — absent/empty input is valid.
    expect(parseExposePortInput({})).toEqual({});
    expect(parseExposePortInput({ port: undefined })).toEqual({});
    expect(() => parseExposePortInput({ port: 0 })).toThrow(/between 1 and 65535/);
    expect(() => parseExposePortInput({ port: 1.5 })).toThrow(/between 1 and 65535/);
  });

  test('invokeExposePort routes to container.exposePort and returns the URL text', async () => {
    const calls: Array<number | undefined> = [];
    const container: NaniteContainer = {
      up: async () => {},
      exec: async () => ({ stdout: '', stderr: '', exitCode: 0 }),
      down: async () => {},
      exposePort: async (port) => {
        calls.push(port);
        return { url: 'https://svc.orb.local/', name: 'svc' };
      },
    };

    const url = await invokeExposePort(container, { port: 5173 }, NEVER_CANCELLED);

    expect(calls).toEqual([5173]);
    expect(url).toBe('https://svc.orb.local/');
  });

  test('invokeExposePort throws when the container cannot expose ports', async () => {
    const container: NaniteContainer = {
      up: async () => {},
      exec: async () => ({ stdout: '', stderr: '', exitCode: 0 }),
      down: async () => {},
    };

    await expect(
      invokeExposePort(container, { port: 5173 }, NEVER_CANCELLED),
    ).rejects.toThrow(/not supported/);
  });
});

// ---------------------------------------------------------------------------
// The per-run container tool set the bridge offers, and its routing.
// ---------------------------------------------------------------------------
describe('registerContainerTools / routing', () => {
  const exposeCapable: NaniteContainer = {
    up: async () => {},
    exec: async (command, opts) => {
      void command;
      void opts;
      return { stdout: 'ran', stderr: '', exitCode: 0 };
    },
    down: async () => {},
    exposePort: async () => ({ url: 'https://svc.orb.local/', name: 'svc' }),
  };
  const runOnly: NaniteContainer = {
    up: async () => {},
    exec: async () => ({ stdout: 'ran', stderr: '', exitCode: 0 }),
    down: async () => {},
  };

  test('offers run_command always and expose_port only when supported', () => {
    expect(registerContainerTools(runOnly).map((t) => t.name)).toEqual([
      'run_command',
    ]);
    expect(registerContainerTools(exposeCapable).map((t) => t.name)).toEqual([
      'run_command',
      'expose_port',
    ]);
  });

  test('isContainerTool matches both per-run tools', () => {
    expect(isContainerTool('run_command')).toBe(true);
    expect(isContainerTool('expose_port')).toBe(true);
    expect(isContainerTool('ws-topic-read')).toBe(false);
  });

  test('invokeContainerTool routes expose_port to exposePort', async () => {
    const url = await invokeContainerTool(
      exposeCapable,
      'expose_port',
      { port: 4321 },
      NEVER_CANCELLED,
    );
    expect(url).toBe('https://svc.orb.local/');
  });

  test('invokeContainerTool routes run_command to exec', async () => {
    const out = await invokeContainerTool(
      exposeCapable,
      'run_command',
      { command: 'ls' },
      NEVER_CANCELLED,
    );
    expect(JSON.parse(out)).toEqual({ exitCode: 0, stdout: 'ran', stderr: '' });
  });
});
