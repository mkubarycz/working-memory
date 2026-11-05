import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ContainerProviderAdapter } from '../src/main/containerProvider';
import { assertContainerProviderForClaims, checkContainerOwnership, readContainerOwnership } from '../src/main/containerOwnership';
import { dockerCliPath, dockerEnvironment } from '../src/main/dockerCli';
import { readContainerProvider, writeContainerProvider } from '../src/main/containerProviderSettings';
import { CommandExecutionError, DockerContainerService, MANAGED_LABEL, CLAIM_LABEL, type CommandRunner } from '../src/main/dockerContainerService';
import { DataTierManager, dataTierHostDirectory, dataTierInstanceNames } from '../src/main/dataTier';
import type { ContainerClaim } from '../../shared/controlPlaneClient';
import { localDockerRunner } from './fixtures/localContainerRunner';

const directories: string[] = [];
function directory(): string {
  const result = mkdtempSync(join(tmpdir(), 'wm-provider-'));
  directories.push(result);
  return result;
}
afterEach(() => {
  for (const path of directories.splice(0)) rmSync(path, { recursive: true, force: true });
});

const host = { platform: 'win32' as const, homedir: 'C:\\Users\\test', env: { Path: 'C:\\Windows\\System32' } };
const connection = {
  Name: 'podman-machine-default', URI: 'ssh://user@127.0.0.1:53298/run/user/1000/podman/podman.sock',
  Identity: '/local/machine', Default: true, IsMachine: true,
};
const vm = {
  Name: connection.Name, Created: '2026-01-01T00:00:00Z', State: 'running',
  SSHConfig: { Port: 53298, IdentityPath: connection.Identity, RemoteUsername: 'user' },
};

function podmanRunner(
  handler: (args: string[]) => Promise<{ stdout: string; stderr: string }> = async () => ({ stdout: '', stderr: '' }),
  selected = connection,
): CommandRunner {
  return {
    run: vi.fn(async (file, args) => {
      expect(file).toMatch(/podman(?:\.exe)?$/);
      if (args[0] === 'system') return { stdout: JSON.stringify([selected]), stderr: '' };
      if (args[0] === 'machine') return { stdout: JSON.stringify([vm]), stderr: '' };
      expect(args.slice(0, 2)).toEqual(['--connection', selected.Name]);
      return handler(args.slice(2));
    }),
  };
}

describe('shared container provider adapter', () => {
  it('discovers Podman without Podman Desktop on GUI Windows/macOS paths and never substitutes Docker', () => {
    const windows = 'C:\\Program Files\\RedHat\\Podman\\podman.exe';
    expect(dockerCliPath(host, candidate => candidate === windows, 'podman')).toBe(windows);
    const mac = { platform: 'darwin' as const, homedir: '/Users/test', env: { PATH: '/usr/bin' } };
    expect(dockerCliPath(mac, candidate => candidate === '/opt/podman/bin/podman', 'podman')).toBe('/opt/podman/bin/podman');
    expect(dockerCliPath(mac, candidate => candidate.endsWith('/docker'), 'podman')).toBeUndefined();
    expect(dockerEnvironment({ ...host, env: { ...host.env, KEEP: 'value' } }, windows, 'podman')).toMatchObject({
      KEEP: 'value', PATH: expect.stringContaining('RedHat\\Podman'),
    });
  });

  it('selects and pins a local machine, strips conflicting routing variables, and uses portable Compose flags', async () => {
    const runner = podmanRunner();
    const adapter = new ContainerProviderAdapter({
      provider: 'podman', runner,
      host: { ...host, env: { ...host.env, KEEP: 'value', DOCKER_HOST: 'tcp://remote:2375', DOCKER_CONTEXT: 'remote', CONTAINER_HOST: 'ssh://remote' } },
    });
    const selected = await adapter.resolve();
    await adapter.composeUp(selected, 'compose.yaml', { timeoutMs: 1000 });
    const calls = vi.mocked(runner.run).mock.calls;
    expect(calls.map(([, args]) => args)).toContainEqual(['--connection', connection.Name, 'compose', '--file', 'compose.yaml', 'up', '--detach', '--no-build']);
    expect(calls.every(([, args]) => !args.includes('start') && !args.includes('--wait') && !args.includes('--context'))).toBe(true);
    for (const [, , options] of calls) {
      expect(options?.env).toMatchObject({ KEEP: 'value' });
      expect(options?.env).not.toHaveProperty('DOCKER_HOST');
      expect(options?.env).not.toHaveProperty('DOCKER_CONTEXT');
      expect(options?.env).not.toHaveProperty('CONTAINER_HOST');
    }
    expect(adapter.identity(selected)).toContain(vm.Created);
  });

  it.each([
    'ssh://user@remote.example:22/run/user/1000/podman/podman.sock',
    'tcp://127.0.0.1:2375',
    'ssh://user@127.0.0.1:53298/tmp/other.sock',
  ])('refuses unsafe Podman destinations without starting anything: %s', async URI => {
    const runner = podmanRunner(undefined, { ...connection, URI });
    const adapter = new ContainerProviderAdapter({ provider: 'podman', host, runner });
    await expect(adapter.resolve()).rejects.toThrow('not a local socket or local Podman machine');
    expect(runner.run).toHaveBeenCalledTimes(1);
  });

  it('refuses stopped or mismatched local machines rather than starting them', async () => {
    const runner = podmanRunner(undefined, { ...connection, URI: connection.URI.replace(':53298/', ':50000/') });
    await expect(new ContainerProviderAdapter({ provider: 'podman', host, runner }).resolve()).rejects.toThrow('does not match a running local machine');
    expect(vi.mocked(runner.run).mock.calls.some(([, args]) => args.includes('start'))).toBe(false);
  });

  it.each([
    { name: 'dev-root', rootful: false, machine: 'dev-root' },
    { name: 'dev-root-root', rootful: true, machine: 'dev-root' },
    { name: 'podman-machine-default-root', rootful: true, machine: 'podman-machine-default' },
  ])('resolves $name without confusing a rootless machine suffix with a rootful connection', async ({ name, rootful, machine }) => {
    const selected = { ...connection, Name: name, URI: rootful
      ? 'ssh://root@127.0.0.1:53298/run/podman/podman.sock' : connection.URI };
    const runner: CommandRunner = { run: vi.fn(async (_file, args) => {
      if (args[0] === 'system') return { stdout: JSON.stringify([selected]), stderr: '' };
      if (args[0] === 'machine') return { stdout: JSON.stringify([{ ...vm, Name: machine }]), stderr: '' };
      expect(args.slice(0, 2)).toEqual(['--connection', name]);
      return { stdout: '{}', stderr: '' };
    }) };
    const adapter = new ContainerProviderAdapter({ provider: 'podman', host, runner });
    expect(adapter.identity(await adapter.resolve())).toContain(`${machine} (${vm.Created}`);
    expect(runner.run).toHaveBeenCalledWith('podman', ['machine', 'inspect', machine], expect.anything());
  });

  it.each(['unix:///colima/docker.sock', 'ssh://remote.example', 'tcp://127.0.0.1:2375'])(
    'honors the active Docker context but still rejects unsafe endpoints: %s',
    async endpoint => {
      const runner: CommandRunner = { run: vi.fn(async (_file, args) => {
        if (args[0] === 'context') return { stdout: 'colima\n', stderr: '' };
        expect(args.slice(0, 2)).toEqual(['--context', 'colima']);
        return { stdout: JSON.stringify(endpoint), stderr: '' };
      }) };
      const adapter = new ContainerProviderAdapter({ host, runner });
      if (endpoint.startsWith('unix:')) {
        const selected = await adapter.resolve();
        expect(selected).toBe('colima');
        expect(adapter.identity(selected)).toBe(`colima (${endpoint})`);
      } else {
        await expect(adapter.resolve()).rejects.toThrow('not local');
      }
      expect(runner.run).toHaveBeenCalledWith('docker', ['context', 'show'], expect.anything());
      expect(vi.mocked(runner.run).mock.calls.some(([, args]) => args.includes('desktop-linux') || args.includes('orbstack'))).toBe(false);
    },
  );

  it('uses native local Linux Podman only when no default remote connection is selected', async () => {
    const runner: CommandRunner = { run: vi.fn(async (_file, args) => ({
      stdout: args[0] === 'system' ? '[]' : '{}', stderr: '',
    })) };
    const adapter = new ContainerProviderAdapter({ provider: 'podman', host: { ...host, platform: 'linux' }, runner });
    expect(await adapter.resolve()).toBe('podman:local');
    expect(runner.run).toHaveBeenCalledWith('podman', ['--remote=false', 'info', '--format', 'json'], expect.anything());
    await expect(new ContainerProviderAdapter({ provider: 'podman', host, runner }).resolve()).rejects.toThrow('no default local connection');
  });

  it('keeps machine ownership stable across SSH-port changes but not machine replacement', async () => {
    let port = 53298;
    let created = vm.Created;
    const runner: CommandRunner = {
      run: vi.fn(async (_file, args) => ({
        stdout: args[0] === 'system'
          ? JSON.stringify([{ ...connection, URI: connection.URI.replace(':53298/', `:${port}/`) }])
          : args[0] === 'machine'
            ? JSON.stringify([{ ...vm, Created: created, SSHConfig: { ...vm.SSHConfig, Port: port } }])
            : '{}',
        stderr: '',
      })),
    };
    const adapter = new ContainerProviderAdapter({ provider: 'podman', host, runner });
    const original = adapter.identity(await adapter.resolve());
    port = 54321;
    expect(adapter.identity(await adapter.resolve())).toBe(original);
    created = '2026-02-01T00:00:00Z';
    expect(adapter.identity(await adapter.resolve())).not.toBe(original);
  });

  it('reports missing Compose and preserves its actual error without engine fallback', async () => {
    const runner = podmanRunner(async args => {
      if (args[0] === 'compose') throw new CommandExecutionError('failed', 1, 'external provider not found');
      return { stdout: '{}', stderr: '' };
    });
    const adapter = new ContainerProviderAdapter({ provider: 'podman', host, runner });
    const selected = await adapter.resolve();
    await expect(adapter.requireCompose(selected, { timeoutMs: 1000 })).rejects.toThrow('external provider not found');
    expect(vi.mocked(runner.run).mock.calls.some(([, args]) => args.includes('up'))).toBe(false);
  });

  it('normalizes only known Podman image/health differences without relaxing ports or volume facts', () => {
    const adapter = new ContainerProviderAdapter({ provider: 'podman', host, runner: podmanRunner() });
    const original = {
      Config: { Image: 'localhost/backend:1.7.0' },
      State: { Healthcheck: { Status: 'unhealthy', FailingStreak: 2 } },
      Mounts: [{ Name: 'data', Type: 'volume', Destination: '/data' }],
      NetworkSettings: { Ports: { '7717/tcp': [{ HostIp: '0.0.0.0', HostPort: '7717' }] } },
    };
    expect(adapter.inspect(JSON.stringify([original]), 'backend:1.7.0')).toEqual([{
      ...original, Config: { Image: 'backend:1.7.0' },
      State: { ...original.State, Health: original.State.Healthcheck },
    }]);
    expect(adapter.inspect(JSON.stringify([original]), 'other:1.7.0')).toMatchObject([{ Config: original.Config }]);
  });

  it('normalizes an exact expected namespaced image, but never guesses a registry or namespace', () => {
    const adapter = new ContainerProviderAdapter({ provider: 'podman', host, runner: podmanRunner() });
    expect(adapter.imageReference('localhost/team/app:local', 'team/app:local')).toBe('team/app:local');
    expect(adapter.imageReference('localhost/team/app:local')).toBe('localhost/team/app:local');
    expect(adapter.imageReference('localhost/team/app:local', 'other/app:local')).toBe('localhost/team/app:local');
    expect(adapter.imageReference('registry.example/team/app:local', 'team/app:local')).toBe('registry.example/team/app:local');
  });
});

describe('provider settings and storage ownership', () => {
  it('persists provider selection, defaults only absent settings to Docker, and rejects corrupt values', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'wm-provider-setting-'));
    try {
      const file = join(dir, 'provider.json');
      expect(await readContainerProvider(file)).toBe('docker');
      await writeContainerProvider(file, 'podman');
      expect(await readContainerProvider(file)).toBe('podman');
      await expect(writeContainerProvider(file, 'other')).rejects.toThrow();
      expect(await readContainerProvider(file)).toBe('podman');
      await writeFile(file, '{broken');
      await expect(readContainerProvider(file)).rejects.toThrow('Unable to read');
    } finally { await rm(dir, { recursive: true, force: true }); }
  });

  it('persists reservations and rejects provider/connection changes', () => {
    const dir = directory();
    const owner = { provider: 'docker' as const, connection: 'local-original' };
    expect(checkContainerOwnership(dir, 'app', owner, true)).toBe(false);
    expect(checkContainerOwnership(dir, 'app', owner)).toBe(true);
    expect(() => checkContainerOwnership(dir, 'app', { ...owner, provider: 'podman' }, true)).toThrow('another container provider');
    expect(() => checkContainerOwnership(dir, 'app', { ...owner, connection: 'other' })).toThrow('another container provider');
  });

  it('allows returning to a stateful app owner across environments, including legacy Docker apps', () => {
    const dir = directory();
    const claims = [{ id: 'legacy', runtime: { type: 'docker' as const, buildContext: '/repo', dockerfile: '/repo/Dockerfile',
      imageName: 'app:local', containerName: 'app', hostPort: 4173, containerPort: 80, entryPath: '/', healthPath: '/',
      volumes: [{ name: 'data', mountPath: '/data' }] } }];
    expect(() => assertContainerProviderForClaims(dir, 'podman', [])).not.toThrow();
    expect(() => assertContainerProviderForClaims(dir, 'podman', claims)).toThrow('original provider');
    expect(() => assertContainerProviderForClaims(dir, 'docker', claims)).not.toThrow();
    checkContainerOwnership(dir, 'legacy', { provider: 'podman', connection: 'local-machine' }, true);
    expect(() => assertContainerProviderForClaims(dir, 'podman', claims)).not.toThrow();
    expect(() => assertContainerProviderForClaims(dir, 'docker', claims)).toThrow('original provider');
  });
});

describe('Podman data tier lifecycle (mocked Windows)', () => {
  function legacyContainer(port: number) {
    const names = dataTierInstanceNames(port);
    return {
      Config: { Image: 'working-memory-control-plane:1.6.0', Labels: {
        'com.docker.compose.project': names.project, 'com.docker.compose.service': 'control-plane',
      } },
      Mounts: [{ Type: 'volume', Name: names.volume, Source: '/engine/volume', Destination: '/data' }],
      State: { Running: true },
      HostConfig: { PortBindings: { [`${port}/tcp`]: [{ HostIp: '127.0.0.1', HostPort: String(port) }] } },
      NetworkSettings: { Ports: { [`${port}/tcp`]: [{ HostIp: '127.0.0.1', HostPort: String(port) }] } },
    };
  }

  function backend() {
    const dir = directory();
    let up = false;
    let loadedImage = 'working-memory-control-plane:1.7.0';
    let volumePresent = false;
    const calls: string[][] = [];
    const runner = podmanRunner(async args => {
      calls.push(args);
      if (args[0] === 'ps') return { stdout: up ? `working-memory-control-plane\trunning\tUp (healthy)\t${loadedImage.startsWith('ghcr.io/') ? loadedImage : `localhost/${loadedImage}`}` : '', stderr: '' };
      if (args[0] === 'volume' && args[1] === 'inspect' && !volumePresent) throw new CommandExecutionError('no such volume', 1);
      if (args[0] === 'volume' && args[1] === 'create') volumePresent = true;
      if (args[0] === 'compose' && args[1] === '--file') {
        expect(volumePresent).toBe(true);
        const compose = JSON.parse(readFileSync(args[2], 'utf8'));
        expect(compose.volumes['working-memory-data'].external).toBe(true);
        loadedImage = compose.services['control-plane'].image;
        up = true;
      }
      if (args[0] === 'stop') up = false;
      if (args[0] === 'start') up = true;
      return { stdout: '', stderr: '' };
    });
    const manager = () => new DataTierManager({
      ...host, provider: 'podman', buildContext: dir, stateDirectory: dir, version: '1.7.0',
      fileExists: path => path.endsWith('podman.exe'), runner, healthy: async () => up,
      portAvailable: async () => true,
    });
    return { dir, manager, calls, runner, loseContainer: () => { up = false; }, loseVolume: () => { volumePresent = false; } };
  }

  it('loads a bundled image, creates external data storage, starts/stops, and persists upgrades across app restarts', async () => {
    const fixture = backend();
    const instance = await fixture.manager().create();
    expect(instance).toMatchObject({ provider: 'podman', port: 7717 });
    expect((await fixture.manager().list()).instances[0]).toMatchObject({ version: '1.7.0', updateAvailable: false });
    expect(fixture.calls).toContainEqual(['load', '--input', join(fixture.dir, 'image.tar')]);
    await fixture.manager().stop(7717);
    await fixture.manager().start(7717);
    const image = 'ghcr.io/mkubarycz/working-memory-control-plane:1.7.0-build.7';
    await fixture.manager().upgrade(7717, { version: '1.7.0-build.7', image });
    fixture.loseContainer();
    await fixture.manager().start(7717);
    expect(fixture.manager().instances[0].image).toBe(image);
    expect(fixture.calls.filter(args => args[0] === 'pull')).toEqual([['pull', image], ['pull', image]]);
    expect(fixture.calls.some(args => args.includes('rm') || args.includes('--volumes'))).toBe(false);
  });

  it('refuses missing registered volumes, provider changes, and corrupt registrations before creating replacement data', async () => {
    const fixture = backend();
    await fixture.manager().create();
    fixture.loseContainer();
    fixture.loseVolume();
    fixture.calls.length = 0;
    await expect(fixture.manager().start(7717)).rejects.toThrow('Refusing to create an empty replacement');
    expect(fixture.calls.some(args => (args[0] === 'compose' && args.includes('up')) || args[1] === 'create')).toBe(false);
    const docker = new DataTierManager({ ...host, buildContext: fixture.dir, stateDirectory: fixture.dir, version: '1.7.0', runner: fixture.runner });
    await expect(docker.start(7717)).rejects.toThrow('another container provider');
    writeFileSync(join(fixture.dir, 'instances.json'), 'broken');
    await expect(fixture.manager().create()).rejects.toThrow('no replacement database');
  });

  it('keeps legacy Docker registrations unavailable on Podman instead of bootstrapping a new database', async () => {
    const fixture = backend();
    writeFileSync(join(fixture.dir, 'instances.json'), JSON.stringify({ instances: [{ port: 7717, name: 'Existing' }] }));
    await expect(fixture.manager().ensureAvailable()).rejects.toThrow('another container provider');
    expect(fixture.runner.run).not.toHaveBeenCalled();
  });

  it('reports missing Compose with Retry before loading images or creating volumes', async () => {
    const dir = directory();
    const calls: string[][] = [];
    const runner = podmanRunner(async args => {
      calls.push(args);
      if (args[0] === 'compose') throw new CommandExecutionError('missing compose provider', 1);
      return { stdout: '', stderr: '' };
    });
    const manager = new DataTierManager({
      ...host, provider: 'podman', buildContext: dir, stateDirectory: dir, version: '1.7.0',
      runner, fileExists: path => path.endsWith('podman.exe'), portAvailable: async () => true,
    });
    await expect(manager.create()).rejects.toThrow('then Retry');
    expect(calls.some(args => args[0] === 'load' || (args[0] === 'volume' && args[1] === 'create'))).toBe(false);
    expect(manager.instances).toEqual([]);
    expect(readContainerOwnership(join(dir, 'ownership'), 'data-tier')).toBeUndefined();
    expect(existsSync(join(dir, 'pending-instance.json'))).toBe(false);
    expect(await manager.list()).toMatchObject({ dockerError: expect.stringContaining('Compose is missing or unavailable') });
  });

  it('allows choosing Podman after Docker fails its Compose dependency check on a fresh install', async () => {
    const fixture = backend();
    const runner = localDockerRunner({ run: vi.fn(async (_file, args) => {
      if (args[0] === 'compose') throw new CommandExecutionError('Compose missing', 1);
      return { stdout: '', stderr: '' };
    }) });
    const dockerRunner: CommandRunner = { run(file, args, options) {
      if (args.includes('compose')) return Promise.reject(new CommandExecutionError('Compose missing', 1));
      return runner.run(file, args, options);
    } };
    const manager = new DataTierManager({
      ...host, buildContext: fixture.dir, stateDirectory: fixture.dir, version: '1.7.0',
      runner: dockerRunner, fileExists: path => path.endsWith('docker.exe'), portAvailable: async () => true,
    });
    await expect(manager.create()).rejects.toThrow('Compose is missing');
    expect(readContainerOwnership(join(fixture.dir, 'ownership'), 'data-tier')).toBeUndefined();
    expect(await fixture.manager().create()).toMatchObject({ port: 7717, provider: 'podman' });
  });

  it.each(['load', 'compose'])('reuses the pending Windows volume and port with the new installer image after %s fails', async failure => {
    const fixture = backend();
    let failing = true;
    let version = '1.7.0';
    const runner: CommandRunner = { run(file, args, options) {
      if (failing && (failure === 'load' ? args.includes('load') : args.includes('up'))) {
        return Promise.reject(new CommandExecutionError('temporary failure', 1));
      }
      return fixture.runner.run(file, args, options);
    } };
    const manager = () => new DataTierManager({
      ...host, provider: 'podman', buildContext: fixture.dir, stateDirectory: fixture.dir, version,
      runner, fileExists: path => path.endsWith('podman.exe'), portAvailable: async () => true,
      healthy: async () => true,
    });
    await expect(manager().create('Recover me')).rejects.toThrow('temporary failure');
    const pending = JSON.parse(readFileSync(join(fixture.dir, 'pending-instance.json'), 'utf8'));
    version = '1.7.1';
    await expect(manager().create('Do not allocate another port')).rejects.toThrow('temporary failure');
    expect(JSON.parse(readFileSync(join(fixture.dir, 'pending-instance.json'), 'utf8'))).toEqual({
      ...pending, instance: { ...pending.instance, image: 'working-memory-control-plane:1.7.1' },
    });
    failing = false;
    expect(await manager().create()).toEqual({ ...pending.instance, image: 'working-memory-control-plane:1.7.1' });
    expect(JSON.parse(readFileSync(join(fixture.dir, 'instances', '7717', 'compose.yaml'), 'utf8')))
      .toMatchObject({ services: { 'control-plane': {
        image: 'working-memory-control-plane:1.7.1',
        volumes: [{ type: 'volume', source: 'working-memory-data', target: '/data' }],
        ports: ['127.0.0.1:7717:7717'],
      } } });
    expect(fixture.calls.filter(args => args[0] === 'volume' && args[1] === 'create')).toEqual([['volume', 'create', 'working-memory-data']]);
    expect(existsSync(join(fixture.dir, 'pending-instance.json'))).toBe(false);
    expect(manager().instances).toHaveLength(1);
  });

  it('refuses to replace a lost pending volume after an image-load failure', async () => {
    const fixture = backend();
    const runner: CommandRunner = { run(file, args, options) {
      if (args.includes('load')) return Promise.reject(new CommandExecutionError('archive failure', 1));
      return fixture.runner.run(file, args, options);
    } };
    const manager = () => new DataTierManager({
      ...host, provider: 'podman', buildContext: fixture.dir, stateDirectory: fixture.dir, version: '1.7.0',
      runner, fileExists: path => path.endsWith('podman.exe'), portAvailable: async () => true,
    });
    await expect(manager().create()).rejects.toThrow('archive failure');
    fixture.loseVolume();
    fixture.calls.length = 0;
    await expect(manager().create()).rejects.toThrow('Refusing to create an empty replacement');
    expect(fixture.calls.some(args => args[1] === 'create')).toBe(false);
  });

  it.each(['start', 'stop'] as const)('adopts exited legacy instances with only configured bindings on %s and refuses later context changes', async operation => {
    const dir = directory();
    writeFileSync(join(dir, 'instances.json'), JSON.stringify({ instances: [7717, 7719].map(port => ({ port, name: `Legacy ${port}` })) }));
    let endpoint = 'unix:///original.sock';
    const mutations: string[][] = [];
    const runner: CommandRunner = { run: vi.fn(async (_file, args) => {
      if (args[0] === 'context' && args[1] === 'show') return { stdout: 'desktop-linux', stderr: '' };
      const command = args.slice(2);
      if (command[0] === 'context') return { stdout: JSON.stringify(endpoint), stderr: '' };
      if (command[0] === 'inspect') {
        const container = legacyContainer(command[1].endsWith('-7719') ? 7719 : 7717);
        container.State.Running = false;
        container.NetworkSettings.Ports = {};
        return { stdout: JSON.stringify([container]), stderr: '' };
      }
      if (command[0] === 'ps') return { stdout: 'working-memory-control-plane\texited\tExited\tworking-memory-control-plane:1.7.0', stderr: '' };
      if (command[0] === 'start' || command[0] === 'stop') mutations.push(command);
      return { stdout: '', stderr: '' };
    }) };
    const manager = () => new DataTierManager({
      ...host, buildContext: dir, stateDirectory: dir, version: '1.7.0', runner,
      fileExists: path => path.endsWith('docker.exe'), healthy: async () => true,
    });
    await manager()[operation](7717);
    expect(manager().instances[0]).toMatchObject({ provider: 'docker', connection: 'desktop-linux (unix:///original.sock)' });
    expect(manager().instances.every(instance => instance.connection === 'desktop-linux (unix:///original.sock)')).toBe(true);
    expect(manager().instances[0].image).toBe('working-memory-control-plane:1.6.0');
    endpoint = 'unix:///other.sock';
    await expect(manager()[operation](7717)).rejects.toThrow('another container provider or connection');
    expect(mutations).toHaveLength(1);
  });

  it.each(['missing', 'public', 'wrong-port', 'multiple'] as const)('refuses unsafe configured bindings on an exited legacy instance: %s', async fault => {
    const dir = directory();
    const registrations = JSON.stringify({ instances: [{ port: 7717, name: 'Legacy' }] });
    writeFileSync(join(dir, 'instances.json'), registrations);
    const container = legacyContainer(7717);
    container.State.Running = false;
    container.NetworkSettings.Ports = {};
    const binding = container.HostConfig.PortBindings['7717/tcp'];
    if (fault === 'missing') container.HostConfig.PortBindings = {};
    if (fault === 'public') binding[0].HostIp = '0.0.0.0';
    if (fault === 'wrong-port') binding[0].HostPort = '7719';
    if (fault === 'multiple') binding.push({ HostIp: '0.0.0.0', HostPort: '7717' });
    const calls: string[][] = [];
    const runner = localDockerRunner({ run: vi.fn(async (_file, args) => {
      calls.push(args);
      return { stdout: args[0] === 'inspect' ? JSON.stringify([container]) : '', stderr: '' };
    }) });
    const manager = new DataTierManager({
      ...host, buildContext: dir, stateDirectory: dir, version: '1.7.0', runner,
      fileExists: path => path.endsWith('docker.exe'), healthy: async () => true,
    });
    await expect(manager.start(7717)).rejects.toThrow('ownership could not be verified');
    expect(readFileSync(join(dir, 'instances.json'), 'utf8')).toBe(registrations);
    expect(readContainerOwnership(join(dir, 'ownership'), 'data-tier')).toBeUndefined();
    expect(calls.some(args => ['start', 'stop', 'compose', 'exec'].includes(args[0]))).toBe(false);
  });

  it.each(['missing-container', 'image', 'labels', 'mount', 'port', 'storage', 'second-instance'])(
    'does not adopt any legacy registration from an unverified engine (%s), even after listing',
    async fault => {
      const dir = directory();
      const registrations = JSON.stringify({ instances: [7717, 7719].map(port => ({ port, name: `Legacy ${port}` })) });
      writeFileSync(join(dir, 'instances.json'), registrations);
      let repaired = false;
      const calls: string[][] = [];
      const runner: CommandRunner = { run: vi.fn(async (_file, args) => {
        if (args[0] === 'context' && args[1] === 'show') return { stdout: 'desktop-linux', stderr: '' };
        const command = args.slice(2);
        calls.push(command);
        if (command[0] === 'context') return { stdout: JSON.stringify(repaired ? 'unix:///original.sock' : 'unix:///other.sock'), stderr: '' };
        if (command[0] === 'inspect') {
          const port = command[1].endsWith('-7719') ? 7719 : 7717;
          if (!repaired && (fault === 'missing-container' || (fault === 'second-instance' && port === 7719))) {
            throw new CommandExecutionError('No such container', 1);
          }
          const container = legacyContainer(port);
          if (!repaired) {
            if (fault === 'image') container.Config.Image = 'unrelated:latest';
            if (fault === 'labels') container.Config.Labels['com.docker.compose.project'] = 'other';
            if (fault === 'mount') container.Mounts[0].Name = 'other';
            if (fault === 'port') container.NetworkSettings.Ports[`${port}/tcp`][0].HostIp = '0.0.0.0';
          }
          return { stdout: JSON.stringify([container]), stderr: '' };
        }
        if (!repaired && fault === 'storage' && command[0] === 'volume') throw new CommandExecutionError('No such volume', 1);
        return { stdout: '', stderr: '' };
      }) };
      const manager = () => new DataTierManager({
        ...host, buildContext: dir, stateDirectory: dir, version: '1.7.0', runner,
        fileExists: path => path.endsWith('docker.exe'), healthy: async () => true,
      });
      await manager().list();
      expect(calls.some(args => args[0] === 'inspect')).toBe(false);
      expect(readFileSync(join(dir, 'instances.json'), 'utf8')).toBe(registrations);
      expect(readContainerOwnership(join(dir, 'ownership'), 'data-tier')).toBeUndefined();
      await expect(manager().stop(7717)).rejects.toThrow('ownership could not be verified');
      expect(readFileSync(join(dir, 'instances.json'), 'utf8')).toBe(registrations);
      expect(readContainerOwnership(join(dir, 'ownership'), 'data-tier')).toBeUndefined();
      expect(calls.some(args => ['start', 'stop', 'load', 'compose'].includes(args[0]) && args[1] !== 'version')).toBe(false);
      repaired = true;
      await manager().stop(7717);
      expect(manager().instances.every(instance => instance.connection === 'desktop-linux (unix:///original.sock)')).toBe(true);
    },
  );

  it.each([
    ['(starting)', 'starting'], ['(health: starting)', 'starting'], ['(unhealthy)', 'unhealthy'],
  ])('preserves provider health-state reporting: %s', async (health, expected) => {
    const dir = directory();
    writeFileSync(join(dir, 'instances.json'), JSON.stringify({ instances: [{ port: 7717, provider: 'podman' }] }));
    const runner = podmanRunner(async args => ({
      stdout: args[0] === 'ps' ? `working-memory-control-plane\trunning\tUp ${health}\tlocalhost/working-memory-control-plane:1.7.0` : '{}',
      stderr: '',
    }));
    const manager = new DataTierManager({
      ...host, provider: 'podman', buildContext: dir, stateDirectory: dir, version: '1.7.0',
      runner, fileExists: path => path.endsWith('podman.exe'),
    });
    expect((await manager.list()).instances[0]).toMatchObject({ state: expected, version: '1.7.0' });
  });

  it('preserves crash/health facts but excludes environment credentials and health-check output from diagnostics', async () => {
    const dir = directory();
    writeFileSync(join(dir, 'instances.json'), JSON.stringify({ instances: [{ port: 7717, provider: 'podman' }] }));
    const runner = podmanRunner(async args => ({
      stdout: args[0] === 'container' ? JSON.stringify([{
        Image: 'sha256:abc', RestartCount: 3, Config: { Image: 'localhost/backend:1.7.0', Env: ['SECRET=never-report'] },
        State: { Status: 'exited', OOMKilled: true, ExitCode: 137,
          StartedAt: '2026-01-01T00:00:00Z', FinishedAt: '2026-01-01T01:00:00Z',
          Healthcheck: { Status: 'unhealthy', FailingStreak: 2,
            Log: [{ Start: 'start', End: 'end', ExitCode: 1, Output: 'sensitive-health-output' }] } },
      }]) : '{}', stderr: '',
    }));
    const manager = new DataTierManager({
      ...host, provider: 'podman', buildContext: dir, stateDirectory: dir, version: '1.7.0',
      runner, fileExists: path => path.endsWith('podman.exe'),
    });
    const state = await manager.diagnosticState(7717);
    expect(state.evidence).toContain('OOM killed: true; exit code: 137; restart count: 3');
    expect(state.evidence).toContain('health: unhealthy; failing streak: 2');
    expect(state.evidence).toContain('Health check start to end: exit 1');
    expect(state.evidence).not.toContain('never-report');
    expect(state.evidence).not.toContain('sensitive-health-output');
  });

  it.each(['image', 'labels', 'mount', 'port', 'healthy'])('keeps strict owner-bootstrap verification for Podman: %s', async fault => {
    const dir = directory();
    writeFileSync(join(dir, 'instances.json'), JSON.stringify({ instances: [{
      port: 7717, provider: 'podman', image: 'working-memory-control-plane:1.7.0',
    }] }));
    const inspected = {
      Config: { Image: fault === 'image' ? 'other:local' : 'localhost/working-memory-control-plane:1.7.0',
        Labels: { 'com.docker.compose.project': fault === 'labels' ? 'other' : 'working-memory', 'com.docker.compose.service': 'control-plane' } },
      Mounts: [{ Type: 'volume', Name: fault === 'mount' ? 'other' : 'working-memory-data', Source: '/engine/volume', Destination: '/data' }],
      NetworkSettings: { Ports: { '7717/tcp': [{ HostIp: fault === 'port' ? '0.0.0.0' : '127.0.0.1', HostPort: '7717' }] } },
    };
    const runner = podmanRunner(async args => ({
      stdout: args[0] === 'inspect' ? JSON.stringify([inspected]) : args[0] === 'exec' ? 't'.repeat(43) : '{}', stderr: '',
    }));
    const manager = new DataTierManager({
      ...host, provider: 'podman', buildContext: dir, stateDirectory: dir, version: '1.7.0',
      runner, fileExists: path => path.endsWith('podman.exe'),
    });
    if (fault === 'healthy') {
      expect(await manager.bootstrapCredential(7717)).toBe('t'.repeat(43));
    } else {
      await expect(manager.bootstrapCredential(7717)).rejects.toThrow('does not match');
      expect(vi.mocked(runner.run).mock.calls.some(([, args]) => args.includes('exec'))).toBe(false);
    }
  });
});

describe('pending bind storage recovery', () => {
  function backend(platform: 'darwin' | 'linux', initialize: boolean) {
    const dir = directory();
    const testHost = { platform, homedir: dir, env: { PATH: '/usr/bin' } };
    const data = dataTierHostDirectory(testHost);
    const database = join(data, 'journal.sqlite');
    let failing = true;
    const calls: string[][] = [];
    const runner = localDockerRunner({ run: vi.fn(async (_file, args) => {
      calls.push(args);
      if (args[0] === 'compose') {
        if (initialize || !failing) writeFileSync(database, 'initialized data');
        if (failing) throw new CommandExecutionError('partial Compose failure', 1);
      }
      return { stdout: '', stderr: '' };
    }) });
    const manager = () => new DataTierManager({
      ...testHost, buildContext: dir, stateDirectory: dir, version: '1.7.0', runner,
      fileExists: path => path.endsWith('/docker'), healthy: async () => true, portAvailable: async () => true,
    });
    return { dir, data, database, calls, manager, recover: () => { failing = false; } };
  }

  it.each(['darwin', 'linux'] as const)('retries an uninitialized reservation without allocating new storage on %s', async platform => {
    const fixture = backend(platform, false);
    await expect(fixture.manager().create()).rejects.toThrow('partial Compose failure');
    expect(JSON.parse(readFileSync(join(fixture.dir, 'pending-instance.json'), 'utf8'))).toMatchObject({
      storageReady: true, databaseInitialized: false,
    });
    fixture.recover();
    expect(await fixture.manager().create()).toMatchObject({ port: 7717 });
    expect(readFileSync(fixture.database, 'utf8')).toBe('initialized data');
  });

  it.each(['darwin', 'linux'] as const)('recovers initialized pending data after a failed Compose call on %s', async platform => {
    const fixture = backend(platform, true);
    await expect(fixture.manager().create()).rejects.toThrow('partial Compose failure');
    expect(JSON.parse(readFileSync(join(fixture.dir, 'pending-instance.json'), 'utf8'))).toMatchObject({
      storageReady: true, databaseInitialized: true,
    });
    fixture.recover();
    expect(await fixture.manager().create()).toMatchObject({ port: 7717 });
    expect(fixture.manager().instances).toHaveLength(1);
  });

  it.each([
    ['darwin', 'database'], ['darwin', 'directory'], ['linux', 'database'], ['linux', 'directory'],
  ] as const)('refuses lost pending %s bind %s after partial initialization', async (platform, lost) => {
    const fixture = backend(platform, true);
    await expect(fixture.manager().create()).rejects.toThrow('partial Compose failure');
    rmSync(lost === 'database' ? fixture.database : fixture.data, { recursive: lost === 'directory' });
    fixture.calls.length = 0;
    fixture.recover();
    await expect(fixture.manager().create()).rejects.toThrow('no empty replacement will be created');
    expect(fixture.calls.some(args => args[0] === 'load' || args[0] === 'compose')).toBe(false);
    expect(existsSync(fixture.database)).toBe(false);
    expect(fixture.manager().instances).toEqual([]);
  });
});

describe('Podman Container Apps', () => {
  const claim: ContainerClaim = {
    id: 'test-app', title: 'Test app', repository: '/repo', created_at: 1, updated_at: 1, resourceVersion: 1,
    runtime: { type: 'docker', buildContext: '/repo', dockerfile: '/repo/Dockerfile',
      imageName: 'team/test-app:local', containerName: 'test-app', hostPort: 4173, containerPort: 80, entryPath: '/', healthPath: '/',
      volumes: [{ name: 'test-app-data', mountPath: '/data' }] },
  };

  it.each(['docker', 'podman'] as const)('initializes storage through desktop launch on %s only after trusted confirmation', async provider => {
    const dir = directory();
    let volumePresent = false;
    const calls: string[][] = [];
    const handler: CommandRunner = { run: vi.fn(async (_file, args) => {
      calls.push(args);
      if (args[0] === 'container' && args[1] === 'inspect') throw new CommandExecutionError('No such container', 1);
      if (args[0] === 'volume' && args[1] === 'inspect' && !volumePresent) throw new CommandExecutionError('No such volume', 1);
      if (args[0] === 'volume' && args[1] === 'create') volumePresent = true;
      return { stdout: args[0] === 'image' ? 'abc' : '', stderr: '' };
    }) };
    const runner = provider === 'docker' ? localDockerRunner(handler) : podmanRunner(args => handler.run(provider, args));
    const confirmStorageCreation = vi.fn(async () => true);
    const service = () => new DockerContainerService({
      provider, stateDirectory: dir, runner, confirmStorageCreation, readiness: async () => true,
    });
    expect(await service().launch(claim)).toMatchObject({ status: 'ready', action: 'created' });
    expect(confirmStorageCreation).toHaveBeenCalledWith(claim, provider);
    expect(readContainerOwnership(dir, 'volume:test-app-data')).toMatchObject({ provider });
    expect(await service().launch(claim)).toMatchObject({ status: 'ready', action: 'created' });
    expect(confirmStorageCreation).toHaveBeenCalledTimes(1);
    expect(calls.filter(args => args[0] === 'volume' && args[1] === 'create')).toHaveLength(1);
    volumePresent = false;
    expect(await service().launch(claim)).toMatchObject({ status: 'error', message: expect.stringContaining('No such volume') });
    expect(confirmStorageCreation).toHaveBeenCalledTimes(1);
  });

  it.each(['cancel', 'existing-volume', 'recorded-volume', 'abort'] as const)('does not provision unverified desktop storage on %s', async outcome => {
    const dir = directory();
    if (outcome === 'recorded-volume') {
      checkContainerOwnership(dir, 'volume:test-app-data', { provider: 'docker', connection: 'original' }, true);
    }
    const controller = new AbortController();
    const calls: string[][] = [];
    const runner = podmanRunner(async args => {
      calls.push(args);
      if (args[0] === 'container') throw new CommandExecutionError('No such container', 1);
      if (args[0] === 'volume' && outcome !== 'existing-volume') throw new CommandExecutionError('No such volume', 1);
      return { stdout: args[0] === 'image' ? 'abc' : '', stderr: '' };
    });
    const confirmStorageCreation = vi.fn(async () => {
      if (outcome === 'abort') controller.abort();
      return outcome !== 'cancel';
    });
    const service = new DockerContainerService({ provider: 'podman', stateDirectory: dir, runner, confirmStorageCreation });
    expect(await service.launch(claim, controller.signal)).toMatchObject({ status: 'error', code: 'container_conflict' });
    expect(readContainerOwnership(dir, claim.id)).toBeUndefined();
    expect(readContainerOwnership(dir, 'pending-volume:test-app:test-app-data')).toBeUndefined();
    expect(calls.some(args => args[1] === 'create' || args[1] === 'run')).toBe(false);
    expect(confirmStorageCreation).toHaveBeenCalledTimes(['existing-volume', 'recorded-volume'].includes(outcome) ? 0 : 1);
  });

  it('builds/runs/inspects/stops owned apps and refuses engine switches and unsafe inspections', async () => {
    let present = false;
    const calls: string[][] = [];
    const inspected = {
      Image: 'sha256:abc', State: { Running: true, Healthcheck: { Status: 'healthy' } },
      Config: { Image: 'localhost/team/test-app:local', Labels: { [MANAGED_LABEL]: 'true', [CLAIM_LABEL]: claim.id } },
      HostConfig: { PortBindings: { '80/tcp': [{ HostIp: '127.0.0.1', HostPort: '4173' }] } },
      Mounts: [{ Name: 'test-app-data', Type: 'volume', Destination: '/data' }],
    };
    const runner = podmanRunner(async args => {
      calls.push(args);
      if (args[0] === 'image') return { stdout: 'abc', stderr: '' };
      if (args[0] === 'container' && args[1] === 'inspect') {
        if (!present) throw new CommandExecutionError('no such container', 1);
        return { stdout: JSON.stringify([inspected]), stderr: '' };
      }
      if (args[0] === 'container' && args[1] === 'run') present = true;
      return { stdout: '', stderr: '' };
    });
    const stateDirectory = directory();
    const service = new DockerContainerService({ provider: 'podman', stateDirectory, runner, readiness: async () => true });
    expect(await service.ensure({
      containerClaimRead: async () => [],
      containerClaimCreate: async () => claim,
      containerClaimUpdate: async () => claim,
    }, claim)).toMatchObject({ status: 'ready', action: 'created' });
    expect(await service.launch(claim)).toMatchObject({ status: 'ready', action: 'reused' });
    expect(await service.inspect(claim)).toMatchObject({ ready: true, state: 'healthy' });
    expect(await service.stop(claim)).toMatchObject({ status: 'stopped' });
    const dockerRunner: CommandRunner = { run: vi.fn(async () => ({ stdout: '{}', stderr: '' })) };
    const docker = new DockerContainerService({ stateDirectory, runner: localDockerRunner(dockerRunner) });
    expect(await docker.launch(claim)).toMatchObject({ status: 'error', message: expect.stringContaining('another container provider') });
    expect(vi.mocked(dockerRunner.run).mock.calls.some(([, args]) => args.includes('build') || args.includes('run'))).toBe(false);
    inspected.HostConfig.PortBindings['80/tcp'][0].HostIp = '0.0.0.0';
    expect(await service.inspect(claim)).toMatchObject({ state: 'error' });
    inspected.Config.Labels[CLAIM_LABEL] = 'other-claim';
    expect(await service.launch(claim)).toMatchObject({ status: 'error', code: 'container_conflict' });
    expect(calls.some(args => args.includes('--context'))).toBe(false);
    expect(calls).toContainEqual(['volume', 'create', 'test-app-data']);
  });

  it('refuses unverified legacy stateful claims on Podman after changing environments, before reserving ownership or creating data', async () => {
    const dir = directory();
    const runner = podmanRunner();
    const service = new DockerContainerService({ provider: 'podman', stateDirectory: dir, runner });
    expect(await service.launch(claim)).toMatchObject({
      status: 'error', message: expect.stringContaining('Legacy apps belong to Docker'),
    });
    expect(readContainerOwnership(dir, claim.id)).toBeUndefined();
    expect(readContainerOwnership(dir, 'volume:test-app-data')).toBeUndefined();
    expect(vi.mocked(runner.run).mock.calls.some(([, args]) => args.includes('build')
      || args.includes('run') || args.includes('create'))).toBe(false);
  });

  it.each(['reuse', 'start', 'inspect', 'stop'])('adopts legacy Docker app and volume ownership during %s, then refuses lost storage', async operation => {
    const dir = directory();
    let containerPresent = true;
    let volumePresent = true;
    const calls: string[][] = [];
    const inspected = {
      Image: 'sha256:abc', State: { Running: operation !== 'start' },
      Config: { Image: claim.runtime!.imageName, Labels: { [MANAGED_LABEL]: 'true', [CLAIM_LABEL]: claim.id } },
      HostConfig: { PortBindings: { '80/tcp': [{ HostIp: '127.0.0.1', HostPort: '4173' }] } },
      Mounts: [{ Name: 'test-app-data', Type: 'volume', Destination: '/data' }],
    };
    const runner = localDockerRunner({ run: vi.fn(async (_file, args) => {
      calls.push(args);
      if (args[0] === 'container' && args[1] === 'inspect') {
        if (!containerPresent) throw new CommandExecutionError('No such container', 1);
        return { stdout: JSON.stringify([inspected]), stderr: '' };
      }
      if (args[0] === 'volume' && args[1] === 'inspect' && !volumePresent) throw new CommandExecutionError('No such volume', 1);
      return { stdout: args[0] === 'image' ? 'abc' : '', stderr: '' };
    }) });
    const manager = () => new DockerContainerService({ stateDirectory: dir, runner, readiness: async () => true });
    if (operation === 'inspect') expect(await manager().inspect(claim)).toMatchObject({ state: 'healthy' });
    else if (operation === 'stop') expect(await manager().stop(claim)).toMatchObject({ status: 'stopped' });
    else expect(await manager().launch(claim)).toMatchObject({ status: 'ready', action: operation === 'reuse' ? 'reused' : 'started' });
    expect(readContainerOwnership(dir, claim.id)).toMatchObject({ provider: 'docker' });
    expect(readContainerOwnership(dir, 'volume:test-app-data')).toMatchObject({ provider: 'docker' });
    containerPresent = false;
    volumePresent = false;
    calls.length = 0;
    expect(await manager().launch(claim)).toMatchObject({ status: 'error', message: expect.stringContaining('No such volume') });
    expect(calls.some(args => args[1] === 'create' || args[1] === 'run' || args[1] === 'rm')).toBe(false);
  });

  it('refuses to manufacture storage for a claim adopted before volume ownership was recorded', async () => {
    const dir = directory();
    checkContainerOwnership(dir, claim.id, { provider: 'docker', connection: 'desktop-linux (unix:///local/docker.sock)' }, true);
    const calls: string[][] = [];
    const runner = localDockerRunner({ run: vi.fn(async (_file, args) => {
      calls.push(args);
      if (args[0] === 'container') throw new CommandExecutionError('No such container', 1);
      return { stdout: args[0] === 'image' ? 'abc' : '', stderr: '' };
    }) });
    const service = new DockerContainerService({ stateDirectory: dir, runner });
    expect(await service.launch(claim)).toMatchObject({ status: 'error', message: expect.stringContaining('empty replacement volume') });
    expect(calls.some(args => args[1] === 'create' || args[1] === 'run')).toBe(false);
  });

  it('retains explicit new-claim provisioning intent across a build failure and retry', async () => {
    const dir = directory();
    let failing = true;
    const calls: string[][] = [];
    const runner = podmanRunner(async args => {
      calls.push(args);
      if (args[0] === 'build' && failing) throw new CommandExecutionError('temporary build failure', 1);
      if (args[0] === 'container' && args[1] === 'inspect') throw new CommandExecutionError('No such container', 1);
      return { stdout: args[0] === 'image' ? 'abc' : '', stderr: '' };
    });
    const service = () => new DockerContainerService({ stateDirectory: dir, provider: 'podman', runner, readiness: async () => true });
    expect(await service().ensure({
      containerClaimRead: async () => [],
      containerClaimCreate: async () => claim,
      containerClaimUpdate: async () => claim,
    }, claim)).toMatchObject({ status: 'error', code: 'build_failed' });
    failing = false;
    expect(await service().launch(claim)).toMatchObject({ status: 'ready', action: 'created' });
    expect(calls.filter(args => args[0] === 'volume' && args[1] === 'create')).toEqual([['volume', 'create', 'test-app-data']]);
  });
});
