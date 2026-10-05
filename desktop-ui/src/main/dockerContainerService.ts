import { execFile } from 'node:child_process';
import { statSync } from 'node:fs';
import { resolve } from 'node:path';
import type {
  ContainerClaim,
  ContainerClaimCreateInput,
  ContainerClaimUpdateInput,
  DockerRuntimeSpec,
} from '../../../shared/controlPlaneClient';
import type { ContainerAppStatus, ContainerStopResult } from '../shared/contracts';
import type { ContainerAppRegistration } from './containerAppRegistry';

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
}

export interface ClaimClient {
  containerClaimRead(input: { slug: string }): Promise<ContainerClaim[]>;
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
  runner?: CommandRunner;
  readiness?: (url: string) => Promise<boolean>;
  retries?: number;
  retryDelayMs?: number;
  dockerContext?: string;
  env?: NodeJS.ProcessEnv;
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

export interface ContainerAppSourceOptions {
  configuredPath?: string;
  cwd?: string;
  searchRoots?: string[];
  pathKind?: (path: string) => 'file' | 'directory' | null;
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
const LOCAL_CONTEXTS = ['desktop-linux', 'orbstack', 'default'];

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
    super(`Docker command timed out after ${timeoutMs}ms.`, 'ETIMEDOUT');
  }
}

export class ExecFileCommandRunner implements CommandRunner {
  run(file: string, args: string[], options: CommandRunOptions): Promise<CommandResult> {
    return new Promise((resolve, reject) => {
      execFile(file, args, {
        encoding: 'utf8',
        maxBuffer: 10 * 1024 * 1024,
        timeout: options.timeoutMs,
        signal: options.signal,
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
  private readonly runner: CommandRunner;
  private readonly readiness: (url: string) => Promise<boolean>;
  private readonly retries: number;
  private readonly retryDelayMs: number;
  private readonly configuredContext?: string;
  private readonly env: NodeJS.ProcessEnv;
  private readonly timeouts: DockerOperationTimeouts;

  constructor(options: DockerContainerServiceOptions = {}) {
    this.runner = options.runner ?? new ExecFileCommandRunner();
    this.readiness = options.readiness ?? defaultReadiness;
    this.retries = options.retries ?? 30;
    this.retryDelayMs = options.retryDelayMs ?? 500;
    this.configuredContext = options.dockerContext;
    this.env = options.env ?? process.env;
    this.timeouts = { ...DEFAULT_TIMEOUTS, ...options.timeouts };
  }

  async ensure(
    claimClient: ClaimClient,
    desired: ContainerClaimCreateInput,
    signal?: AbortSignal,
  ): Promise<ContainerLaunchResult> {
    let claim: ContainerClaim;
    try {
      const [existing] = await claimClient.containerClaimRead({ slug: desired.slug });
      claim = existing
        ? await this.updateClaimIfNeeded(claimClient, existing, desired)
        : await claimClient.containerClaimCreate(desired);
    } catch (error) {
      return failure('claim_error', `Unable to ensure the ${desired.title} ContainerClaim.`, error);
    }

    if (!claim.runtime || claim.runtime.type !== 'docker') {
      return { status: 'error', code: 'claim_error', message: 'ContainerClaim has no Docker runtime specification.' };
    }

    const runtime = claim.runtime;
    let context: string;
    try {
      context = await this.resolveDockerContext(signal);
    } catch (error) {
      const missing = error instanceof CommandExecutionError && error.code === 'ENOENT';
      return failure(
        missing ? 'docker_missing' : 'docker_unavailable',
        missing ? 'Docker CLI is not installed or is not on PATH.' : 'No safe local Docker context is available.',
        error,
      );
    }

    try {
      await this.docker(context, [
        'build', '--label', `${MANAGED_LABEL}=true`, '--label', `${CLAIM_LABEL}=${claim.slug}`,
        '-t', runtime.imageName, '-f', runtime.dockerfile, runtime.buildContext,
      ], this.timeouts.build, signal);
    } catch (error) {
      return failure('build_failed', 'Docker image build failed.', error);
    }

    let imageId: string;
    try {
      imageId = (await this.docker(context, [
        'image', 'inspect', '--format', '{{.Id}}', runtime.imageName,
      ], this.timeouts.inspect, signal)).stdout.trim();
      if (!imageId) throw new Error('Docker returned an empty image id.');
    } catch (error) {
      return failure('build_failed', 'Built Docker image could not be inspected.', error);
    }

    let current: DockerInspect | null = null;
    try {
      const result = await this.docker(
        context,
        ['container', 'inspect', runtime.containerName],
        this.timeouts.inspect,
        signal,
      );
      const parsed = JSON.parse(result.stdout) as DockerInspect[];
      current = parsed[0] ?? null;
    } catch (error) {
      if (!isMissingContainer(error)) {
        return failure('start_failed', 'Existing Docker container could not be inspected.', error);
      }
    }

    let action: 'created' | 'started' | 'recreated' | 'reused';
    const matches = current ? containerMatches(current, claim.slug, runtime, imageId) : false;
    if (current && !matches) {
      if (current.Config?.Labels?.[MANAGED_LABEL] !== 'true'
        || current.Config?.Labels?.[CLAIM_LABEL] !== claim.slug) {
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
        await this.runContainer(context, runtime, claim.slug, signal);
        action = 'recreated';
      } catch (error) {
        return failure('start_failed', 'Managed Docker container could not be recreated.', error);
      }
    } else if (!current) {
      try {
        await this.runContainer(context, runtime, claim.slug, signal);
        action = 'created';
      } catch (error) {
        return failure('start_failed', 'Docker container could not be started.', error);
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
        return failure('start_failed', 'Existing managed Docker container could not be started.', error);
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

  async inspect(desired: ContainerClaimCreateInput, signal?: AbortSignal): Promise<ContainerAppStatus> {
    const runtime = desired.runtime;
    if (!runtime || runtime.type !== 'docker') return appStatus(desired, null, 'error', false, 'Status failed', 'ContainerClaim has no Docker runtime specification.');
    let context: string;
    try {
      context = await this.resolveDockerContext(signal);
    } catch (error) {
      return appStatus(desired, null, 'error', false, 'Status failed', errorDetail(error));
    }
    let current: DockerInspect;
    try {
      const result = await this.docker(context, ['container', 'inspect', runtime.containerName], this.timeouts.inspect, signal);
      current = (JSON.parse(result.stdout) as DockerInspect[])[0] ?? {};
    } catch (error) {
      if (isMissingContainer(error)) return appStatus(desired, context, 'missing', false, 'Status refreshed', null);
      return appStatus(desired, context, 'error', false, 'Status failed', errorDetail(error));
    }
    if (!containerOwnedByClaim(current, desired.slug, runtime)) {
      return appStatus(desired, context, 'error', false, 'Status refused', `Container "${runtime.containerName}" is not the exact managed container for this claim.`);
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

  async stop(desired: ContainerClaimCreateInput, signal?: AbortSignal): Promise<ContainerStopResult> {
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
      slug: desired.slug,
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
    slug: string,
    signal?: AbortSignal,
  ): Promise<void> {
    validateVolumes(runtime.volumes);
    const volumeArgs = (runtime.volumes ?? []).flatMap((volume) => [
      '--mount', `type=volume,source=${volume.name},destination=${volume.mountPath}`,
    ]);
    await this.docker(context, [
      'container', 'run', '--detach', '--name', runtime.containerName,
      '--label', `${MANAGED_LABEL}=true`, '--label', `${CLAIM_LABEL}=${slug}`,
      '--publish', `127.0.0.1:${runtime.hostPort}:${runtime.containerPort}`,
      ...volumeArgs,
      runtime.imageName,
    ], this.timeouts.start, signal);
  }

  private docker(
    context: string,
    args: string[],
    timeoutMs: number,
    signal?: AbortSignal,
  ): Promise<CommandResult> {
    return this.runner.run('docker', ['--context', context, ...args], { timeoutMs, signal });
  }

  private async resolveDockerContext(signal?: AbortSignal): Promise<string> {
    const configured = this.configuredContext
      ?? this.env.WORKING_MEMORY_DOCKER_CONTEXT
      ?? this.env.DOCKER_CONTEXT;
    const candidates = configured ? [configured] : LOCAL_CONTEXTS;
    const checked: string[] = [];
    for (const context of candidates) {
      try {
        const inspected = await this.docker(
          context,
          ['context', 'inspect', context, '--format', '{{json .Endpoints.docker.Host}}'],
          this.timeouts.context,
          signal,
        );
        const endpoint = parseDockerEndpoint(inspected.stdout);
        if (!endpoint?.startsWith('unix://')) {
          const detail = endpoint || 'unknown endpoint';
          if (configured) {
            throw new Error(`Configured Docker context "${context}" is not local (${detail}).`);
          }
          checked.push(`${context} (${detail})`);
          continue;
        }
        await this.docker(
          context,
          ['info', '--format', '{{json .ServerVersion}}'],
          this.timeouts.info,
          signal,
        );
        return context;
      } catch (error) {
        if (error instanceof CommandTimeoutError
          || (error instanceof CommandExecutionError && error.code === 'ENOENT')) throw error;
        if (configured) {
          throw new Error(`Configured Docker context "${context}" is unavailable. ${errorDetail(error)}`);
        }
        checked.push(`${context} (${errorDetail(error)})`);
      }
    }
    throw new Error(`Checked ${checked.join(', ') || 'no contexts'}; none had a healthy local Unix socket.`);
  }
}

export function resolveContainerAppClaim(
  app: ContainerAppRegistration,
  existing?: ContainerClaim,
  options: ContainerAppSourceOptions = {},
): ContainerClaimCreateInput {
  const pathKind = options.pathKind ?? defaultPathKind;
  const cwd = options.cwd ?? process.cwd();
  const configured = options.configuredPath ?? process.env[app.sourceEnvironmentVariable];
  const candidates = unique([
    ...(configured ? [configured] : []),
    ...(existing && validContainerAppSource(existing.repository, existing.runtime, pathKind)
      ? [existing.repository]
      : []),
    ...(options.searchRoots ?? []),
    resolve(cwd, app.projectDirectory),
    resolve(cwd, 'projects', app.projectDirectory),
    resolve(cwd, '..', app.projectDirectory),
    resolve(cwd, '..', '..', app.projectDirectory),
  ]).map((candidate) => resolve(candidate));
  const repository = candidates.find((candidate) => (
    pathKind(candidate) === 'directory'
    && pathKind(resolve(candidate, 'Dockerfile')) === 'file'
    && pathKind(resolve(candidate, 'package.json')) === 'file'
  ));
  if (!repository) {
    throw new Error(
      `${app.displayName} source was not found. Set ${app.sourceEnvironmentVariable} to a checkout containing Dockerfile and package.json. Checked: ${candidates.join(', ')}.`,
    );
  }

  return {
    slug: app.id,
    title: app.claimTitle,
    repository,
    runtime: {
      buildContext: repository,
      dockerfile: resolve(repository, 'Dockerfile'),
      ...app.runtime,
    },
    ...(app.mcp ? { mcp: app.mcp } : {}),
    ...(app.application ? { application: app.application } : {}),
  };
}

function containerMatches(
  inspect: DockerInspect,
  slug: string,
  runtime: DockerRuntimeSpec,
  imageId: string,
): boolean {
  const binding = inspect.HostConfig?.PortBindings?.[`${runtime.containerPort}/tcp`]?.[0];
  return inspect.Image === imageId
    && inspect.Config?.Image === runtime.imageName
    && inspect.Config?.Labels?.[MANAGED_LABEL] === 'true'
    && inspect.Config?.Labels?.[CLAIM_LABEL] === slug
    && binding?.HostIp === '127.0.0.1'
    && binding.HostPort === String(runtime.hostPort)
    && volumesMatch(inspect, runtime);
}

function containerOwnedByClaim(inspect: DockerInspect, slug: string, runtime: DockerRuntimeSpec): boolean {
  const binding = inspect.HostConfig?.PortBindings?.[`${runtime.containerPort}/tcp`]?.[0];
  return inspect.Config?.Image === runtime.imageName
    && inspect.Config?.Labels?.[MANAGED_LABEL] === 'true'
    && inspect.Config?.Labels?.[CLAIM_LABEL] === slug
    && binding?.HostIp === '127.0.0.1'
    && binding.HostPort === String(runtime.hostPort)
    && volumesMatch(inspect, runtime);
}

function appHealthUrl(runtime: DockerRuntimeSpec): string {
  return `http://localhost:${runtime.hostPort}${runtime.healthPath}`;
}

function appStatus(
  desired: ContainerClaimCreateInput,
  dockerContext: string | null,
  state: ContainerAppStatus['state'],
  ready: boolean,
  lastAction: string,
  error: string | null,
): ContainerAppStatus {
  const runtime = desired.runtime!;
  return {
    id: desired.slug,
    displayName: desired.slug === 'clarinet-hero' ? 'Claranet Hero' : desired.title,
    claimTitle: desired.title,
    claimSlug: desired.slug,
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

function parseDockerEndpoint(stdout: string): string | null {
  const value = stdout.trim();
  if (!value) return null;
  try {
    const parsed = JSON.parse(value) as unknown;
    return typeof parsed === 'string' ? parsed : null;
  } catch {
    return value;
  }
}

function errorDetail(error: unknown): string {
  if (error instanceof CommandExecutionError) return error.stderr.trim() || error.message;
  return error instanceof Error ? error.message : String(error);
}

function defaultPathKind(path: string): 'file' | 'directory' | null {
  try {
    const stat = statSync(path);
    if (stat.isFile()) return 'file';
    if (stat.isDirectory()) return 'directory';
  } catch {
    // A missing or inaccessible candidate is not a usable source checkout.
  }
  return null;
}

function validContainerAppSource(
  repository: string,
  runtime: DockerRuntimeSpec | undefined,
  pathKind: (path: string) => 'file' | 'directory' | null,
): runtime is DockerRuntimeSpec {
  return runtime?.type === 'docker'
    && pathKind(repository) === 'directory'
    && pathKind(runtime.buildContext) === 'directory'
    && pathKind(runtime.dockerfile) === 'file';
}

function unique(values: string[]): string[] {
  return [...new Set(values)];
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
