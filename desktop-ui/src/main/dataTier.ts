import { spawn } from 'node:child_process';
import { accessSync, constants, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { homedir as systemHomedir } from 'node:os';
import { join, posix, win32 } from 'node:path';
import {
  DEFAULT_CONTROL_PLANE_SERVICE_PORT,
  resolveControlPlaneHome,
} from '../../../shared/controlPlaneShared';
import {
  CommandExecutionError,
  ExecFileCommandRunner,
  type CommandRunner,
} from './dockerContainerService';
import type {
  DataTierInstanceState,
  DataTierInstanceStatus,
  DataTierInstancesSnapshot,
  ManagedDataTierInstance,
} from '../shared/contracts';

export type { DataTierInstanceState, DataTierInstanceStatus, DataTierInstancesSnapshot, ManagedDataTierInstance };

export const DATA_TIER_PROJECT = 'working-memory';
export const DATA_TIER_SERVICE = 'control-plane';
export const DATA_TIER_CONTAINER = 'working-memory-control-plane';
export const DATA_TIER_VOLUME = 'working-memory-data';
export const DOCKER_DESKTOP_URL = 'https://www.docker.com/products/docker-desktop/';

export interface DataTierHost {
  platform: NodeJS.Platform;
  env: NodeJS.ProcessEnv;
  homedir: string;
}

export interface DataTierOptions extends Partial<DataTierHost> {
  /** Directory containing the bundled control-plane Dockerfile build context. */
  buildContext: string;
  /** Writable directory for instance state and generated Compose files. */
  stateDirectory: string;
  version: string;
  runner?: CommandRunner;
  launchDetached?: (file: string, args: string[]) => void;
  healthy?: (url: string) => Promise<boolean>;
  sleep?: (ms: number) => Promise<void>;
  fileExists?: (path: string) => boolean;
  portAvailable?: (port: number) => Promise<boolean>;
  now?: () => Date;
  timeouts?: Partial<DataTierTimeouts>;
}

export interface DataTierTimeouts {
  info: number;
  dockerStart: number;
  composeUp: number;
  command: number;
  health: number;
  poll: number;
}

const DEFAULT_TIMEOUTS: DataTierTimeouts = {
  info: 15_000,
  dockerStart: 120_000,
  composeUp: 15 * 60_000,
  command: 60_000,
  health: 120_000,
  poll: 2_000,
};

export class DataTierError extends Error {
  constructor(message: string, readonly code: 'docker-missing' | 'docker-unavailable' | 'start-failed' | 'unhealthy' | 'not-found' | 'not-running') {
    super(message);
    this.name = 'DataTierError';
  }
}

function pathFor(platform: NodeJS.Platform): typeof posix {
  return platform === 'win32' ? win32 : posix;
}

function pathDirectories(host: DataTierHost): string[] {
  const raw = host.env.PATH ?? host.env.Path ?? '';
  return raw.split(host.platform === 'win32' ? ';' : ':').filter(Boolean);
}

/** Install locations that GUI-launched apps often lack on PATH. */
function extraDockerDirectories(host: DataTierHost): string[] {
  const path = pathFor(host.platform);
  if (host.platform === 'win32') {
    const programFiles = host.env.ProgramFiles || 'C:\\Program Files';
    return [path.join(programFiles, 'Docker', 'Docker', 'resources', 'bin')];
  }
  if (host.platform === 'darwin') {
    return [
      '/usr/local/bin',
      '/opt/homebrew/bin',
      path.join(host.homedir, '.docker', 'bin'),
      '/Applications/Docker.app/Contents/Resources/bin',
    ];
  }
  return ['/usr/local/bin', '/usr/bin'];
}

function defaultFileExists(platform: NodeJS.Platform): (candidate: string) => boolean {
  return (candidate) => {
    try {
      accessSync(candidate, platform === 'win32' ? constants.F_OK : constants.X_OK);
      return true;
    } catch {
      return false;
    }
  };
}

export function dockerCliPath(
  host: DataTierHost,
  fileExists: (path: string) => boolean = defaultFileExists(host.platform),
): string | undefined {
  const path = pathFor(host.platform);
  const executable = host.platform === 'win32' ? 'docker.exe' : 'docker';
  return [...pathDirectories(host), ...extraDockerDirectories(host)]
    .map((directory) => path.join(directory, executable))
    .find(fileExists);
}

/** Child environment that can find Docker's Compose plugin and credential helpers. */
export function dockerEnvironment(host: DataTierHost, dockerPath: string): NodeJS.ProcessEnv {
  const path = pathFor(host.platform);
  const separator = host.platform === 'win32' ? ';' : ':';
  const directories = [...new Set([
    path.dirname(dockerPath),
    ...extraDockerDirectories(host),
    ...pathDirectories(host),
  ])];
  const { Path: _windowsPath, ...env } = host.env;
  return { ...env, PATH: directories.join(separator) };
}



/** Ports for added instances; 7718 is reserved for the desktop link bridge. */
export const DATA_TIER_INSTANCE_PORT_FIRST = 7719;
export const DATA_TIER_INSTANCE_PORT_LAST = 7799;
export const DATA_TIER_STATE_FILE = 'instances.json';
const IMAGE_REPOSITORY = 'working-memory-control-plane';
const CONTAINER_DATABASE = '/data/journal.sqlite';

/** Docker and host names for one data-tier instance; the default instance keeps the original names. */
export interface DataTierInstanceNames {
  port: number;
  project: string;
  container: string;
  volume: string;
}

export function dataTierInstanceNames(port: number): DataTierInstanceNames {
  if (port === DEFAULT_CONTROL_PLANE_SERVICE_PORT) {
    return { port, project: DATA_TIER_PROJECT, container: DATA_TIER_CONTAINER, volume: DATA_TIER_VOLUME };
  }
  return {
    port,
    project: `${DATA_TIER_PROJECT}-${port}`,
    container: `${DATA_TIER_CONTAINER}-${port}`,
    volume: `${DATA_TIER_VOLUME}-${port}`,
  };
}

export function dataTierHostDirectory(host: DataTierHost, port = DEFAULT_CONTROL_PLANE_SERVICE_PORT): string {
  const home = resolveControlPlaneHome({ ...host, allowEnvOverride: false });
  return port === DEFAULT_CONTROL_PLANE_SERVICE_PORT ? home : `${home}-${port}`;
}

/**
 * Compose definition for one installed data-tier instance. Windows keeps SQLite in a
 * Docker volume because WAL locking is unreliable on Windows bind mounts; macOS and
 * Linux use the host application-data directory so existing stores are reused.
 */
export function dataTierCompose(
  host: DataTierHost,
  buildContext: string,
  version: string,
  port = DEFAULT_CONTROL_PLANE_SERVICE_PORT,
): Record<string, unknown> {
  const names = dataTierInstanceNames(port);
  const dataMount = host.platform === 'win32'
    ? { type: 'volume', source: names.volume, target: '/data' }
    : { type: 'bind', source: dataTierHostDirectory(host, port), target: '/data' };
  return {
    name: names.project,
    services: {
      [DATA_TIER_SERVICE]: {
        container_name: names.container,
        image: `${IMAGE_REPOSITORY}:${version}`,
        build: { context: buildContext, dockerfile: 'Dockerfile' },
        init: true,
        restart: 'unless-stopped',
        environment: {
          WM_CONTROL_PLANE_HOME: '/data',
          WM_CONTROL_PLANE_HOST: '0.0.0.0',
          WM_CONTROL_PLANE_PORT: String(port),
        },
        ports: [`127.0.0.1:${port}:${port}`],
        volumes: [dataMount],
      },
    },
    ...(host.platform === 'win32' ? { volumes: { [names.volume]: { name: names.volume } } } : {}),
  };
}

function validPort(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value > 0 && value <= 65_535;
}

export function defaultInstanceName(port: number): string {
  return port === DEFAULT_CONTROL_PLANE_SERVICE_PORT ? 'Working Memory' : `Working Memory ${port}`;
}

export function parseManagedInstances(raw: string): ManagedDataTierInstance[] {
  try {
    const parsed = JSON.parse(raw) as { instances?: unknown };
    if (!Array.isArray(parsed.instances)) return [];
    const byPort = new Map<number, ManagedDataTierInstance>();
    for (const candidate of parsed.instances as Array<Partial<ManagedDataTierInstance>>) {
      if (!candidate || !validPort(candidate.port) || byPort.has(candidate.port)) continue;
      const name = typeof candidate.name === 'string' && candidate.name.trim()
        ? candidate.name.trim().slice(0, 80)
        : defaultInstanceName(candidate.port);
      byPort.set(candidate.port, {
        port: candidate.port,
        name,
        createdAt: typeof candidate.createdAt === 'string' ? candidate.createdAt : '',
      });
    }
    return [...byPort.values()].sort((left, right) => left.port - right.port);
  } catch {
    return [];
  }
}

/** Reads the instances a desktop install manages, for environment discovery. */
export function readManagedInstances(stateDirectory: string): ManagedDataTierInstance[] {
  try {
    return parseManagedInstances(readFileSync(join(stateDirectory, DATA_TIER_STATE_FILE), 'utf8'));
  } catch {
    return [];
  }
}

function defaultPortAvailable(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const server = createServer();
    server.once('error', () => resolve(false));
    server.listen(port, '127.0.0.1', () => server.close(() => resolve(true)));
  });
}

async function defaultHealthy(url: string): Promise<boolean> {
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(3_000) });
    return response.ok;
  } catch {
    return false;
  }
}

function defaultLaunchDetached(file: string, args: string[]): void {
  const child = spawn(file, args, { detached: true, stdio: 'ignore', windowsHide: true });
  child.on('error', (error) => console.error('[data-tier] Unable to start Docker Desktop:', error));
  child.unref();
}

function commandDetail(error: unknown): string {
  if (error instanceof CommandExecutionError && error.stderr.trim()) {
    return error.stderr.trim().split(/\r?\n/).slice(-6).join('\n');
  }
  return error instanceof Error ? error.message : String(error);
}

function healthUrl(port: number): string {
  return `http://127.0.0.1:${port}/health`;
}

function mcpUrl(port: number): string {
  return `http://127.0.0.1:${port}/mcp`;
}

function imageVersion(image: string): string | null {
  const prefix = `${IMAGE_REPOSITORY}:`;
  return image.startsWith(prefix) ? image.slice(prefix.length) || null : null;
}

function containerState(dockerState: string, status: string): DataTierInstanceState {
  if (dockerState !== 'running') return 'stopped';
  if (status.includes('(health: starting)')) return 'starting';
  if (status.includes('(unhealthy)')) return 'unhealthy';
  return 'running';
}

function backupTimestamp(date: Date): string {
  const pad = (value: number) => String(value).padStart(2, '0');
  return `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}-${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`;
}

function fileSlug(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'instance';
}

/**
 * Creates and operates the Docker data-tier instances this desktop install manages.
 * Operations run one at a time so Compose never races itself over shared state.
 */
export class DataTierManager {
  private readonly host: DataTierHost;
  private readonly runner: CommandRunner;
  private readonly launchDetached: (file: string, args: string[]) => void;
  private readonly healthy: (url: string) => Promise<boolean>;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly fileExists: (path: string) => boolean;
  private readonly portAvailable: (port: number) => Promise<boolean>;
  private readonly now: () => Date;
  private readonly timeouts: DataTierTimeouts;
  private queue: Promise<unknown> = Promise.resolve();

  constructor(private readonly options: DataTierOptions) {
    this.host = {
      platform: options.platform ?? process.platform,
      env: options.env ?? process.env,
      homedir: options.homedir ?? systemHomedir(),
    };
    this.runner = options.runner ?? new ExecFileCommandRunner();
    this.launchDetached = options.launchDetached ?? defaultLaunchDetached;
    this.healthy = options.healthy ?? defaultHealthy;
    this.sleep = options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
    this.fileExists = options.fileExists ?? defaultFileExists(this.host.platform);
    this.portAvailable = options.portAvailable ?? defaultPortAvailable;
    this.now = options.now ?? (() => new Date());
    this.timeouts = { ...DEFAULT_TIMEOUTS, ...options.timeouts };
  }

  get appVersion(): string {
    return this.options.version;
  }

  get instances(): ManagedDataTierInstance[] {
    return readManagedInstances(this.options.stateDirectory);
  }

  /** Reports each managed instance's container state without starting Docker Desktop. */
  async list(): Promise<DataTierInstancesSnapshot> {
    const instances = this.instances;
    // Self-hosted servers come from environment discovery, which the manager does not own.
    const base = { appVersion: this.options.version, selfHosted: [] };
    const docker = dockerCliPath(this.host, this.fileExists);
    if (!docker) {
      return { ...base, dockerError: 'Docker Desktop is not installed.', instances: instances.map((instance) => this.status(instance)) };
    }
    const env = dockerEnvironment(this.host, docker);
    let containers: Map<string, { state: string; status: string; image: string }>;
    try {
      containers = await this.containers(docker, env);
    } catch {
      return { ...base, dockerError: 'Docker Desktop is not running.', instances: instances.map((instance) => this.status(instance)) };
    }
    return {
      ...base,
      dockerError: null,
      instances: instances.map((instance) => {
        const container = containers.get(dataTierInstanceNames(instance.port).container);
        return this.status(
          instance,
          container ? containerState(container.state, container.status) : 'missing',
          container ? imageVersion(container.image) : null,
        );
      }),
    };
  }

  /** Creates a managed instance on 7717 when free, otherwise the next free port from 7719. */
  create(name?: string): Promise<ManagedDataTierInstance> {
    return this.serialize(async () => {
      const { docker, env } = await this.docker();
      const port = await this.choosePort(docker, env);
      const instance = {
        port,
        name: name?.trim().slice(0, 80) || defaultInstanceName(port),
        createdAt: this.now().toISOString(),
      };
      await this.composeUp(docker, env, port);
      this.writeInstances([...this.instances, instance]);
      return instance;
    });
  }

  start(port: number): Promise<void> {
    return this.serialize(async () => {
      this.require(port);
      const { docker, env } = await this.docker();
      const container = (await this.containers(docker, env)).get(dataTierInstanceNames(port).container);
      if (!container) {
        await this.composeUp(docker, env, port);
        return;
      }
      if (container.state !== 'running') {
        await this.run(docker, env, ['start', dataTierInstanceNames(port).container], 'start-failed', 'Unable to start the Working Memory instance.');
      }
      await this.waitHealthy(port);
    });
  }

  stop(port: number): Promise<void> {
    return this.serialize(async () => {
      this.require(port);
      const { docker, env } = await this.docker();
      await this.run(docker, env, ['stop', dataTierInstanceNames(port).container], 'start-failed', 'Unable to stop the Working Memory instance.');
    });
  }

  /** Rebuilds the instance from this app version's image and keeps its data. */
  upgrade(port: number): Promise<void> {
    return this.serialize(async () => {
      this.require(port);
      const { docker, env } = await this.docker();
      await this.composeUp(docker, env, port);
    });
  }

  rename(port: number, name: string): Promise<ManagedDataTierInstance> {
    return this.serialize(async () => {
      const trimmed = name.trim().slice(0, 80);
      if (!trimmed) throw new Error('Instance name is required.');
      const instances = this.instances;
      const instance = instances.find((candidate) => candidate.port === port);
      if (!instance) throw new DataTierError('That Working Memory instance is not managed by this app.', 'not-found');
      instance.name = trimmed;
      this.writeInstances(instances);
      return instance;
    });
  }

  /** Writes a consistent SQLite snapshot of a running instance into the destination folder. */
  backup(port: number, destinationDirectory: string): Promise<string> {
    return this.serialize(async () => {
      const instance = this.require(port);
      const { docker, env } = await this.docker();
      const container = dataTierInstanceNames(port).container;
      const running = (await this.containers(docker, env)).get(container)?.state === 'running';
      if (!running) throw new DataTierError('Start the instance before backing it up.', 'not-running');
      const fileName = `working-memory-${fileSlug(instance.name)}-${backupTimestamp(this.now())}.sqlite`;
      const snapshot = `/tmp/${fileName}`;
      const vacuum = `const { DatabaseSync } = require('node:sqlite');`
        + `const db = new DatabaseSync(${JSON.stringify(CONTAINER_DATABASE)});`
        + `db.exec("VACUUM INTO '${snapshot}'"); db.close();`;
      await this.run(docker, env, ['exec', container, 'node', '--experimental-sqlite', '-e', vacuum], 'start-failed', 'Unable to snapshot the instance database.');
      const destination = join(destinationDirectory, fileName);
      try {
        await this.run(docker, env, ['cp', `${container}:${snapshot}`, destination], 'start-failed', 'Unable to copy the database backup.');
      } finally {
        await this.runner.run(docker, ['exec', container, 'rm', '-f', snapshot], { timeoutMs: this.timeouts.command, env }).catch(() => undefined);
      }
      return destination;
    });
  }

  /**
   * Used at launch when no healthy Working Memory is reachable: starts the preferred
   * managed instance, or creates the default one on a fresh install.
   */
  async ensureAvailable(preferredPort?: number): Promise<string> {
    const instances = this.instances;
    const target = instances.find((instance) => instance.port === preferredPort) ?? instances[0];
    if (!target) return mcpUrl((await this.create()).port);
    if (!(await this.healthy(healthUrl(target.port)))) await this.start(target.port);
    return mcpUrl(target.port);
  }

  private serialize<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.queue.then(operation, operation);
    this.queue = result.catch(() => undefined);
    return result;
  }

  private status(
    instance: ManagedDataTierInstance,
    state: DataTierInstanceState = 'unknown',
    version: string | null = null,
  ): DataTierInstanceStatus {
    return {
      ...instance,
      mcpUrl: mcpUrl(instance.port),
      container: dataTierInstanceNames(instance.port).container,
      state,
      version,
      updateAvailable: version !== null && version !== this.options.version,
    };
  }

  private require(port: number): ManagedDataTierInstance {
    const instance = this.instances.find((candidate) => candidate.port === port);
    if (!instance) throw new DataTierError('That Working Memory instance is not managed by this app.', 'not-found');
    return instance;
  }

  private async docker(): Promise<{ docker: string; env: NodeJS.ProcessEnv }> {
    const docker = dockerCliPath(this.host, this.fileExists);
    if (!docker) {
      throw new DataTierError(
        `Working Memory stores its data with Docker Desktop, which was not found. Install Docker Desktop (${DOCKER_DESKTOP_URL}), start it, then retry.`,
        'docker-missing',
      );
    }
    const env = dockerEnvironment(this.host, docker);
    await this.waitForDocker(docker, env);
    return { docker, env };
  }

  private async containers(
    docker: string,
    env: NodeJS.ProcessEnv,
  ): Promise<Map<string, { state: string; status: string; image: string }>> {
    const { stdout } = await this.runner.run(
      docker,
      ['ps', '--all', '--filter', `name=${DATA_TIER_CONTAINER}`, '--format', '{{.Names}}\t{{.State}}\t{{.Status}}\t{{.Image}}'],
      { timeoutMs: this.timeouts.info, env },
    );
    const containers = new Map<string, { state: string; status: string; image: string }>();
    for (const line of stdout.split(/\r?\n/)) {
      const [name, state, status, image] = line.split('\t');
      if (name && state !== undefined) containers.set(name.replace(/^\//, ''), { state, status: status ?? '', image: image ?? '' });
    }
    return containers;
  }

  private async choosePort(docker: string, env: NodeJS.ProcessEnv): Promise<number> {
    const managed = new Set(this.instances.map((instance) => instance.port));
    const containers = await this.containers(docker, env);
    const candidates = [DEFAULT_CONTROL_PLANE_SERVICE_PORT];
    for (let port = DATA_TIER_INSTANCE_PORT_FIRST; port <= DATA_TIER_INSTANCE_PORT_LAST; port += 1) candidates.push(port);
    for (const port of candidates) {
      if (managed.has(port) || containers.has(dataTierInstanceNames(port).container)) continue;
      if (await this.portAvailable(port)) return port;
    }
    throw new DataTierError(
      `No free port is available for a new Working Memory instance between ${DATA_TIER_INSTANCE_PORT_FIRST} and ${DATA_TIER_INSTANCE_PORT_LAST}.`,
      'start-failed',
    );
  }

  private async composeUp(docker: string, env: NodeJS.ProcessEnv, port: number): Promise<void> {
    const composeFile = this.writeComposeFile(port);
    try {
      await this.runner.run(docker, ['compose', '--file', composeFile, 'up', '--detach', '--wait'], {
        timeoutMs: this.timeouts.composeUp,
        env,
      });
    } catch (error) {
      throw new DataTierError(`Unable to start the Working Memory data tier with Docker Compose.\n${commandDetail(error)}`, 'start-failed');
    }
    await this.waitHealthy(port);
  }

  private async waitHealthy(port: number): Promise<void> {
    const deadline = Date.now() + this.timeouts.health;
    while (!(await this.healthy(healthUrl(port)))) {
      if (Date.now() >= deadline) {
        throw new DataTierError(
          `The Working Memory data tier container started but ${healthUrl(port)} is not healthy. Check "docker logs ${dataTierInstanceNames(port).container}".`,
          'unhealthy',
        );
      }
      await this.sleep(this.timeouts.poll);
    }
  }

  private async run(
    docker: string,
    env: NodeJS.ProcessEnv,
    args: string[],
    code: DataTierError['code'],
    message: string,
  ): Promise<string> {
    try {
      return (await this.runner.run(docker, args, { timeoutMs: this.timeouts.command, env })).stdout;
    } catch (error) {
      throw new DataTierError(`${message}\n${commandDetail(error)}`, code);
    }
  }

  private writeInstances(instances: ManagedDataTierInstance[]): void {
    mkdirSync(this.options.stateDirectory, { recursive: true });
    const sorted = [...instances].sort((left, right) => left.port - right.port);
    writeFileSync(
      join(this.options.stateDirectory, DATA_TIER_STATE_FILE),
      `${JSON.stringify({ instances: sorted }, null, 2)}\n`,
      { mode: 0o600 },
    );
  }

  private async dockerReady(docker: string, env: NodeJS.ProcessEnv): Promise<boolean> {
    try {
      await this.runner.run(docker, ['info', '--format', '{{json .ServerVersion}}'], { timeoutMs: this.timeouts.info, env });
      return true;
    } catch {
      return false;
    }
  }

  private async waitForDocker(docker: string, env: NodeJS.ProcessEnv): Promise<void> {
    if (await this.dockerReady(docker, env)) return;
    this.startDockerDesktop();
    const deadline = Date.now() + this.timeouts.dockerStart;
    while (Date.now() < deadline) {
      await this.sleep(this.timeouts.poll);
      if (await this.dockerReady(docker, env)) return;
    }
    throw new DataTierError(
      'Docker Desktop is installed but not running. Start Docker Desktop, wait until it reports that the engine is running, then retry.',
      'docker-unavailable',
    );
  }

  private startDockerDesktop(): void {
    if (this.host.platform === 'darwin') {
      this.launchDetached('/usr/bin/open', ['-g', '-a', 'Docker']);
      return;
    }
    if (this.host.platform === 'win32') {
      const programFiles = this.host.env.ProgramFiles || 'C:\\Program Files';
      const desktop = win32.join(programFiles, 'Docker', 'Docker', 'Docker Desktop.exe');
      if (this.fileExists(desktop)) this.launchDetached(desktop, []);
    }
  }

  /** Writes the instance's Compose file; macOS/Linux also create its bind-mounted data folder. */
  protected writeComposeFile(port: number): string {
    if (this.host.platform !== 'win32') mkdirSync(dataTierHostDirectory(this.host, port), { recursive: true });
    const directory = join(this.options.stateDirectory, 'instances', String(port));
    mkdirSync(directory, { recursive: true });
    const composeFile = join(directory, 'compose.yaml');
    // JSON is valid YAML and escapes Windows paths safely.
    writeFileSync(
      composeFile,
      `${JSON.stringify(dataTierCompose(this.host, this.options.buildContext, this.options.version, port), null, 2)}\n`,
      { mode: 0o600 },
    );
    return composeFile;
  }
}
