import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { createServer } from 'node:net';
import { homedir as systemHomedir } from 'node:os';
import { join } from 'node:path';
import { z } from 'zod';
import {
  DEFAULT_CONTROL_PLANE_SERVICE_PORT,
  resolveControlPlaneHome,
} from '../../../shared/controlPlaneShared';
import {
  CommandExecutionError,
  ExecFileCommandRunner,
  type CommandRunner,
} from './dockerContainerService';
import { parseBackendImage } from './updateChannels';
import { defaultFileExists, type DockerHost as DataTierHost } from './dockerCli';
import { ContainerProviderAdapter, type ContainerProvider } from './containerProvider';
import { checkContainerOwnership } from './containerOwnership';
import { summarizeContainerLogs, summarizeContainerStats } from './containerIncidentEvidence';
import type {
  BackendUpdateTarget,
  DataTierInstanceState,
  DataTierInstanceStatus,
  DataTierInstancesSnapshot,
  ManagedDataTierInstance,
} from '../shared/contracts';

export type { DataTierInstanceState, DataTierInstanceStatus, DataTierInstancesSnapshot, ManagedDataTierInstance };
export { dockerCliPath, dockerEnvironment } from './dockerCli';
export type { DockerHost as DataTierHost } from './dockerCli';

export const DATA_TIER_PROJECT = 'working-memory';
export const DATA_TIER_SERVICE = 'control-plane';
export const DATA_TIER_CONTAINER = 'working-memory-control-plane';
export const DATA_TIER_VOLUME = 'working-memory-data';

export interface DataTierOptions extends Partial<DataTierHost> {
  provider?: ContainerProvider;
  /** Directory containing the prebuilt control-plane image archive. */
  buildContext: string;
  /** Writable directory for instance state and generated Compose files. */
  stateDirectory: string;
  version: string;
  runner?: CommandRunner;
  dataExists?: (path: string) => boolean;
  healthy?: (url: string) => Promise<boolean>;
  sleep?: (ms: number) => Promise<void>;
  fileExists?: (path: string) => boolean;
  portAvailable?: (port: number) => Promise<boolean>;
  now?: () => Date;
  timeouts?: Partial<DataTierTimeouts>;
}

export interface DataTierTimeouts {
  info: number;
  composeUp: number;
  command: number;
  health: number;
  poll: number;
}

const DEFAULT_TIMEOUTS: DataTierTimeouts = {
  info: 15_000,
  composeUp: 15 * 60_000,
  command: 60_000,
  health: 120_000,
  poll: 2_000,
};

export class DataTierError extends Error {
  constructor(message: string, readonly code: 'docker-missing' | 'docker-unavailable' | 'start-failed' | 'unhealthy' | 'not-found' | 'not-running' | 'provider-conflict') {
    super(message);
    this.name = 'DataTierError';
  }
}

/** Ports for added instances; 7718 is reserved for the desktop link bridge. */
export const DATA_TIER_INSTANCE_PORT_FIRST = 7719;
export const DATA_TIER_INSTANCE_PORT_LAST = 7799;
export const DATA_TIER_STATE_FILE = 'instances.json';
const IMAGE_REPOSITORY = 'working-memory-control-plane';
const PENDING_INSTANCE_FILE = 'pending-instance.json';
const pendingInstanceSchema = z.object({
  instance: z.object({
    port: z.number().int().min(1).max(65535), name: z.string(), createdAt: z.string(),
    image: z.string().refine(image => isBundledImage(image) || !!parseBackendImage(image)),
    provider: z.enum(['docker', 'podman']), connection: z.string().min(1),
  }),
  storageReady: z.boolean(),
  databaseInitialized: z.boolean().optional(),
});
type PendingInstance = z.infer<typeof pendingInstanceSchema>;

/** Local tag of the image archive bundled with an installer build. */
export function bundledImage(version: string): string {
  return `${IMAGE_REPOSITORY}:${version}`;
}

function isBundledImage(image: string): boolean {
  return image.startsWith(`${IMAGE_REPOSITORY}:`);
}
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
 * provider-owned volume because WAL locking is unreliable on Windows bind mounts; macOS and
 * Linux use the host application-data directory so existing stores are reused.
 */
export function dataTierCompose(
  host: DataTierHost,
  /** A bundled-image version, or a fully qualified image reference. */
  versionOrImage: string,
  port = DEFAULT_CONTROL_PLANE_SERVICE_PORT,
): Record<string, unknown> {
  const image = versionOrImage.includes(':') ? versionOrImage : bundledImage(versionOrImage);
  const names = dataTierInstanceNames(port);
  const dataMount = host.platform === 'win32'
    ? { type: 'volume', source: names.volume, target: '/data' }
    : { type: 'bind', source: dataTierHostDirectory(host, port), target: '/data', bind: { create_host_path: false } };
  return {
    name: names.project,
    services: {
      [DATA_TIER_SERVICE]: {
        container_name: names.container,
        image,
        pull_policy: 'never',
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
    ...(host.platform === 'win32' ? { volumes: { [names.volume]: { name: names.volume, external: true } } } : {}),
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
      const image = typeof candidate.image === 'string'
        && (isBundledImage(candidate.image) || parseBackendImage(candidate.image))
        ? candidate.image
        : undefined;
      byPort.set(candidate.port, {
        port: candidate.port,
        name,
        createdAt: typeof candidate.createdAt === 'string' ? candidate.createdAt : '',
        ...(image ? { image } : {}),
        ...(candidate.provider === 'docker' || candidate.provider === 'podman' ? { provider: candidate.provider } : {}),
        ...(typeof candidate.connection === 'string' ? { connection: candidate.connection } : {}),
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
  if (isBundledImage(image)) return image.slice(IMAGE_REPOSITORY.length + 1) || null;
  return parseBackendImage(image)?.version ?? null;
}

function containerState(dockerState: string, status: string): DataTierInstanceState {
  if (dockerState !== 'running') return 'stopped';
  if (status.includes('(health: starting)') || status.includes('(starting)')) return 'starting';
  if (status.includes('(unhealthy)')) return 'unhealthy';
  return 'running';
}

function backupTimestamp(date: Date): string {
  const pad = (value: number) => String(value).padStart(2, '0');
  return `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}-${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`;
}

function fileId(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'instance';
}

/**
 * Creates and operates the local data-tier instances this desktop install manages.
 * Operations run one at a time so Compose never races itself over shared state.
 */
export class DataTierManager {
  private readonly provider: ContainerProviderAdapter;
  private readonly host: DataTierHost;
  private readonly runner: CommandRunner;
  private readonly healthy: (url: string) => Promise<boolean>;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly portAvailable: (port: number) => Promise<boolean>;
  private readonly now: () => Date;
  private readonly timeouts: DataTierTimeouts;
  private queue: Promise<unknown> = Promise.resolve();
  private bundledImageLoaded = false;

  constructor(private readonly options: DataTierOptions) {
    this.host = {
      platform: options.platform ?? process.platform,
      env: options.env ?? process.env,
      homedir: options.homedir ?? systemHomedir(),
    };
    this.provider = new ContainerProviderAdapter({
      provider: options.provider, host: this.host,
      runner: options.runner ?? new ExecFileCommandRunner(),
      fileExists: options.fileExists ?? defaultFileExists(this.host.platform),
    });
    this.runner = { run: (connection, args, runOptions) =>
      this.provider.run(connection, args, runOptions ?? { timeoutMs: this.timeouts.command }) };
    this.healthy = options.healthy ?? defaultHealthy;
    this.sleep = options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
    this.portAvailable = options.portAvailable ?? defaultPortAvailable;
    this.now = options.now ?? (() => new Date());
    this.timeouts = { ...DEFAULT_TIMEOUTS, ...options.timeouts };
  }

  get appVersion(): string {
    return this.options.version;
  }

  get instances(): ManagedDataTierInstance[] {
    try {
      const raw = readFileSync(join(this.options.stateDirectory, DATA_TIER_STATE_FILE), 'utf8');
      z.object({ instances: z.array(z.object({
        port: z.number().int().min(1).max(65535),
        provider: z.enum(['docker', 'podman']).optional(),
        connection: z.string().min(1).optional(),
        image: z.string().refine(image => isBundledImage(image) || !!parseBackendImage(image)).optional(),
      })).refine(instances => new Set(instances.map(instance => instance.port)).size === instances.length) }).parse(JSON.parse(raw));
      return parseManagedInstances(raw);
    } catch (error) {
      if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return [];
      throw new Error(`Managed instance registration is unreadable. Restore it before retrying; no replacement database will be created.\n${commandDetail(error)}`);
    }
  }

  async whenIdle(): Promise<void> {
    await this.queue;
  }

  /** The image bundled with this installer build. */
  get bundledTarget(): BackendUpdateTarget {
    return { version: this.options.version, image: bundledImage(this.options.version) };
  }

  async bootstrapCredential(port: number): Promise<string> {
    this.require(port);
    const { docker, env } = await this.docker();
    const instance = this.require(port), names = dataTierInstanceNames(port);
    await this.verifyInstanceContainer(docker, env, instance);
    const script = "const fs=require('node:fs'); const p=process.env.WM_HOST_TASK_ADMIN_TOKEN_FILE||'/data/run/instance-bootstrap.secret';"
      + "const fd=fs.openSync(p,fs.constants.O_RDONLY|fs.constants.O_NOFOLLOW|fs.constants.O_NONBLOCK);"
      + "try{const s=fs.fstatSync(fd);if(!s.isFile()||s.uid!==process.getuid()||(s.mode&63)!==0||s.size<32||s.size>4096)throw Error('Unsafe owner setup file');"
      + "process.stdout.write(fs.readFileSync(fd,'utf8').trim());}finally{fs.closeSync(fd);}";
    const result = await this.runner.run(docker, ['exec', names.container, 'node', '-e', script], {
      timeoutMs: this.timeouts.command, env,
    });
    const token = result.stdout.trim();
    if (!/^[A-Za-z0-9_-]{32,256}$/.test(token)) throw new Error('Owner setup is unavailable. Upgrade this managed instance and retry.');
    return token;
  }

  private async verifyInstanceContainer(
    docker: string,
    env: NodeJS.ProcessEnv,
    instance: ManagedDataTierInstance,
    legacy = false,
  ): Promise<string> {
    const { port } = instance, names = dataTierInstanceNames(port);
    const raw = await this.runner.run(docker, ['inspect', names.container], { timeoutMs: this.timeouts.command, env });
    const parsed = this.provider.inspect(raw.stdout, instance.image ?? (legacy ? undefined : this.bundledTarget.image));
    const portBindings = z.record(z.string(),
      z.array(z.object({ HostIp: z.string(), HostPort: z.string() })).nullable());
    const schema = z.array(z.object({
      Config: z.object({
        Image: z.string(),
        Labels: z.record(z.string(), z.string()),
      }),
      Mounts: z.array(z.object({
        Destination: z.string(), Source: z.string(),
        Type: z.string(), Name: z.string().optional(),
      })),
      State: z.object({ Running: z.boolean() }).optional(),
      HostConfig: z.object({ PortBindings: portBindings.nullish() }).optional(),
      NetworkSettings: z.object({ Ports: portBindings }),
    })).length(1);
    const [container] = schema.parse(parsed);
    const mount = container.Mounts.filter(mount => mount.Destination === '/data');
    const bindings = legacy && container.State?.Running === false
      ? container.HostConfig?.PortBindings : container.NetworkSettings.Ports;
    const binding = bindings?.[`${port}/tcp`];
    const expectedMount = this.host.platform === 'win32'
      ? mount[0]?.Type === 'volume' && mount[0]?.Name === names.volume
      : mount[0]?.Type === 'bind' && mount[0]?.Source === dataTierHostDirectory(this.host, port);
    if ((legacy && !instance.image
      ? imageVersion(container.Config.Image) === null
      : container.Config.Image !== (instance.image ?? this.bundledTarget.image))
      || container.Config.Labels['com.docker.compose.project'] !== names.project
      || container.Config.Labels['com.docker.compose.service'] !== DATA_TIER_SERVICE
      || mount.length !== 1 || !expectedMount || binding?.length !== 1
      || binding[0].HostIp !== '127.0.0.1' || binding[0].HostPort !== String(port)) {
      throw new Error('Owner setup refused: this container does not match the managed instance image, labels, data mount, and loopback port. Repair its registration before retrying.');
    }
    return container.Config.Image;
  }

  /**
   * Reports each managed instance's container state without starting Docker Desktop.
   * Instances whose version differs from `target` (default: the bundled image) need an update.
   */
  async list(target: BackendUpdateTarget = this.bundledTarget): Promise<Omit<DataTierInstancesSnapshot, 'backendChannel' | 'backendTarget' | 'backendTargetError'>> {
    const instances = this.instances;
    // Self-hosted servers come from environment discovery, which the manager does not own.
    const base = { appVersion: this.options.version, selfHosted: [] };
    let containers: Map<string, { state: string; status: string; image: string }>;
    const dependencyErrors: string[] = [];
    try {
      const { docker, env } = await this.docker(false);
      containers = await this.containers(docker, env);
      const unresolved = instances.map(instance => dataTierInstanceNames(instance.port).container)
        .filter(name => {
          const container = containers.get(name);
          return container && imageVersion(this.provider.imageReference(container.image)) === null;
        });
      if (unresolved.length) {
        try {
          const result = await this.runner.run(docker, ['inspect', ...unresolved], { timeoutMs: this.timeouts.info, env });
          const inspected = z.array(z.object({
            Name: z.string(), Config: z.object({ Image: z.string() }),
          })).parse(this.provider.inspect(result.stdout));
          for (const name of unresolved) {
            const container = inspected.find(container => container.Name.replace(/^\//, '') === name);
            if (!container) throw new Error(`Container image information is unavailable for ${name}. Retry to check for updates.`);
            containers.get(name)!.image = container.Config.Image;
          }
        } catch (error) {
          dependencyErrors.push(commandDetail(error));
        }
      }
      try {
        await this.provider.requireCompose(docker, { timeoutMs: this.timeouts.info, env });
      } catch (error) {
        dependencyErrors.push(commandDetail(error));
      }
    } catch (error) {
      return { ...base, dockerError: commandDetail(error), instances: instances.map((instance) => this.status(instance, target)) };
    }
    return {
      ...base,
      dockerError: dependencyErrors.length ? dependencyErrors.join('\n') : null,
      instances: instances.map((instance) => {
        const container = containers.get(dataTierInstanceNames(instance.port).container);
        return this.status(
          instance,
          target,
          container ? containerState(container.state, container.status) : 'missing',
          container ? imageVersion(this.provider.imageReference(container.image)) : null,
        );
      }),
    };
  }

  /** Sanitized crash and health evidence for a registered container. */
  async diagnosticState(port: number): Promise<{ startedAt: string; evidence: string }> {
    this.require(port);
    const { docker, env } = await this.docker(false);
    const result = await this.runner.run(docker, ['container', 'inspect',
      dataTierInstanceNames(port).container], { env, timeoutMs: 5000 });
    const schema = z.object({
      Image: z.string(), RestartCount: z.number().int(),
      Config: z.object({ Image: z.string() }),
      State: z.object({
        Status: z.string(), OOMKilled: z.boolean(), ExitCode: z.number().int(),
        StartedAt: z.string(), FinishedAt: z.string(),
        Health: z.object({
          Status: z.string(), FailingStreak: z.number().int(),
          Log: z.array(z.object({ Start: z.string(), End: z.string(), ExitCode: z.number().int() })).nullable(),
        }).nullish(),
      }),
    });
    const [value] = z.array(schema).length(1).parse(this.provider.inspect(result.stdout));
    return { startedAt: value.State.StartedAt,
      evidence: `${this.provider.label} image: ${value.Config.Image}; image ID: ${value.Image}; state: ${value.State.Status}; `
        + `OOM killed: ${value.State.OOMKilled}; exit code: ${value.State.ExitCode}; restart count: ${value.RestartCount}; `
        + `started: ${value.State.StartedAt}; finished: ${value.State.FinishedAt}; `
        + `health: ${value.State.Health?.Status ?? 'not configured'}; failing streak: ${value.State.Health?.FailingStreak ?? 0}.\n`
        + (value.State.Health?.Log ?? []).slice(-5).map(check =>
          `Health check ${check.Start} to ${check.End}: exit ${check.ExitCode}`).join('\n') };
  }

  async incidentEvidence(port: number, since: number, signal: AbortSignal): Promise<string> {
    this.require(port);
    const { docker, env } = await this.docker(false, signal);
    const container = dataTierInstanceNames(port).container;
    const capture = async (label: string, args: string[], summarize: (raw: string) => string, includeStderr = false) => {
      try {
        const result = await this.runner.run(docker, args, { env, signal, timeoutMs: 5000 });
        return summarize((includeStderr ? `${result.stdout}\n${result.stderr}` : result.stdout).trim());
      } catch (error) {
        console.error(`[instance-monitor] ${label} capture failed:`, error);
        return `${label} unavailable: container command failed, timed out, or returned invalid data. See desktop logs.`;
      }
    };
    const [logs, stats] = await Promise.all([
      capture('Container logs', ['logs', '--timestamps', '--since', new Date(since).toISOString(),
        '--tail', '200', container], summarizeContainerLogs, true),
      capture('Container resource sample', ['stats', '--no-stream', '--format', 'json', container], summarizeContainerStats),
    ]);
    return `${logs}\n\n${stats}`;
  }

  create(name?: string): Promise<ManagedDataTierInstance> {
    return this.serialize(async () => {
      const { docker, env } = await this.docker();
      await this.provider.requireCompose(docker, { timeoutMs: this.timeouts.info, env });
      const pending = this.pendingInstance();
      const port = pending?.instance.port ?? await this.choosePort(docker, env);
      const instance = pending?.instance ?? {
        port,
        name: name?.trim().slice(0, 80) || defaultInstanceName(port),
        createdAt: this.now().toISOString(),
        image: this.bundledTarget.image,
        provider: this.provider.provider,
        connection: this.provider.identity(docker),
      };
      if (pending && isBundledImage(instance.image) && instance.image !== this.bundledTarget.image) {
        instance.image = this.bundledTarget.image;
        this.writePendingInstance({ ...pending, instance });
      }
      await this.composeUp(docker, env, port, instance.image, instance);
      return instance;
    });
  }

  start(port: number): Promise<void> {
    return this.serialize(async () => {
      const instance = this.require(port);
      const { docker, env } = await this.docker();
      const container = (await this.containers(docker, env)).get(dataTierInstanceNames(port).container);
      if (!container) {
        await this.composeUp(docker, env, port, instance.image ?? this.bundledTarget.image);
        return;
      }
      if (container.state !== 'running') {
        await this.verifyInstanceStorage(docker, env, port);
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

  /**
   * Recreates the instance on `target` (default: the bundled image) and keeps its data.
   * A target matching the bundled version uses the local archive instead of pulling.
   */
  upgrade(port: number, target: BackendUpdateTarget = this.bundledTarget): Promise<void> {
    return this.serialize(async () => {
      this.require(port);
      const image = target.version === this.options.version ? this.bundledTarget.image : target.image;
      const { docker, env } = await this.docker();
      await this.composeUp(docker, env, port, image);
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

  /** Copies a consistent snapshot created by the running backend into the destination folder. */
  backup(port: number, destinationDirectory: string, createSnapshot: (id: string) => Promise<void>): Promise<string> {
    return this.serialize(async () => {
      const instance = this.require(port);
      const { docker, env } = await this.docker();
      const container = dataTierInstanceNames(port).container;
      const running = (await this.containers(docker, env)).get(container)?.state === 'running';
      if (!running) throw new DataTierError('Start the instance before backing it up.', 'not-running');
      const fileName = `working-memory-${fileId(instance.name)}-${backupTimestamp(this.now())}.sqlite`;
      const id = randomUUID();
      const snapshot = `/tmp/working-memory-${id}.sqlite`;
      const destination = join(destinationDirectory, fileName);
      let snapshotReady = false;
      try {
        await createSnapshot(id);
        snapshotReady = true;
        await this.run(docker, env, ['cp', `${container}:${snapshot}`, destination], 'start-failed', 'Unable to copy the database backup.');
      } finally {
        if (snapshotReady) {
          await this.runner.run(docker, ['exec', container, 'rm', '-f', snapshot], { timeoutMs: this.timeouts.command, env }).catch(() => undefined);
        }
      }
      return destination;
    });
  }

  /**
   * Used at launch when no healthy Working Memory is reachable: starts the preferred
   * managed instance, or creates the default one on a fresh install.
   */
  async ensureAvailable(preferredPort?: number): Promise<string> {
    this.assertProviderRegistrations();
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
    target: BackendUpdateTarget,
    state: DataTierInstanceState = 'unknown',
    version: string | null = null,
  ): DataTierInstanceStatus {
    return {
      ...instance,
      mcpUrl: mcpUrl(instance.port),
      container: dataTierInstanceNames(instance.port).container,
      state,
      version,
      updateAvailable: version !== null && version !== target.version,
    };
  }

  private require(port: number): ManagedDataTierInstance {
    const instance = this.instances.find((candidate) => candidate.port === port);
    if (!instance) throw new DataTierError('That Working Memory instance is not managed by this app.', 'not-found');
    return instance;
  }

  private async docker(adoptLegacy = true, signal?: AbortSignal): Promise<{ docker: string; env: NodeJS.ProcessEnv }> {
    this.assertProviderRegistrations();
    try {
      const docker = await this.provider.resolve(signal);
      this.ownership(docker);
      const instances = this.instances;
      const connection = this.provider.identity(docker);
      const pending = this.pendingInstance();
      if ([...instances, ...(pending ? [pending.instance] : [])]
        .some(instance => instance.connection && instance.connection !== connection)) {
        throw new DataTierError('The selected connection differs from the engine that owns these instances. Restore the original local connection; data will not be replaced or migrated.', 'provider-conflict');
      }
      if (adoptLegacy && instances.length) {
        const adopted: ManagedDataTierInstance[] = [];
        for (const instance of instances) {
          if (instance.connection && instance.provider) {
            adopted.push(instance);
            continue;
          }
          try {
            const image = await this.verifyInstanceContainer(docker, this.host.env, instance, true);
            if (this.host.platform === 'win32') {
              await this.run(docker, this.host.env, ['volume', 'inspect', dataTierInstanceNames(instance.port).volume],
                'provider-conflict', 'The legacy instance data volume is unavailable.');
            } else if (!(this.options.dataExists ?? existsSync)(join(dataTierHostDirectory(this.host, instance.port), 'journal.sqlite'))) {
              throw new Error('The legacy instance database is unavailable.');
            }
            adopted.push({ ...instance, image, provider: this.provider.provider, connection });
          } catch (error) {
            throw new DataTierError(`Legacy instance ownership could not be verified. Restore its original container and storage, then Retry; ownership was not changed.\n${commandDetail(error)}`, 'provider-conflict');
          }
        }
        this.ownership(docker, true);
        if (instances.some(instance => !instance.connection || !instance.provider)) {
          this.writeInstances(adopted);
        }
      }
      return { docker, env: this.host.env };
    } catch (error) {
      if (error instanceof DataTierError) throw error;
      const missing = error instanceof Error && 'code' in error && error.code === 'ENOENT';
      throw new DataTierError(`${this.provider.label} is ${missing ? 'not installed' : 'unavailable'}. Start the selected provider and ensure Compose is installed, then Retry.\n${commandDetail(error)}`, missing ? 'docker-missing' : 'docker-unavailable');
    }
  }

  private assertProviderRegistrations(): void {
    const pending = this.pendingInstance();
    if ([...this.instances, ...(pending ? [pending.instance] : [])]
      .some(instance => (instance.provider ?? 'docker') !== this.provider.provider)) {
      throw new DataTierError('Existing instances belong to another container provider. Select their original provider to manage them. Changing providers does not migrate data or create replacement databases.', 'provider-conflict');
    }
  }

  private ownership(connection: string, reserve = false): void {
    checkContainerOwnership(join(this.options.stateDirectory, 'ownership'), 'data-tier', {
      provider: this.provider.provider, connection: this.provider.identity(connection),
    }, reserve);
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
    const volumes = this.host.platform === 'win32'
      ? new Set((await this.run(docker, env, ['volume', 'ls', '--format', '{{.Name}}'],
        'start-failed', 'Unable to check existing data volumes.')).trim().split(/\r?\n/))
      : new Set<string>();
    const candidates = [DEFAULT_CONTROL_PLANE_SERVICE_PORT];
    for (let port = DATA_TIER_INSTANCE_PORT_FIRST; port <= DATA_TIER_INSTANCE_PORT_LAST; port += 1) candidates.push(port);
    for (const port of candidates) {
      const names = dataTierInstanceNames(port);
      if (managed.has(port) || containers.has(names.container) || volumes.has(names.volume)) continue;
      if (this.host.platform !== 'win32'
        && (this.options.dataExists ?? existsSync)(join(dataTierHostDirectory(this.host, port), 'journal.sqlite'))) continue;
      if (await this.portAvailable(port)) return port;
    }
    throw new DataTierError(
      `No free port is available for a new Working Memory instance between ${DATA_TIER_INSTANCE_PORT_FIRST} and ${DATA_TIER_INSTANCE_PORT_LAST}.`,
      'start-failed',
    );
  }

  private async verifyInstanceStorage(docker: string, env: NodeJS.ProcessEnv, port: number, databaseInitialized = true): Promise<void> {
    if (this.host.platform === 'win32') {
      await this.run(docker, env, ['volume', 'inspect', dataTierInstanceNames(port).volume],
        'provider-conflict', 'The existing data volume is unavailable. Refusing to create an empty replacement database.');
    } else {
      const directory = dataTierHostDirectory(this.host, port);
      if (!(this.options.dataExists ?? existsSync)(databaseInitialized ? join(directory, 'journal.sqlite') : directory)) {
        throw new DataTierError('The existing database is unavailable. Restore its original data directory before retrying; no empty replacement will be created.', 'provider-conflict');
      }
    }
  }

  private async composeUp(docker: string, env: NodeJS.ProcessEnv, port: number, image: string, registration?: ManagedDataTierInstance): Promise<void> {
    await this.provider.requireCompose(docker, { timeoutMs: this.timeouts.info, env });
    this.ownership(docker, true);
    const existing = this.instances.find(instance => instance.port === port);
    let pending = this.pendingInstance();
    if (registration && !pending) {
      pending = pendingInstanceSchema.parse({ instance: registration, storageReady: false, databaseInitialized: false });
      this.writePendingInstance(pending);
    }
    const database = join(dataTierHostDirectory(this.host, port), 'journal.sqlite');
    const dataExists = this.options.dataExists ?? existsSync;
    if (this.host.platform !== 'win32' && pending?.instance.port === port
      && !pending.databaseInitialized && dataExists(database)) {
      pending.databaseInitialized = true;
      this.writePendingInstance(pending);
    }
    if (existing || pending?.storageReady) {
      await this.verifyInstanceStorage(docker, env, port, !!existing || !!pending?.databaseInitialized);
    } else if (this.host.platform === 'win32') {
      await this.run(docker, env, ['volume', 'create', dataTierInstanceNames(port).volume],
        'start-failed', 'Unable to create the new instance data volume.');
      if (pending) {
        pending.storageReady = true;
        this.writePendingInstance(pending);
      }
    } else {
      mkdirSync(dataTierHostDirectory(this.host, port), { recursive: true });
      if (pending) {
        pending.storageReady = true;
        this.writePendingInstance(pending);
      }
    }
    if (isBundledImage(image)) {
      if (!this.bundledImageLoaded) {
        try {
          await this.runner.run(docker, ['load', '--input', join(this.options.buildContext, 'image.tar')], {
            timeoutMs: this.timeouts.composeUp,
            env,
          });
          this.bundledImageLoaded = true;
        } catch (error) {
          throw new DataTierError(`Unable to load the bundled Working Memory backend image.\n${commandDetail(error)}`, 'start-failed');
        }
      }
    } else {
      try {
        await this.runner.run(docker, ['pull', image], { timeoutMs: this.timeouts.composeUp, env });
      } catch (error) {
        throw new DataTierError(`Unable to download the Working Memory backend image ${image}.\n${commandDetail(error)}`, 'start-failed');
      }
    }
    const composeFile = this.writeComposeFile(port, image);
    try {
      await this.provider.composeUp(docker, composeFile, { timeoutMs: this.timeouts.composeUp, env });
    } catch (error) {
      throw new DataTierError(`Unable to start the Working Memory data tier with ${this.provider.label} Compose.\n${commandDetail(error)}`, 'start-failed');
    } finally {
      if (this.host.platform !== 'win32' && pending?.instance.port === port
        && !pending.databaseInitialized && dataExists(database)) {
        pending.databaseInitialized = true;
        this.writePendingInstance(pending);
      }
    }
    // Persist the deployed image before health polling so an unhealthy upgrade
    // cannot revert to the installer image after the desktop restarts.
    const instances = this.instances;
    const deployed = registration ?? instances.find(instance => instance.port === port);
    if (deployed) {
      deployed.image = image;
      this.writeInstances([...instances.filter(instance => instance.port !== port), deployed]);
      if (pending?.instance.port === port) unlinkSync(join(this.options.stateDirectory, PENDING_INSTANCE_FILE));
    }
    await this.waitHealthy(port);
  }

  private async waitHealthy(port: number): Promise<void> {
    const deadline = Date.now() + this.timeouts.health;
    while (!(await this.healthy(healthUrl(port)))) {
      if (Date.now() >= deadline) {
        throw new DataTierError(
          `The Working Memory data tier container started but ${healthUrl(port)} is not healthy. Check "${this.provider.provider} logs ${dataTierInstanceNames(port).container}".`,
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

  private pendingInstance(): PendingInstance | undefined {
    try {
      return pendingInstanceSchema.parse(JSON.parse(readFileSync(join(this.options.stateDirectory, PENDING_INSTANCE_FILE), 'utf8')));
    } catch (error) {
      if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return undefined;
      throw new Error(`Pending instance registration is unreadable. Restore it before retrying; no replacement storage will be created.\n${commandDetail(error)}`);
    }
  }

  private writePendingInstance(pending: PendingInstance): void {
    mkdirSync(this.options.stateDirectory, { recursive: true });
    writeFileSync(join(this.options.stateDirectory, PENDING_INSTANCE_FILE), `${JSON.stringify(pending)}\n`, { mode: 0o600 });
  }

  /** Writes the instance's Compose file after its storage has been prepared. */
  protected writeComposeFile(port: number, image: string): string {
    const directory = join(this.options.stateDirectory, 'instances', String(port));
    mkdirSync(directory, { recursive: true });
    const composeFile = join(directory, 'compose.yaml');
    // JSON is valid YAML and escapes Windows paths safely.
    writeFileSync(
      composeFile,
      `${JSON.stringify(dataTierCompose(this.host, image, port), null, 2)}\n`,
      { mode: 0o600 },
    );
    return composeFile;
  }
}
