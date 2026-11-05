import { execFile } from 'node:child_process';
import { homedir } from 'node:os';
import { dockerCliPath, dockerEnvironment } from './dockerCli';
import { ContainerProviderAdapter, type ContainerProvider } from './containerProvider';
import { checkContainerOwnership } from './containerOwnership';
import type {
  ContainerClaim,
  ContainerClaimCreateInput,
  ContainerClaimUpdateInput,
  DockerRuntimeSpec,
} from '../../../shared/controlPlaneClient';
import type { ContainerAppStatus, ContainerStopResult } from '../shared/contracts';

export const MANAGED_LABEL = 'com.kubarycz.working-memory.managed';
export const CLAIM_LABEL = 'com.kubarycz.working-memory.claim';

export interface CommandResult {
  stdout: string;
  stderr: string;
}

export interface CommandRunner {
  run(file: string, args: string[], options?: CommandRunOptions): Promise<CommandResult>;
}

export interface CommandRunOptions {
  timeoutMs: number;
  signal?: AbortSignal;
  env?: NodeJS.ProcessEnv;
}

export interface ClaimClient {
  containerClaimRead(input?: { id?: string }): Promise<ContainerClaim[]>;
  containerClaimCreate(input: ContainerClaimCreateInput): Promise<ContainerClaim>;
  containerClaimUpdate(input: ContainerClaimUpdateInput): Promise<ContainerClaim>;
}

export type ContainerLaunchResult =
  | { status: 'ready'; url: string; claim: ContainerClaim; action: 'created' | 'started' | 'recreated' | 'reused' }
  | { status: 'error'; code: DockerErrorCode; message: string };

export type DockerErrorCode =
  | 'docker_missing'
  | 'docker_unavailable'
  | 'docker_timeout'
  | 'source_not_found'
  | 'claim_error'
  | 'container_conflict'
  | 'build_failed'
  | 'start_failed'
  | 'readiness_timeout';

export interface DockerContainerServiceOptions {
  provider?: ContainerProvider;
  stateDirectory?: string;
  runner?: CommandRunner;
  readiness?: (url: string) => Promise<boolean>;
  retries?: number;
  retryDelayMs?: number;
  dockerContext?: string;
  env?: NodeJS.ProcessEnv;
  confirmStorageCreation?: (claim: ContainerClaim, provider: ContainerProvider) => Promise<boolean>;
  timeouts?: Partial<DockerOperationTimeouts>;
}

export interface DockerOperationTimeouts {
  context: number;
  info: number;
  build: number;
  inspect: number;
  start: number;
  stop: number;
  remove: number;
}

const DEFAULT_TIMEOUTS: DockerOperationTimeouts = {
  context: 5_000,
  info: 10_000,
  build: 5 * 60_000,
  inspect: 15_000,
  start: 30_000,
  stop: 30_000,
  remove: 30_000,
};

interface DockerInspect {
  Image?: string;
  State?: { Running?: boolean; Health?: { Status?: string } };
  Config?: { Image?: string; Labels?: Record<string, string> | null };
  HostConfig?: {
    PortBindings?: Record<string, Array<{ HostIp?: string; HostPort?: string }> | null>;
  };
  Mounts?: Array<{ Type?: string; Name?: string; Destination?: string }>;
}

export class CommandExecutionError extends Error {
  constructor(
    message: string,
    readonly code?: string | number,
    readonly stderr = '',
  ) {
    super(message);
  }
}

export class CommandTimeoutError extends CommandExecutionError {
  constructor(readonly timeoutMs: number) {
    super(`Container command timed out after ${timeoutMs}ms.`, 'ETIMEDOUT');
  }
}

export class ExecFileCommandRunner implements CommandRunner {
  run(file: string, args: string[], options: CommandRunOptions): Promise<CommandResult> {
    return new Promise((resolve, reject) => {
      if (['docker', 'docker.exe', 'podman', 'podman.exe'].includes(file)) {
        const provider = file.startsWith('podman') ? 'podman' : 'docker';
        const host = { platform: process.platform, env: options.env ?? process.env, homedir: homedir() };
        const executable = dockerCliPath(host, undefined, provider);
        if (!executable) {
          reject(new CommandExecutionError(`${provider} CLI was not found. Install the selected provider and enable its command-line tools, then Retry.`, 'ENOENT'));
          return;
        }
        file = executable;
        options = { ...options, env: dockerEnvironment(host, executable, provider) };
      }
      execFile(file, args, {
        encoding: 'utf8',
        maxBuffer: 10 * 1024 * 1024,
        timeout: options.timeoutMs,
        signal: options.signal,
        ...(options.env ? { env: options.env } : {}),
      }, (error, stdout, stderr) => {
        if (error) {
          if ((error as NodeJS.ErrnoException & { killed?: boolean }).killed
            || (error as NodeJS.ErrnoException).code === 'ABORT_ERR') {
            reject(new CommandTimeoutError(options.timeoutMs));
            return;
          }
          const code = (error as NodeJS.ErrnoException & { code?: string | number }).code;
          reject(new CommandExecutionError(error.message, code, stderr));
          return;
        }
        resolve({ stdout, stderr });
      });
    });
  }
}

export class DockerContainerService {
  private readonly provider: ContainerProviderAdapter;
  private readonly runner: CommandRunner;
  private readonly readiness: (url: string) => Promise<boolean>;
  private readonly retries: number;
  private readonly retryDelayMs: number;
  private readonly configuredContext?: string;
  private readonly env: NodeJS.ProcessEnv;
  private readonly timeouts: DockerOperationTimeouts;

  constructor(private readonly options: DockerContainerServiceOptions = {}) {
    this.runner = options.runner ?? new ExecFileCommandRunner();
    this.readiness = options.readiness ?? defaultReadiness;
    this.retries = options.retries ?? 30;
    this.retryDelayMs = options.retryDelayMs ?? 500;
    this.configuredContext = options.dockerContext;
    this.env = options.env ?? process.env;
    this.timeouts = { ...DEFAULT_TIMEOUTS, ...options.timeouts };
    this.provider = new ContainerProviderAdapter({
      provider: options.provider, runner: this.runner,
      host: { platform: process.platform, homedir: homedir(), env: this.env },
      dockerContext: this.configuredContext,
    });
  }

  async ensure(
    claimClient: ClaimClient,
    desired: ContainerClaimCreateInput & { id?: string },
    signal?: AbortSignal,
  ): Promise<ContainerLaunchResult> {
    let claim: ContainerClaim;
    let newlyCreated = false;
    try {
      const existing = desired.id
        ? (await claimClient.containerClaimRead({ id: desired.id }))[0]
        : desired.application
          ? (await claimClient.containerClaimRead()).find(
            (candidate) => candidate.application?.id === desired.application?.id,
          )
          : undefined;
      const { id: _id, ...createInput } = desired;
      newlyCreated = !existing;
      claim = existing
        ? await this.updateClaimIfNeeded(claimClient, existing, desired)
        : await claimClient.containerClaimCreate(createInput);
    } catch (error) {
      return failure('claim_error', `Unable to ensure the ${desired.title} ContainerClaim.`, error);
    }

    return this.launchClaim(claim, signal, newlyCreated);
  }

  async launch(claim: ContainerClaim, signal?: AbortSignal): Promise<ContainerLaunchResult> {
    return this.launchClaim(claim, signal);
  }

  private async launchClaim(claim: ContainerClaim, signal?: AbortSignal, newlyCreated = false): Promise<ContainerLaunchResult> {
    if (!claim.runtime || claim.runtime.type !== 'docker') {
      return { status: 'error', code: 'claim_error', message: 'ContainerClaim has no container runtime specification.' };
    }

    const runtime = claim.runtime;
    try {
      runtimePorts(runtime);
    } catch (error) {
      return failure('claim_error', 'ContainerClaim has invalid published ports.', error);
    }
    let context: string;
    try {
      context = await this.resolveDockerContext(signal);
      const owned = this.ownership(context, claim.id);
      if (this.options.stateDirectory && runtime.volumes?.length && !owned
        && !newlyCreated && this.provider.provider !== 'docker' && !this.options.confirmStorageCreation) {
        throw new Error('Stateful Container App ownership is unverified. Legacy apps belong to Docker; restore their original provider instead of creating replacement volumes.');
      }
      if (newlyCreated && this.options.stateDirectory) {
        this.reserveStorage(context, claim);
      }
    } catch (error) {
      const missing = error instanceof CommandExecutionError && error.code === 'ENOENT';
      return failure(
        missing ? 'docker_missing' : 'docker_unavailable',
        missing ? `${this.provider.label} CLI is not installed or is not on PATH.` : `No safe local ${this.provider.label} connection is available. Start the selected provider, then Retry.`,
        error,
      );
    }

    try {
      await this.docker(context, [
        'build', '--label', `${MANAGED_LABEL}=true`, '--label', `${CLAIM_LABEL}=${claim.id}`,
        '-t', runtime.imageName, '-f', runtime.dockerfile, runtime.buildContext,
      ], this.timeouts.build, signal);
    } catch (error) {
      return failure('build_failed', `${this.provider.label} image build failed.`, error);
    }

    let imageId: string;
    try {
      imageId = (await this.docker(context, [
        'image', 'inspect', '--format', '{{.Id}}', runtime.imageName,
      ], this.timeouts.inspect, signal)).stdout.trim();
      if (!imageId) throw new Error('Docker returned an empty image id.');
    } catch (error) {
      return failure('build_failed', `Built ${this.provider.label} image could not be inspected.`, error);
    }

    let current: DockerInspect | null = null;
    try {
      const result = await this.docker(
        context,
        ['container', 'inspect', runtime.containerName],
        this.timeouts.inspect,
        signal,
      );
      const parsed = this.provider.inspect(result.stdout, runtime.imageName) as DockerInspect[];
      current = parsed[0] ?? null;
    } catch (error) {
      if (!isMissingContainer(error)) {
        return failure('start_failed', 'Existing container could not be inspected.', error);
      }
    }

    try {
      if (this.options.stateDirectory && runtime.volumes?.length && !current
        && !newlyCreated && !this.ownership(context, claim.id) && this.options.confirmStorageCreation) {
        await this.verifyNewStorage(context, runtime, signal);
        if (!await this.options.confirmStorageCreation(claim, this.provider.provider)) {
          throw new Error('New storage initialization was cancelled. No data volumes were created.');
        }
        signal?.throwIfAborted();
        await this.verifyNewStorage(context, runtime, signal);
        this.reserveStorage(context, claim);
        newlyCreated = true;
      }
      await this.prepareOwnership(context, runtime, claim.id, current, newlyCreated, signal);
    } catch (error) {
      return failure('container_conflict', 'Container App data ownership could not be verified.', error);
    }

    let action: 'created' | 'started' | 'recreated' | 'reused';
    const matches = current ? containerMatches(current, claim.id, runtime, imageId) : false;
    if (current && !matches) {
      if (current.Config?.Labels?.[MANAGED_LABEL] !== 'true'
        || current.Config?.Labels?.[CLAIM_LABEL] !== claim.id) {
        return {
          status: 'error',
          code: 'container_conflict',
          message: `Container "${runtime.containerName}" exists but is not managed by this claim.`,
        };
      }
      try {
        await this.docker(
          context,
          ['container', 'rm', '--force', runtime.containerName],
          this.timeouts.remove,
          signal,
        );
        await this.runContainer(context, runtime, claim.id, signal);
        action = 'recreated';
      } catch (error) {
        return failure('start_failed', 'Managed container could not be recreated.', error);
      }
    } else if (!current) {
      try {
        await this.runContainer(context, runtime, claim.id, signal);
        action = 'created';
      } catch (error) {
        return failure('start_failed', 'Container could not be started.', error);
      }
    } else if (!current.State?.Running) {
      try {
        await this.docker(
          context,
          ['container', 'start', runtime.containerName],
          this.timeouts.start,
          signal,
        );
        action = 'started';
      } catch (error) {
        return failure('start_failed', 'Existing managed container could not be started.', error);
      }
    } else {
      action = 'reused';
    }

    const url = `http://localhost:${runtime.hostPort}${runtime.entryPath}`;
    const healthUrl = `http://localhost:${runtime.hostPort}${runtime.healthPath}`;
    for (let attempt = 0; attempt < this.retries; attempt += 1) {
      try {
        if (await this.readiness(healthUrl)) return { status: 'ready', url, claim, action };
      } catch {
        // A connection error is expected while nginx starts; retry within the fixed bound.
      }
      if (attempt + 1 < this.retries) await delay(this.retryDelayMs);
    }
    return {
      status: 'error',
      code: 'readiness_timeout',
      message: `Container did not become ready at ${healthUrl} after ${this.retries} attempts.`,
    };
  }

  async inspect(desired: ContainerClaimCreateInput & { id: string }, signal?: AbortSignal): Promise<ContainerAppStatus> {
    const runtime = desired.runtime;
    if (!runtime || runtime.type !== 'docker') return appStatus(desired, null, 'error', false, 'Status failed', 'ContainerClaim has no container runtime specification.');
    try {
      runtimePorts(runtime);
    } catch (error) {
      return appStatus(desired, null, 'error', false, 'Status failed', error instanceof Error ? error.message : String(error));
    }
    let context: string;
    try {
      context = await this.resolveDockerContext(signal);
      this.ownership(context, desired.id);
    } catch (error) {
      return appStatus(desired, null, 'error', false, 'Status failed', errorDetail(error));
    }
    let current: DockerInspect;
    try {
      const result = await this.docker(context, ['container', 'inspect', runtime.containerName], this.timeouts.inspect, signal);
      current = (this.provider.inspect(result.stdout, runtime.imageName) as DockerInspect[])[0] ?? {};
    } catch (error) {
      if (isMissingContainer(error)) return appStatus(desired, context, 'missing', false, 'Status refreshed', null);
      return appStatus(desired, context, 'error', false, 'Status failed', errorDetail(error));
    }
    if (!containerOwnedByClaim(current, desired.id, runtime)) {
      return appStatus(desired, context, 'error', false, 'Status refused', `Container "${runtime.containerName}" is not the exact managed container for this claim.`);
    }
    try {
      await this.prepareOwnership(context, runtime, desired.id, current, false, signal);
    } catch (error) {
      return appStatus(desired, context, 'error', false, 'Status refused', errorDetail(error));
    }
    if (!current.State?.Running) return appStatus(desired, context, 'stopped', false, 'Status refreshed', null);
    const health = current.State.Health?.Status;
    let ready = false;
    try {
      ready = health === 'healthy' || (health !== 'unhealthy' && await this.readiness(appHealthUrl(runtime)));
    } catch {
      ready = false;
    }
    return appStatus(desired, context, ready ? 'healthy' : 'unhealthy', ready, 'Status refreshed', ready ? null : 'The managed container is running but its health endpoint is not ready.');
  }

  async stop(desired: ContainerClaimCreateInput & { id: string }, signal?: AbortSignal): Promise<ContainerStopResult> {
    const status = await this.inspect(desired, signal);
    if (status.state === 'missing') return { status: 'missing', message: 'Managed container is missing.', detail: status };
    if (status.state === 'stopped') return { status: 'already_stopped', message: 'Managed container is already stopped.', detail: status };
    if (status.state !== 'healthy' && status.state !== 'unhealthy') {
      return { status: 'error', message: status.error ?? 'Refusing to stop a container that is not running and owned by this claim.', detail: status };
    }
    try {
      await this.docker(status.dockerContext!, ['container', 'stop', desired.runtime!.containerName], this.timeouts.stop, signal);
      return {
        status: 'stopped',
        message: 'Managed container stopped.',
        detail: appStatus(desired, status.dockerContext, 'stopped', false, 'Stopped', null),
      };
    } catch (error) {
      return {
        status: 'error',
        message: `Managed container could not be stopped. ${errorDetail(error)}`,
        detail: appStatus(desired, status.dockerContext, 'error', false, 'Stop failed', errorDetail(error)),
      };
    }
  }

  private async updateClaimIfNeeded(
    client: ClaimClient,
    existing: ContainerClaim,
    desired: ContainerClaimCreateInput,
  ): Promise<ContainerClaim> {
    if (
      existing.title === desired.title
      && existing.repository === desired.repository
      && JSON.stringify(existing.runtime) === JSON.stringify(desired.runtime)
      && JSON.stringify(existing.mcp) === JSON.stringify(desired.mcp)
      && JSON.stringify(existing.application) === JSON.stringify(desired.application)
    ) return existing;
    return client.containerClaimUpdate({
      id: existing.id,
      title: desired.title,
      repository: desired.repository,
      runtime: desired.runtime,
      mcp: desired.mcp ?? null,
      application: desired.application ?? null,
    });
  }

  private async runContainer(
    context: string,
    runtime: DockerRuntimeSpec,
    id: string,
    signal?: AbortSignal,
  ): Promise<void> {
    validateVolumes(runtime.volumes);
    for (const volume of runtime.volumes ?? []) {
      if (this.options.stateDirectory) {
        const owner = { provider: this.provider.provider, connection: this.provider.identity(context) };
        const resource = `volume:${volume.name}`;
        const exists = checkContainerOwnership(this.options.stateDirectory, resource, owner);
        if (!exists) throw new Error(`Storage ownership for volume "${volume.name}" has not been verified.`);
        await this.docker(context, ['volume', 'inspect', volume.name], this.timeouts.inspect, signal);
      }
    }
    const volumeArgs = (runtime.volumes ?? []).flatMap((volume) => [
      '--mount', `type=volume,source=${volume.name},destination=${volume.mountPath}`,
    ]);
    await this.docker(context, [
      'container', 'run', '--detach', '--name', runtime.containerName,
      '--label', `${MANAGED_LABEL}=true`, '--label', `${CLAIM_LABEL}=${id}`,
      ...runtimePorts(runtime).flatMap((port) => [
        '--publish', `${port.hostIp}:${port.hostPort}:${port.containerPort}${port.protocol === 'udp' ? '/udp' : ''}`,
      ]),
      ...volumeArgs,
      runtime.imageName,
    ], this.timeouts.start, signal);
  }

  private async prepareOwnership(
    context: string,
    runtime: DockerRuntimeSpec,
    id: string,
    current: DockerInspect | null,
    newlyCreated: boolean,
    signal?: AbortSignal,
  ): Promise<void> {
    const directory = this.options.stateDirectory;
    if (!directory) return;
    validateVolumes(runtime.volumes);
    const owner = { provider: this.provider.provider, connection: this.provider.identity(context) };
    const owned = this.ownership(context, id);
    const verified = current !== null && containerOwnedByClaim(current, id, runtime);
    if (runtime.volumes?.length && !owned && !newlyCreated
      && (this.provider.provider !== 'docker' || !verified)) {
      throw new Error('Stateful Container App ownership is unverified. Restore the original Docker container and data volumes before adopting this legacy claim.');
    }
    for (const volume of runtime.volumes ?? []) {
      const resource = `volume:${volume.name}`;
      const recorded = checkContainerOwnership(directory, resource, owner);
      const provisioning = checkContainerOwnership(directory, `pending-volume:${id}:${volume.name}`, owner);
      if (!recorded && !verified && !provisioning) {
        throw new Error(`Existing storage for "${volume.name}" is unverified. Refusing to create an empty replacement volume.`);
      }
      if (!recorded && provisioning) {
        await this.docker(context, ['volume', 'create', volume.name], this.timeouts.start, signal);
      } else {
        await this.docker(context, ['volume', 'inspect', volume.name], this.timeouts.inspect, signal);
      }
      checkContainerOwnership(directory, resource, owner, true);
    }
    this.ownership(context, id, true);
  }

  private reserveStorage(context: string, claim: ContainerClaim): void {
    const directory = this.options.stateDirectory;
    if (!directory) return;
    validateVolumes(claim.runtime?.volumes);
    const owner = { provider: this.provider.provider, connection: this.provider.identity(context) };
    for (const volume of claim.runtime?.volumes ?? []) {
      checkContainerOwnership(directory, `pending-volume:${claim.id}:${volume.name}`, owner, true);
    }
    this.ownership(context, claim.id, true);
  }

  private async verifyNewStorage(context: string, runtime: DockerRuntimeSpec, signal?: AbortSignal): Promise<void> {
    validateVolumes(runtime.volumes);
    for (const volume of runtime.volumes ?? []) {
      if (this.options.stateDirectory && checkContainerOwnership(this.options.stateDirectory, `volume:${volume.name}`, {
        provider: this.provider.provider, connection: this.provider.identity(context),
      })) {
        throw new Error(`Storage ownership for "${volume.name}" is already recorded. Restore its original container and volume instead of initializing new storage.`);
      }
      try {
        await this.docker(context, ['volume', 'inspect', volume.name], this.timeouts.inspect, signal);
      } catch (error) {
        if (error instanceof CommandExecutionError && error.code !== 'ENOENT'
          && /no such (volume|object)|volume .* not found/i.test(error.stderr || error.message)) continue;
        throw error;
      }
      throw new Error(`Volume "${volume.name}" already exists without verified ownership. Restore its original managed container instead of initializing new storage.`);
    }
  }

  private docker(
    context: string,
    args: string[],
    timeoutMs: number,
    signal?: AbortSignal,
  ): Promise<CommandResult> {
    return this.provider.run(context, args, { timeoutMs, signal });
  }

  private async resolveDockerContext(signal?: AbortSignal): Promise<string> {
    return this.provider.resolve(signal);
  }

  private ownership(connection: string, claim: string, reserve = false): boolean {
    if (!this.options.stateDirectory) return false;
    return checkContainerOwnership(this.options.stateDirectory, claim, {
      provider: this.provider.provider, connection: this.provider.identity(connection),
    }, reserve);
  }
}

function containerMatches(
  inspect: DockerInspect,
  id: string,
  runtime: DockerRuntimeSpec,
  imageId: string,
): boolean {
  return inspect.Image?.replace(/^sha256:/, '') === imageId.replace(/^sha256:/, '')
    && inspect.Config?.Image === runtime.imageName
    && inspect.Config?.Labels?.[MANAGED_LABEL] === 'true'
    && inspect.Config?.Labels?.[CLAIM_LABEL] === id
    && portsMatch(inspect, runtime)
    && volumesMatch(inspect, runtime);
}

function containerOwnedByClaim(inspect: DockerInspect, id: string, runtime: DockerRuntimeSpec): boolean {
  return inspect.Config?.Image === runtime.imageName
    && inspect.Config?.Labels?.[MANAGED_LABEL] === 'true'
    && inspect.Config?.Labels?.[CLAIM_LABEL] === id
    && portsMatch(inspect, runtime)
    && volumesMatch(inspect, runtime);
}

function appHealthUrl(runtime: DockerRuntimeSpec): string {
  return `http://localhost:${runtime.hostPort}${runtime.healthPath}`;
}

function runtimePorts(runtime: DockerRuntimeSpec) {
  const ports = [
    { hostPort: runtime.hostPort, containerPort: runtime.containerPort, protocol: 'tcp' as const, hostIp: '127.0.0.1' },
    ...(runtime.additionalPorts ?? []).map((port) => ({ ...port, hostIp: port.hostIp ?? '127.0.0.1' })),
  ];
  if (ports.length > 11 || ports.some((port) =>
    !Number.isInteger(port.hostPort) || port.hostPort < 1 || port.hostPort > 65535
    || !Number.isInteger(port.containerPort) || port.containerPort < 1 || port.containerPort > 65535
    || !['tcp', 'udp'].includes(port.protocol) || !['127.0.0.1', '0.0.0.0'].includes(port.hostIp))) {
    throw new Error('Invalid container port configuration.');
  }
  if (new Set(ports.map((port) => `${port.hostPort}/${port.protocol}`)).size !== ports.length) {
    throw new Error('Duplicate published container port.');
  }
  return ports;
}

function portsMatch(inspect: DockerInspect, runtime: DockerRuntimeSpec): boolean {
  const expected = runtimePorts(runtime);
  const bindings = Object.entries(inspect.HostConfig?.PortBindings ?? {}).flatMap(([key, entries]) =>
    (entries ?? []).map((binding) => ({ key, ...binding })));
  return bindings.length === expected.length && expected.every((port) => bindings.some((binding) =>
    binding.key === `${port.containerPort}/${port.protocol}` && binding.HostIp === port.hostIp
    && binding.HostPort === String(port.hostPort)));
}

function appStatus(
  desired: ContainerClaimCreateInput & { id: string },
  dockerContext: string | null,
  state: ContainerAppStatus['state'],
  ready: boolean,
  lastAction: string,
  error: string | null,
): ContainerAppStatus {
  const runtime = desired.runtime!;
  return {
    id: desired.id,
    displayName: desired.title,
    claimTitle: desired.title,
    claimId: desired.id,
    repository: desired.repository,
    buildContext: runtime.buildContext,
    dockerfile: runtime.dockerfile,
    image: runtime.imageName,
    containerName: runtime.containerName,
    dockerContext,
    state,
    hostPort: runtime.hostPort,
    containerPort: runtime.containerPort,
    url: `http://localhost:${runtime.hostPort}${runtime.entryPath}`,
    ready,
    lastAction,
    error,
    ...(desired.mcp ? { mcp: desired.mcp } : {}),
    ...(desired.application ? { application: desired.application } : {}),
  };
}

async function defaultReadiness(url: string): Promise<boolean> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 1_500);
  try {
    const response = await fetch(url, { method: 'GET', signal: controller.signal });
    return response.ok;
  } finally {
    clearTimeout(timeout);
  }
}

function failure(code: DockerErrorCode, prefix: string, error: unknown): ContainerLaunchResult {
  if (error instanceof CommandTimeoutError) {
    return {
      status: 'error',
      code: 'docker_timeout',
      message: `${prefix} Docker operation timed out after ${error.timeoutMs}ms.`,
    };
  }
  const detail = error instanceof CommandExecutionError
    ? error.stderr.trim() || error.message
    : error instanceof Error ? error.message : String(error);
  return { status: 'error', code, message: `${prefix}${detail ? ` ${detail}` : ''}` };
}

function isMissingContainer(error: unknown): boolean {
  return error instanceof CommandExecutionError
    && error.code !== 'ENOENT'
    && /no such (object|container)/i.test(error.stderr || error.message);
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function errorDetail(error: unknown): string {
  if (error instanceof CommandExecutionError) return error.stderr.trim() || error.message;
  return error instanceof Error ? error.message : String(error);
}

function validateVolumes(volumes: DockerRuntimeSpec['volumes']): void {
  for (const volume of volumes ?? []) {
    if (!/^[a-z0-9][a-z0-9_.-]{0,127}$/.test(volume.name)) {
      throw new Error(`Unsafe Docker volume name: "${volume.name}".`);
    }
    if (!/^\/(?:[^/]+\/)*[^/]+$/.test(volume.mountPath) || volume.mountPath.includes('..')) {
      throw new Error(`Unsafe Docker volume mount path: "${volume.mountPath}".`);
    }
  }
}

function volumesMatch(inspect: DockerInspect, runtime: DockerRuntimeSpec): boolean {
  validateVolumes(runtime.volumes);
  return (runtime.volumes ?? []).every((expected) =>
    inspect.Mounts?.some((mount) =>
      mount.Type === 'volume'
      && mount.Name === expected.name
      && mount.Destination === expected.mountPath));
}
