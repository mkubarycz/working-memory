import { z } from 'zod';
import { dockerCliPath, dockerEnvironment, type DockerHost } from './dockerCli';
import type { CommandRunner, CommandRunOptions, CommandResult } from './dockerContainerService';

export type ContainerProvider = 'docker' | 'podman';

export function parseContainerProvider(value: unknown): ContainerProvider {
  return z.enum(['docker', 'podman']).parse(value);
}

interface Connection {
  args: string[];
  env: NodeJS.ProcessEnv;
  identity: string;
}

export interface ContainerProviderOptions {
  provider?: ContainerProvider;
  runner: CommandRunner;
  host: DockerHost;
  fileExists?: (path: string) => boolean;
  dockerContext?: string;
}

function detail(error: unknown): string {
  if (error instanceof Error && 'stderr' in error && typeof error.stderr === 'string' && error.stderr.trim()) {
    return error.stderr.trim().split(/\r?\n/).slice(-6).join('\n');
  }
  return error instanceof Error ? error.message : String(error);
}

function localSocket(endpoint: string): boolean {
  return /^unix:\/\/\/[^?\r\n]+$/.test(endpoint)
    || /^npipe:\/\/\/\/\.\/pipe\/[a-zA-Z0-9_.-]+$/.test(endpoint);
}

/** Owns executable discovery and connection routing for both runtime consumers. */
export class ContainerProviderAdapter {
  readonly provider: ContainerProvider;
  readonly label: string;
  private readonly connections = new Map<string, Connection>();

  constructor(private readonly options: ContainerProviderOptions) {
    this.provider = options.provider ?? 'docker';
    this.label = this.provider === 'docker' ? 'Docker' : 'Podman';
  }

  private executable(): { file: string; env: NodeJS.ProcessEnv } {
    const host = this.options.host;
    const file = this.options.fileExists
      ? dockerCliPath(host, this.options.fileExists, this.provider)
      : this.provider;
    if (!file) {
      throw Object.assign(new Error(`${this.label} CLI was not found. Install ${this.label} and its Compose support, then Retry.`), { code: 'ENOENT' });
    }
    const env = dockerEnvironment(host, file, this.provider);
    // Explicit connection arguments must also govern external Compose helpers.
    delete env.DOCKER_HOST;
    delete env.DOCKER_CONTEXT;
    delete env.CONTAINER_HOST;
    delete env.CONTAINER_CONNECTION;
    return { file, env };
  }

  private raw(args: string[], options: CommandRunOptions): Promise<CommandResult> {
    const { file, env } = this.executable();
    return this.options.runner.run(file, args, { ...options, env });
  }

  async resolve(signal?: AbortSignal): Promise<string> {
    const options = { timeoutMs: 10_000, signal };
    const { env } = this.executable();
    if (this.provider === 'podman') {
      const result = await this.raw(['system', 'connection', 'list', '--format', 'json'], options);
      const connections = z.array(z.object({
        Name: z.string().min(1), URI: z.string(), Default: z.boolean(),
        IsMachine: z.boolean().optional(), Identity: z.string().optional(),
      })).parse(JSON.parse(result.stdout));
      const selected = connections.find(connection => connection.Default);
      let args: string[];
      let key: string;
      let identity: string;
      if (!selected && this.options.host.platform === 'linux') {
        args = ['--remote=false'];
        key = 'podman:local';
        identity = key;
      } else {
        if (!selected) throw new Error('Podman has no default local connection. Configure and start a local Podman machine, then Retry.');
        const uri = new URL(selected.URI);
        const machine = selected.IsMachine === true && uri.protocol === 'ssh:'
          && ['127.0.0.1', 'localhost', '[::1]'].includes(uri.hostname)
          && /^\/run\/(?:user\/\d+\/)?podman\/podman\.sock$/.test(uri.pathname)
          && !uri.search && !uri.hash;
        if (!localSocket(selected.URI) && !machine) {
          throw new Error(`Podman connection "${selected.Name}" is not a local socket or local Podman machine. Remote engines are not supported.`);
        }
        args = ['--connection', selected.Name];
        key = `${selected.Name} (${selected.URI})`;
        identity = key;
        if (machine) {
          const name = selected.Name.replace(/-root$/, '');
          const inspected = await this.raw(['machine', 'inspect', name], options);
          const [vm] = z.array(z.object({
            Name: z.string(), Created: z.string().min(1), State: z.string(),
            SSHConfig: z.object({ Port: z.number().int(), IdentityPath: z.string(), RemoteUsername: z.string() }),
          })).length(1).parse(JSON.parse(inspected.stdout));
          if (vm.Name !== name || vm.State !== 'running'
            || vm.SSHConfig.Port !== Number(uri.port)
            || vm.SSHConfig.IdentityPath !== selected.Identity
            || ![vm.SSHConfig.RemoteUsername, 'root'].includes(uri.username)) {
            throw new Error('The selected Podman connection does not match a running local machine. Start or repair the selected machine, then Retry.');
          }
          identity = `${vm.Name} (${vm.Created}; ${uri.username}${uri.pathname})`;
        }
      }
      this.connections.set(key, { args, env, identity });
      await this.run(key, ['info', '--format', 'json'], options);
      return key;
    }
    const configured = this.options.dockerContext
      ?? this.options.host.env.WORKING_MEMORY_DOCKER_CONTEXT ?? this.options.host.env.DOCKER_CONTEXT;
    const errors: string[] = [];
    for (const context of configured ? [configured] : ['desktop-linux', 'orbstack', 'default']) {
      try {
        const args = ['--context', context];
        const result = await this.raw([...args, 'context', 'inspect', context, '--format', '{{json .Endpoints.docker.Host}}'], options);
        const endpoint = z.string().parse(JSON.parse(result.stdout));
        if (!localSocket(endpoint)) throw new Error(`Docker context "${context}" is not local (${endpoint}).`);
        this.connections.set(context, { args, env, identity: `${context} (${endpoint})` });
        await this.run(context, ['info', '--format', '{{json .ServerVersion}}'], options);
        return context;
      } catch (error) {
        if (signal?.aborted || (error instanceof Error && 'code' in error
          && ['ENOENT', 'ETIMEDOUT', 'ABORT_ERR'].includes(String(error.code)))) throw error;
        errors.push(`${context}: ${detail(error)}`);
        if (configured) break;
      }
    }
    throw new Error(`Docker is unavailable. Start the selected local provider, then Retry. ${errors.join('; ')}`);
  }

  run(connection: string, args: string[], options: CommandRunOptions): Promise<CommandResult> {
    const selected = this.connections.get(connection);
    if (!selected) throw new Error(`${this.label} connection has not been validated.`);
    const { file } = this.executable();
    return this.options.runner.run(file, [...selected.args, ...args], { ...options, env: selected.env });
  }

  identity(connection: string): string {
    const selected = this.connections.get(connection);
    if (!selected) throw new Error('Container connection has not been validated.');
    return selected.identity;
  }

  imageReference(image: string, expectedImage?: string): string {
    const unqualified = image.startsWith('localhost/') ? image.slice('localhost/'.length) : image;
    return this.provider === 'podman' && !unqualified.includes('/')
      && (!expectedImage || unqualified === expectedImage) ? unqualified : image;
  }

  inspect(raw: string, expectedImage?: string): unknown {
    const containers = z.array(z.record(z.string(), z.unknown())).parse(JSON.parse(raw));
    if (this.provider !== 'podman') return containers;
    return containers.map(container => {
      const state = z.record(z.string(), z.unknown()).optional().parse(container.State);
      const config = z.record(z.string(), z.unknown()).optional().parse(container.Config);
      const image = expectedImage && typeof config?.Image === 'string'
        ? this.imageReference(config.Image, expectedImage) : config?.Image;
      return {
        ...container,
        ...(config ? { Config: { ...config, Image: image } } : {}),
        ...(state ? { State: { ...state, Health: state.Health ?? state.Healthcheck } } : {}),
      };
    });
  }

  async requireCompose(connection: string, options: CommandRunOptions): Promise<void> {
    try {
      await this.run(connection, ['compose', 'version'], options);
    } catch (error) {
      throw new Error(`${this.label} Compose is missing or unavailable. Install working Compose support for ${this.label}, then Retry. ${detail(error)}`);
    }
  }

  async composeUp(connection: string, file: string, options: CommandRunOptions): Promise<void> {
    try {
      // These flags are shared by Docker Compose and podman-compose. Readiness is
      // checked over HTTP by the caller, not delegated to Compose's optional --wait.
      await this.run(connection, ['compose', '--file', file, 'up', '--detach', '--no-build'], options);
    } catch (error) {
      throw new Error(`${this.label} Compose could not start the backend. Retry after correcting the reported error. ${detail(error)}`);
    }
  }
}
