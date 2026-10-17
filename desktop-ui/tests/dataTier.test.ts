import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  dataTierCompose,
  DataTierError,
  dataTierInstanceNames,
  DataTierManager,
  parseManagedInstances,
  dockerCliPath,
  dockerEnvironment,
} from '../src/main/dataTier';
import { CommandExecutionError, type CommandRunner } from '../src/main/dockerContainerService';

const windows = {
  platform: 'win32' as const,
  env: { Path: 'C:\\Windows\\System32', ProgramFiles: 'C:\\Program Files', LOCALAPPDATA: 'C:\\Users\\me\\AppData\\Local' },
  homedir: 'C:\\Users\\me',
};
const mac = { platform: 'darwin' as const, env: { PATH: '/usr/bin:/bin' }, homedir: '/Users/me' };
const directories: string[] = [];

function stateDirectory(): string {
  const directory = mkdtempSync(join(tmpdir(), 'wm-data-tier-'));
  directories.push(directory);
  return directory;
}

afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe('data tier launcher', () => {
  it('finds Docker Desktop outside the GUI PATH and exposes its helpers to child commands', () => {
    const docker = 'C:\\Program Files\\Docker\\Docker\\resources\\bin\\docker.exe';
    expect(dockerCliPath(windows, (candidate) => candidate === docker)).toBe(docker);
    expect(dockerEnvironment(windows, docker).PATH?.split(';')[0]).toBe('C:\\Program Files\\Docker\\Docker\\resources\\bin');
    expect(dockerEnvironment(windows, docker)).not.toHaveProperty('Path');
    const macDocker = '/Applications/Docker.app/Contents/Resources/bin/docker';
    expect(dockerCliPath(mac, (candidate) => candidate === macDocker)).toBe(macDocker);
    expect(dockerCliPath(mac, () => false)).toBeUndefined();
  });

  it('keeps Windows SQLite in a Docker volume and reuses the macOS application-data store', () => {
    const win = dataTierCompose(windows, '1.2.3');
    expect(win).toMatchObject({
      name: 'working-memory',
      services: { 'control-plane': {
        container_name: 'working-memory-control-plane',
        image: 'working-memory-control-plane:1.2.3',
        pull_policy: 'never',
        ports: ['127.0.0.1:7717:7717'],
        volumes: [{ type: 'volume', source: 'working-memory-data', target: '/data' }],
      } },
      volumes: { 'working-memory-data': { name: 'working-memory-data' } },
    });
    expect(JSON.stringify(win)).not.toContain('"build"');
    expect(dataTierCompose(mac, '1.2.3')).toMatchObject({
      services: { 'control-plane': {
        volumes: [{ type: 'bind', source: '/Users/me/Library/Application Support/WorkingMemory', target: '/data' }],
      } },
    });
  });

  it('names added instances after their port and keeps the original names for 7717', () => {
    expect(dataTierInstanceNames(7717)).toEqual({
      port: 7717, project: 'working-memory', container: 'working-memory-control-plane', volume: 'working-memory-data',
    });
    expect(dataTierInstanceNames(7721)).toEqual({
      port: 7721,
      project: 'working-memory-7721',
      container: 'working-memory-control-plane-7721',
      volume: 'working-memory-data-7721',
    });
    expect(dataTierCompose(mac, '1', 7721)).toMatchObject({
      name: 'working-memory-7721',
      services: { 'control-plane': {
        container_name: 'working-memory-control-plane-7721',
        environment: { WM_CONTROL_PLANE_PORT: '7721' },
        ports: ['127.0.0.1:7721:7721'],
        volumes: [{ source: '/Users/me/Library/Application Support/WorkingMemory-7721' }],
      } },
    });
    expect(dataTierCompose(windows, '1', 7721)).toMatchObject({
      volumes: { 'working-memory-data-7721': { name: 'working-memory-data-7721' } },
    });
  });

  it('parses managed instance state defensively', () => {
    expect(parseManagedInstances('nope')).toEqual([]);
    expect(parseManagedInstances(JSON.stringify({ instances: [
      { port: 7720, name: '  Work  ', createdAt: 'x' },
      { port: 7717 },
      { port: 7720, name: 'duplicate' },
      { port: 'bad' },
    ] }))).toEqual([
      { port: 7717, name: 'Working Memory', createdAt: '' },
      { port: 7720, name: 'Work', createdAt: 'x' },
    ]);
  });

  it('reports a missing Docker Desktop install with download guidance', async () => {
    const manager = new DataTierManager({
      ...windows, buildContext: 'ctx', stateDirectory: stateDirectory(), version: '1', fileExists: () => false,
    });
    await expect(manager.create()).rejects.toMatchObject({ code: 'docker-missing' });
    await expect(manager.create()).rejects.toThrow('docker.com');
    await expect(manager.list()).resolves.toMatchObject({ dockerError: 'Docker Desktop is not installed.', instances: [] });
  });

  it('starts Docker Desktop before creating the first instance', async () => {
    const docker = 'C:\\Program Files\\Docker\\Docker\\resources\\bin\\docker.exe';
    const desktop = 'C:\\Program Files\\Docker\\Docker\\Docker Desktop.exe';
    let dockerReady = false;
    let healthy = false;
    const calls: string[][] = [];
    const runner: CommandRunner = {
      run: vi.fn(async (_file, args) => {
        calls.push(args);
        if (args[0] === 'info' && !dockerReady) throw new CommandExecutionError('daemon down');
        if (args[0] === 'compose') healthy = true;
        return { stdout: '', stderr: '' };
      }),
    };
    const launchDetached = vi.fn(() => { dockerReady = true; });
    const directory = stateDirectory();
    const manager = new DataTierManager({
      ...windows, buildContext: 'C:\\ctx', stateDirectory: directory, version: '2.0.0', runner, launchDetached,
      healthy: async () => healthy, fileExists: (candidate) => candidate === docker || candidate === desktop,
      portAvailable: async () => true, sleep: async () => {}, now: () => new Date('2026-10-16T12:00:00Z'),
    });
    await expect(manager.create()).resolves.toEqual({
      port: 7717,
      name: 'Working Memory',
      createdAt: '2026-10-16T12:00:00.000Z',
      image: 'working-memory-control-plane:2.0.0',
    });
    expect(launchDetached).toHaveBeenCalledWith(desktop, []);
    const composeFile = join(directory, 'instances', '7717', 'compose.yaml');
    expect(calls).toContainEqual(['load', '--input', join('C:\\ctx', 'image.tar')]);
    expect(calls.findIndex((args) => args[0] === 'load')).toBeLessThan(calls.findIndex((args) => args[0] === 'compose'));
    expect(calls.filter((args) => args[0] === 'compose')).toEqual([['compose', '--file', composeFile, 'up', '--detach', '--wait', '--no-build', '--pull', 'never']]);
    expect(JSON.parse(readFileSync(composeFile, 'utf8'))).toMatchObject({
      name: 'working-memory',
      services: { 'control-plane': { image: 'working-memory-control-plane:2.0.0' } },
    });
    expect(JSON.parse(readFileSync(join(directory, 'instances.json'), 'utf8'))).toEqual({
      instances: [{ port: 7717, name: 'Working Memory', createdAt: '2026-10-16T12:00:00.000Z', image: 'working-memory-control-plane:2.0.0' }],
    });
  });

  it('surfaces image-load failures before Compose and permits retrying', async () => {
    let fail = true;
    const calls: string[][] = [];
    const runner: CommandRunner = {
      run: vi.fn(async (_file, args) => {
        calls.push(args);
        if (args[0] === 'load' && fail) throw new CommandExecutionError('archive is corrupt');
        return { stdout: '', stderr: '' };
      }),
    };
    const manager = new DataTierManager({
      ...windows, buildContext: 'C:\\resources\\data-tier', stateDirectory: stateDirectory(), version: '1',
      runner, healthy: async () => true, portAvailable: async () => true,
      fileExists: (candidate) => candidate.endsWith('docker.exe'),
    });
    await expect(manager.create()).rejects.toThrow('archive is corrupt');
    expect(manager.instances).toEqual([]);
    expect(calls.some((args) => args[0] === 'compose')).toBe(false);
    fail = false;
    await manager.create();
    expect(calls.filter((args) => args[0] === 'load')).toHaveLength(2);
  });

  it('surfaces Compose failures with the Docker error output and does not record the instance', async () => {
    const runner: CommandRunner = {
      run: vi.fn(async (_file, args) => {
        if (args[0] === 'compose') throw new CommandExecutionError('failed', 1, 'Bind for 127.0.0.1:7717 failed: port is already allocated');
        return { stdout: '', stderr: '' };
      }),
    };
    const directory = stateDirectory();
    const manager = new DataTierManager({
      ...mac, buildContext: '/ctx', stateDirectory: directory, version: '1', runner,
      healthy: async () => false, fileExists: (candidate) => candidate === '/usr/local/bin/docker',
      portAvailable: async () => true, homedir: stateDirectory(),
    });
    const error = await manager.create().catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(DataTierError);
    expect((error as DataTierError).code).toBe('start-failed');
    expect((error as Error).message).toContain('port is already allocated');
    expect(manager.instances).toEqual([]);
  });

  describe('instance manager', () => {
    const docker = '/usr/local/bin/docker';

    interface FakeContainer { state: string; status: string; image: string }

    function harness(options: {
      directory?: string;
      version?: string;
      busyPorts?: number[];
      containers?: Record<string, FakeContainer>;
      instances?: Array<{ port: number; name: string }>;
    } = {}) {
      const directory = options.directory ?? stateDirectory();
      const version = options.version ?? '2.0.0';
      if (options.instances) {
        writeFileSync(join(directory, 'instances.json'), JSON.stringify({ instances: options.instances }));
      }
      const containers = new Map(Object.entries(options.containers ?? {}));
      const calls: string[][] = [];
      const runner: CommandRunner = {
        run: vi.fn(async (_file, args) => {
          calls.push(args);
          if (args[0] === 'ps') {
            return {
              stdout: [...containers].map(([name, c]) => `${name}\t${c.state}\t${c.status}\t${c.image}`).join('\n'),
              stderr: '',
            };
          }
          if (args[0] === 'compose') {
            const compose = JSON.parse(readFileSync(args[2], 'utf8'));
            const service = compose.services['control-plane'];
            containers.set(service.container_name, { state: 'running', status: 'Up (healthy)', image: service.image });
          }
          if (args[0] === 'start') containers.get(args[1])!.state = 'running';
          if (args[0] === 'stop') containers.get(args[1])!.state = 'exited';
          return { stdout: '', stderr: '' };
        }),
      };
      const manager = new DataTierManager({
        ...mac, buildContext: '/ctx', stateDirectory: directory, version, runner,
        healthy: async (url) => {
          const port = Number(new URL(url).port);
          return containers.get(dataTierInstanceNames(port).container)?.state === 'running';
        },
        fileExists: (candidate) => candidate === docker,
        portAvailable: async (port) => !(options.busyPorts ?? []).includes(port)
          && containers.get(dataTierInstanceNames(port).container)?.state !== 'running',
        sleep: async () => {},
        now: () => new Date(2026, 9, 16, 9, 5, 7),
      });
      // Keep tests away from the real macOS application-data folder.
      (manager as unknown as { writeComposeFile: (port: number, image: string) => string }).writeComposeFile = (port, image) => {
        const file = join(directory, `compose-${port}.yaml`);
        writeFileSync(file, JSON.stringify(dataTierCompose(mac, image, port)));
        return file;
      };
      return { directory, manager, calls, containers };
    }

    const running = (version: string): FakeContainer => ({ state: 'running', status: 'Up 2 hours (healthy)', image: `working-memory-control-plane:${version}` });

    it('skips 7717 and the 7718 link bridge when another Working Memory owns the default port', async () => {
      const { manager, calls } = harness({ containers: { 'working-memory-control-plane': running('latest') }, busyPorts: [7719] });
      await expect(manager.create('Scratch')).resolves.toMatchObject({ port: 7720, name: 'Scratch' });
      await expect(manager.create()).resolves.toMatchObject({ port: 7721, name: 'Working Memory 7721' });
      expect(manager.instances.map((instance) => instance.port)).toEqual([7720, 7721]);
      expect(calls.filter((args) => args[0] === 'load')).toHaveLength(1);
    });

    it('lists only managed instances with state, version, and available upgrades', async () => {
      const { manager } = harness({
        instances: [{ port: 7720, name: 'Old' }, { port: 7721, name: 'Current' }, { port: 7722, name: 'Stopped' }, { port: 7723, name: 'Gone' }],
        containers: {
          'working-memory-control-plane': running('latest'),
          'working-memory-control-plane-7720': running('1.0.0'),
          'working-memory-control-plane-7721': { state: 'running', status: 'Up 3 seconds (health: starting)', image: 'working-memory-control-plane:2.0.0' },
          'working-memory-control-plane-7722': { state: 'exited', status: 'Exited (0) 1 hour ago', image: 'working-memory-control-plane:2.0.0' },
        },
      });
      const snapshot = await manager.list();
      expect(snapshot.appVersion).toBe('2.0.0');
      expect(snapshot.dockerError).toBeNull();
      expect(snapshot.selfHosted).toEqual([]);
      expect(snapshot.instances.map(({ port, state, version, updateAvailable }) => ({ port, state, version, updateAvailable }))).toEqual([
        { port: 7720, state: 'running', version: '1.0.0', updateAvailable: true },
        { port: 7721, state: 'starting', version: '2.0.0', updateAvailable: false },
        { port: 7722, state: 'stopped', version: '2.0.0', updateAvailable: false },
        { port: 7723, state: 'missing', version: null, updateAvailable: false },
      ]);
      expect(snapshot.instances[0]).toMatchObject({ mcpUrl: 'http://127.0.0.1:7720/mcp', container: 'working-memory-control-plane-7720' });
    });

    it('reports Docker Desktop not running without starting it', async () => {
      const runner: CommandRunner = { run: vi.fn(async () => { throw new CommandExecutionError('down'); }) };
      const launchDetached = vi.fn();
      const directory = stateDirectory();
      writeFileSync(join(directory, 'instances.json'), JSON.stringify({ instances: [{ port: 7720, name: 'Work' }] }));
      const snapshot = await new DataTierManager({
        ...mac, buildContext: '/ctx', stateDirectory: directory, version: '2.0.0', runner, launchDetached,
        fileExists: (candidate) => candidate === docker,
      }).list();
      expect(snapshot).toMatchObject({ dockerError: 'Docker Desktop is not running.', instances: [{ port: 7720, state: 'unknown' }] });
      expect(launchDetached).not.toHaveBeenCalled();
    });

    it('starts, stops, upgrades, and renames managed instances', async () => {
      const { manager, calls, containers } = harness({
        instances: [{ port: 7720, name: 'Work' }],
        containers: { 'working-memory-control-plane-7720': { state: 'exited', status: 'Exited (0)', image: 'working-memory-control-plane:1.0.0' } },
      });
      await manager.start(7720);
      expect(calls).toContainEqual(['start', 'working-memory-control-plane-7720']);
      await manager.stop(7720);
      expect(calls).toContainEqual(['stop', 'working-memory-control-plane-7720']);
      await manager.upgrade(7720);
      expect(containers.get('working-memory-control-plane-7720')?.image).toBe('working-memory-control-plane:2.0.0');
      await expect(manager.rename(7720, '  Renamed ')).resolves.toMatchObject({ name: 'Renamed' });
      expect(manager.instances).toEqual([{ port: 7720, name: 'Renamed', createdAt: '', image: 'working-memory-control-plane:2.0.0' }]);
      await expect(manager.rename(7720, '   ')).rejects.toThrow('name is required');
      await expect(manager.start(7799)).rejects.toMatchObject({ code: 'not-found' });
    });

    it('pulls channel backend images from GHCR and reports updates against the channel target', async () => {
      const image = 'ghcr.io/mkubarycz/working-memory-control-plane:2.1.0-build.7';
      const { manager, calls, containers } = harness({
        instances: [{ port: 7720, name: 'Work' }],
        containers: { 'working-memory-control-plane-7720': running('2.0.0') },
      });
      const target = { version: '2.1.0-build.7', image };
      expect((await manager.list(target)).instances[0]).toMatchObject({ version: '2.0.0', updateAvailable: true });
      await manager.upgrade(7720, target);
      expect(calls).toContainEqual(['pull', image]);
      expect(calls.some((args) => args[0] === 'load')).toBe(false);
      expect(containers.get('working-memory-control-plane-7720')?.image).toBe(image);
      expect(manager.instances[0].image).toBe(image);
      expect((await manager.list(target)).instances[0]).toMatchObject({ version: '2.1.0-build.7', updateAvailable: false });
      // A restart keeps the channel image instead of falling back to the bundled one.
      containers.delete('working-memory-control-plane-7720');
      await manager.start(7720);
      expect(containers.get('working-memory-control-plane-7720')?.image).toBe(image);
    });

    it('recreates a managed instance whose container was removed', async () => {
      const { manager, calls } = harness({ instances: [{ port: 7720, name: 'Work' }] });
      await manager.start(7720);
      expect(calls.some((args) => args[0] === 'compose')).toBe(true);
    });

    it('backs up a running instance with a consistent SQLite snapshot', async () => {
      const { manager, calls } = harness({
        instances: [{ port: 7720, name: 'My Work!' }],
        containers: { 'working-memory-control-plane-7720': running('2.0.0') },
      });
      const file = await manager.backup(7720, '/Users/me/Desktop');
      expect(file).toBe(join('/Users/me/Desktop', 'working-memory-my-work-20261016-090507.sqlite'));
      const exec = calls.find((args) => args[0] === 'exec' && args[2] === 'node');
      expect(exec?.slice(0, 4)).toEqual(['exec', 'working-memory-control-plane-7720', 'node', '--experimental-sqlite']);
      expect(exec?.[5]).toContain("VACUUM INTO '/tmp/working-memory-my-work-20261016-090507.sqlite'");
      expect(exec?.[5]).toContain('/data/journal.sqlite');
      expect(calls).toContainEqual(['cp', 'working-memory-control-plane-7720:/tmp/working-memory-my-work-20261016-090507.sqlite', file]);
      expect(calls).toContainEqual(['exec', 'working-memory-control-plane-7720', 'rm', '-f', '/tmp/working-memory-my-work-20261016-090507.sqlite']);
    });

    it('refuses to back up a stopped instance', async () => {
      const { manager } = harness({
        instances: [{ port: 7720, name: 'Work' }],
        containers: { 'working-memory-control-plane-7720': { state: 'exited', status: 'Exited', image: 'working-memory-control-plane:2.0.0' } },
      });
      await expect(manager.backup(7720, '/tmp')).rejects.toMatchObject({ code: 'not-running' });
    });

    it('at launch, creates the default instance on a fresh install', async () => {
      const { manager } = harness();
      await expect(manager.ensureAvailable()).resolves.toBe('http://127.0.0.1:7717/mcp');
      expect(manager.instances).toMatchObject([{ port: 7717, name: 'Working Memory' }]);
    });

    it('at launch, starts the previously selected managed instance', async () => {
      const { manager, calls } = harness({
        instances: [{ port: 7717, name: 'Default' }, { port: 7720, name: 'Work' }],
        containers: {
          'working-memory-control-plane': { state: 'exited', status: 'Exited', image: 'working-memory-control-plane:2.0.0' },
          'working-memory-control-plane-7720': { state: 'exited', status: 'Exited', image: 'working-memory-control-plane:2.0.0' },
        },
      });
      await expect(manager.ensureAvailable(7720)).resolves.toBe('http://127.0.0.1:7720/mcp');
      expect(calls).toContainEqual(['start', 'working-memory-control-plane-7720']);
      expect(calls).not.toContainEqual(['start', 'working-memory-control-plane']);
    });
  });
});
