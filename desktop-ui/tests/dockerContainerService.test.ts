import { describe, expect, it, vi } from 'vitest';
import {
  CLAIM_LABEL,
  CommandExecutionError,
  CommandTimeoutError,
  DockerContainerService,
  ExecFileCommandRunner,
  MANAGED_LABEL,
  type ClaimClient,
  type CommandRunner,
} from '../src/main/dockerContainerService';
import { CONTAINER_APP_FIXTURES } from './fixtures/containerApps';
import type { ContainerClaimCreateInput } from '../../shared/controlPlaneClient';

const desired: ContainerClaimCreateInput & { id: string } = {
  id: 'clarinet-hero',
  title: 'Clarinet Hero',
  repository: '/repo/ClarinetHero',
  runtime: {
    type: 'docker',
    buildContext: '/repo/ClarinetHero',
    dockerfile: '/repo/ClarinetHero/Dockerfile',
    imageName: 'clarinet-hero:local',
    containerName: 'working-memory-clarinet-hero',
    hostPort: 4173,
    containerPort: 80,
    healthPath: '/',
    entryPath: '/',
  },
};

function claim(overrides = {}) {
  return { id: 'claim-id', created_at: 1, updated_at: 1, resourceVersion: 1, ...desired, ...overrides };
}

function client(existing = claim()): ClaimClient {
  return {
    containerClaimRead: vi.fn().mockResolvedValue(existing ? [existing] : []),
    containerClaimCreate: vi.fn().mockResolvedValue(claim()),
    containerClaimUpdate: vi.fn().mockResolvedValue(claim()),
  };
}

function localRunner(
  handler: (args: string[], options?: { timeoutMs: number; signal?: AbortSignal }) => Promise<{ stdout: string; stderr: string }>,
  calls: string[][] = [],
  endpoint = 'unix:///local/docker.sock',
): CommandRunner {
  return {
    run: vi.fn(async (_file, args, options) => {
      calls.push(args);
      const command = args.slice(2);
      if (command[0] === 'context') return { stdout: `${JSON.stringify(endpoint)}\n`, stderr: '' };
      if (command[0] === 'info') return { stdout: '"27.0.0"\n', stderr: '' };
      return handler(command, options);
    }),
  };
}

describe('DockerContainerService', () => {
  it('rejects duplicate published ports before building or modifying any container', async () => {
    const calls: string[][] = [];
    const duplicate = {
      ...desired,
      runtime: { ...desired.runtime!, additionalPorts: [{ hostPort: 4173, containerPort: 7720, protocol: 'tcp' as const }] },
    };
    const service = new DockerContainerService({ runner: localRunner(async () => ({ stdout: '', stderr: '' }), calls) });
    expect(await service.launch(claim(duplicate))).toMatchObject({ status: 'error', code: 'claim_error' });
    expect(await service.inspect(duplicate)).toMatchObject({ state: 'error', ready: false });
    expect(await service.stop(duplicate)).toMatchObject({ status: 'error' });
    expect(calls).toHaveLength(0);
  });

  it('publishes configured TCP/UDP LAN ports while keeping the primary UI port on loopback', async () => {
    const calls: string[][] = [];
    const extended = {
      ...desired,
      runtime: {
        ...desired.runtime!,
        additionalPorts: [
          { hostPort: 7720, containerPort: 7720, protocol: 'tcp' as const, hostIp: '0.0.0.0' as const },
          { hostPort: 7721, containerPort: 7721, protocol: 'udp' as const, hostIp: '0.0.0.0' as const },
        ],
      },
    };
    let existing = false;
    const inspect = {
      Config: { Image: extended.runtime.imageName, Labels: { [MANAGED_LABEL]: 'true', [CLAIM_LABEL]: extended.id } },
      State: { Running: true },
      HostConfig: { PortBindings: {
        '80/tcp': [{ HostIp: '127.0.0.1', HostPort: '4173' }],
        '7720/tcp': [{ HostIp: '0.0.0.0', HostPort: '7720' }],
        '7721/udp': [{ HostIp: '0.0.0.0', HostPort: '7721' }],
      } },
    };
    const runner = localRunner(async (args) => {
      if (args[0] === 'image') return { stdout: 'sha256:new', stderr: '' };
      if (args[0] === 'container' && args[1] === 'inspect') {
        if (!existing) throw new CommandExecutionError('not found', 1, 'No such container');
        return { stdout: JSON.stringify([inspect]), stderr: '' };
      }
      return { stdout: '', stderr: '' };
    }, calls);
    const service = new DockerContainerService({ runner, readiness: async () => true });
    expect(await service.launch(claim(extended))).toMatchObject({ status: 'ready' });
    expect(calls.find(args => args.includes('run'))).toEqual(expect.arrayContaining([
      '127.0.0.1:4173:80', '0.0.0.0:7720:7720', '0.0.0.0:7721:7721/udp',
    ]));
    existing = true;
    expect(await service.inspect(extended)).toMatchObject({ ready: true });
    inspect.HostConfig.PortBindings['7721/udp'][0].HostIp = '127.0.0.1';
    expect(await service.inspect(extended)).toMatchObject({ state: 'error', ready: false });
  });

  it('clears stale optional claim metadata that the registry no longer advertises', async () => {
    const stale = claim({
      application: {
        id: 'sunset-chess',
        contractVersion: '1.0',
        discovery: { toolName: 'contract-discover' },
        capabilities: ['contract-discovery'],
        dataOwnership: 'application',
      },
    });
    const claimClient = client(stale);
    vi.mocked(claimClient.containerClaimUpdate).mockRejectedValue(new Error('stop after update'));

    await expect(new DockerContainerService().ensure(claimClient, desired))
      .resolves.toMatchObject({ status: 'error', code: 'claim_error' });
    expect(claimClient.containerClaimUpdate).toHaveBeenCalledWith(expect.objectContaining({
      id: desired.id,
      mcp: null,
      application: null,
    }));
  });

  it('uses one explicitly selected local context for every Docker command', async () => {
    const calls: string[][] = [];
    const runner = localRunner(async (args) => {
      if (args[0] === 'container' && args[1] === 'inspect') {
        throw new CommandExecutionError('not found', 1, 'No such container');
      }
      if (args[0] === 'image') return { stdout: 'sha256:new\n', stderr: '' };
      return { stdout: '', stderr: '' };
    }, calls);
    const readiness = vi.fn().mockResolvedValueOnce(false).mockResolvedValueOnce(true);
    const result = await new DockerContainerService({
      runner,
      readiness,
      retries: 2,
      retryDelayMs: 0,
      dockerContext: 'desktop-linux',
    }).ensure(client(null as never), desired);

    expect(result).toMatchObject({ status: 'ready', action: 'created', url: 'http://localhost:4173/' });
    expect(calls.every((args) => args[0] === '--context' && args[1] === 'desktop-linux')).toBe(true);
    expect(calls).toContainEqual(expect.arrayContaining([
      'run', '--detach', '--name', 'working-memory-clarinet-hero',
      '--label', `${MANAGED_LABEL}=true`, '--label', `${CLAIM_LABEL}=clarinet-hero`,
    ]));
    expect(readiness).toHaveBeenCalledTimes(2);
  });

  it('mounts safe named volumes without changing apps that omit volumes', async () => {
    const calls: string[][] = [];
    const withVolume = {
      ...desired,
      runtime: {
        ...desired.runtime!,
        volumes: [{ name: 'working-memory-sunset-chess-data', mountPath: '/data' }],
      },
    };
    const runner = localRunner(async (args) => {
      if (args[0] === 'container' && args[1] === 'inspect') {
        throw new CommandExecutionError('not found', 1, 'No such container');
      }
      if (args[0] === 'image') return { stdout: 'sha256:new\n', stderr: '' };
      return { stdout: '', stderr: '' };
    }, calls);
    const volumeClient = client(null as never);
    vi.mocked(volumeClient.containerClaimCreate).mockResolvedValue(claim(withVolume));
    await new DockerContainerService({ runner, readiness: async () => true }).ensure(volumeClient, withVolume);
    const run = calls.find((args) => args.includes('run'))!;
    expect(run).toContain('type=volume,source=working-memory-sunset-chess-data,destination=/data');

    const unsafe = {
      ...withVolume,
      runtime: { ...withVolume.runtime, volumes: [{ name: '../unsafe', mountPath: '/data' }] },
    };
    const unsafeClient = client(null as never);
    vi.mocked(unsafeClient.containerClaimCreate).mockResolvedValue(claim(unsafe));
    await expect(new DockerContainerService({ runner }).ensure(unsafeClient, unsafe))
      .resolves.toMatchObject({ status: 'error', code: 'start_failed' });
  });

  it.each([
    { endpoint: 'npipe:////./pipe/dockerDesktopLinuxEngine', context: undefined },
    { endpoint: 'npipe:////./pipe/dockerDesktopLinuxEngine', context: 'desktop-linux' },
    { endpoint: 'npipe:////./pipe/docker_engine', context: 'default' },
  ])('launches, inspects, and stops a local Windows pipe ($endpoint, $context)', async ({ endpoint, context }) => {
    const calls: string[][] = [];
    let exists = false;
    const runner = localRunner(async (args) => {
      if (args[0] === 'image') return { stdout: 'sha256:new\n', stderr: '' };
      if (args[0] === 'container' && args[1] === 'inspect') {
        if (!exists) throw new CommandExecutionError('not found', 1, 'No such container');
        return {
          stdout: JSON.stringify([{
            Image: 'sha256:new',
            State: { Running: true },
            Config: {
              Image: desired.runtime!.imageName,
              Labels: { [MANAGED_LABEL]: 'true', [CLAIM_LABEL]: desired.id },
            },
            HostConfig: { PortBindings: { '80/tcp': [{ HostIp: '127.0.0.1', HostPort: '4173' }] } },
          }]),
          stderr: '',
        };
      }
      if (args[0] === 'container' && args[1] === 'run') exists = true;
      return { stdout: '', stderr: '' };
    }, calls, endpoint);
    const service = new DockerContainerService({ runner, dockerContext: context, env: {}, readiness: async () => true });
    await expect(service.launch(claim())).resolves.toMatchObject({ status: 'ready', action: 'created' });
    await expect(service.inspect(desired)).resolves.toMatchObject({ state: 'healthy', ready: true });
    await expect(service.stop(desired)).resolves.toMatchObject({ status: 'stopped' });
    expect(calls.every((args) => args[0] === '--context' && args[1] === (context ?? 'desktop-linux'))).toBe(true);
    expect(calls.some((args) => args[2] === 'info')).toBe(true);
    expect(calls.some((args) => args[2] === 'build')).toBe(true);
    expect(calls.some((args) => args[2] === 'container' && args[3] === 'run')).toBe(true);
    expect(calls.some((args) => args[2] === 'container' && args[3] === 'stop')).toBe(true);
    expect(calls.flat()).not.toContain('rm');
  });

  it('requires a healthy daemon on an explicitly selected Windows pipe without falling back', async () => {
    const runner: CommandRunner = {
      run: vi.fn(async (_file, args) => {
        if (args[2] === 'context') {
          return { stdout: '"npipe:////./pipe/dockerDesktopLinuxEngine"', stderr: '' };
        }
        throw new CommandExecutionError('Docker Desktop is not running', 1);
      }),
    };
    const result = await new DockerContainerService({ runner, dockerContext: 'desktop-linux' }).launch(claim());
    expect(result).toMatchObject({ status: 'error', code: 'docker_unavailable' });
    expect(result.status === 'error' && result.message).toContain('Docker Desktop is not running');
    expect(runner.run).toHaveBeenCalledTimes(2);
    expect(vi.mocked(runner.run).mock.calls.every(([, args]) => args[1] === 'desktop-linux')).toBe(true);
  });

  it('finds the healthy default Windows pipe when Docker Desktop context is unavailable', async () => {
    const calls: string[][] = [];
    const runner: CommandRunner = {
      run: vi.fn(async (_file, args) => {
        calls.push(args);
        if (args[2] === 'context') {
          if (args[1] === 'orbstack') throw new CommandExecutionError('context not found', 1);
          return { stdout: JSON.stringify(`npipe:////./pipe/${args[1] === 'default' ? 'docker_engine' : 'dockerDesktopLinuxEngine'}`), stderr: '' };
        }
        if (args[2] === 'info') {
          if (args[1] === 'desktop-linux') throw new CommandExecutionError('pipe unavailable', 1);
          return { stdout: '"27.0.0"', stderr: '' };
        }
        throw new CommandExecutionError('not found', 1, 'No such container');
      }),
    };
    await expect(new DockerContainerService({ runner, env: {} }).inspect(desired))
      .resolves.toMatchObject({ state: 'missing', dockerContext: 'default' });
    expect(calls.filter((args) => args[2] === 'info').map((args) => args[1])).toEqual(['desktop-linux', 'default']);
  });

  it.each([
    'tcp://remote.example:2376',
    'ssh://remote.example',
    'npipe:////remote.example/pipe/docker_engine',
    'npipe://remote.example/pipe/docker_engine',
    'npipe:////.remote.example/pipe/docker_engine',
    'npipe:////./pipe/',
    'npipe:////./pipe/docker_engine/extra',
  ])('refuses a configured remote or invalid endpoint %s before build, start, or removal', async (endpoint) => {
    const calls: string[][] = [];
    const runner: CommandRunner = {
      run: vi.fn(async (_file, args) => {
        calls.push(args);
        return { stdout: `${JSON.stringify(endpoint)}\n`, stderr: '' };
      }),
    };
    const result = await new DockerContainerService({
      runner,
      dockerContext: 'production',
    }).ensure(client(), desired);

    expect(result).toMatchObject({ status: 'error', code: 'docker_unavailable' });
    expect(result.status === 'error' && result.message).toContain('not local');
    expect(calls).toHaveLength(1);
    expect(calls[0]).toEqual([
      '--context', 'production', 'context', 'inspect', 'production',
      '--format', '{{json .Endpoints.docker.Host}}',
    ]);
  });

  it.each(['inspect', 'info'])('fails closed when an explicit context %s fails', async (failurePoint) => {
    const calls: string[][] = [];
    const runner: CommandRunner = {
      run: vi.fn(async (_file, args) => {
        calls.push(args);
        const command = args.slice(2);
        if ((failurePoint === 'inspect' && command[0] === 'context') || command[0] === failurePoint) {
          throw new CommandExecutionError(`${failurePoint} failed`, 1);
        }
        if (command[0] === 'context') return { stdout: '"unix:///configured/docker.sock"', stderr: '' };
        return { stdout: '"27.0.0"', stderr: '' };
      }),
    };
    await expect(new DockerContainerService({ runner, dockerContext: 'configured' }).inspect(desired))
      .resolves.toMatchObject({ state: 'error', dockerContext: null });
    expect(calls.every((args) => args[1] === 'configured')).toBe(true);
    expect(calls.some((args) => args[1] === 'desktop-linux')).toBe(false);
  });

  it('reuses a matching running container without removing it', async () => {
    const calls: string[][] = [];
    const inspect = [{
      Image: 'sha256:new',
      State: { Running: true },
      Config: {
        Image: 'clarinet-hero:local',
        Labels: { [MANAGED_LABEL]: 'true', [CLAIM_LABEL]: 'clarinet-hero' },
      },
      HostConfig: { PortBindings: { '80/tcp': [{ HostIp: '127.0.0.1', HostPort: '4173' }] } },
    }];
    const runner = localRunner(async (args) => {
      if (args[0] === 'image') return { stdout: 'sha256:new\n', stderr: '' };
      if (args[0] === 'container' && args[1] === 'inspect') {
        return { stdout: JSON.stringify(inspect), stderr: '' };
      }
      return { stdout: '', stderr: '' };
    }, calls);
    const result = await new DockerContainerService({ runner, readiness: async () => true })
      .ensure(client(), desired);
    expect(result).toMatchObject({ status: 'ready', action: 'reused' });
    expect(calls.some((args) => args.includes('rm'))).toBe(false);
    expect(calls.filter((args) => args.includes('run'))).toHaveLength(0);
  });

  it('refuses to replace an unrelated container with the managed name', async () => {
    const runner = localRunner(async (args) => {
      if (args[0] === 'image') return { stdout: 'sha256:new\n', stderr: '' };
      if (args[0] === 'container' && args[1] === 'inspect') {
        return { stdout: JSON.stringify([{ Image: 'sha256:old', Config: { Labels: {} } }]), stderr: '' };
      }
      return { stdout: '', stderr: '' };
    });
    const result = await new DockerContainerService({ runner }).ensure(client(), desired);
    expect(result).toMatchObject({ status: 'error', code: 'container_conflict' });
  });

  it('recreates a drifted managed container and starts a matching stopped one', async () => {
    const managed = {
      Image: 'sha256:old',
      State: { Running: true },
      Config: {
        Image: 'clarinet-hero:local',
        Labels: { [MANAGED_LABEL]: 'true', [CLAIM_LABEL]: 'clarinet-hero' },
      },
      HostConfig: { PortBindings: { '80/tcp': [{ HostIp: '127.0.0.1', HostPort: '4173' }] } },
    };
    const driftCalls: string[][] = [];
    const driftRunner = localRunner(async (args) => {
      if (args[0] === 'image') return { stdout: 'sha256:new\n', stderr: '' };
      if (args[0] === 'container' && args[1] === 'inspect') {
        return { stdout: JSON.stringify([managed]), stderr: '' };
      }
      return { stdout: '', stderr: '' };
    }, driftCalls);
    await expect(new DockerContainerService({
      runner: driftRunner,
      readiness: async () => true,
    }).ensure(client(), desired)).resolves.toMatchObject({ status: 'ready', action: 'recreated' });
    expect(driftCalls).toContainEqual([
      '--context', 'desktop-linux', 'container', 'rm', '--force', 'working-memory-clarinet-hero',
    ]);

    const stoppedRunner = localRunner(async (args) => {
      if (args[0] === 'image') return { stdout: 'sha256:new\n', stderr: '' };
      if (args[0] === 'container' && args[1] === 'inspect') {
        return { stdout: JSON.stringify([{ ...managed, Image: 'sha256:new', State: { Running: false } }]), stderr: '' };
      }
      return { stdout: '', stderr: '' };
    });
    const stoppedResult = await new DockerContainerService({
      runner: stoppedRunner,
      readiness: async () => true,
    }).ensure(client(), desired);
    expect(stoppedResult).toMatchObject({ status: 'ready', action: 'started' });
    expect(stoppedRunner.run).toHaveBeenCalledWith('docker', [
      '--context', 'desktop-linux', 'container', 'start', 'working-memory-clarinet-hero',
    ], expect.objectContaining({ timeoutMs: 30_000 }));
  });

  it('reports missing CLI, command timeout, and readiness timeout explicitly', async () => {
    const missing: CommandRunner = {
      run: vi.fn().mockRejectedValue(new CommandExecutionError('spawn docker ENOENT', 'ENOENT')),
    };
    await expect(new DockerContainerService({ runner: missing }).ensure(client(), desired))
      .resolves.toMatchObject({ status: 'error', code: 'docker_missing' });

    const timeout = localRunner(async (args, options) => {
      if (args[0] === 'build') throw new CommandTimeoutError(options!.timeoutMs);
      return { stdout: '', stderr: '' };
    });
    await expect(new DockerContainerService({
      runner: timeout,
      timeouts: { build: 123 },
    }).ensure(client(), desired)).resolves.toMatchObject({
      status: 'error',
      code: 'docker_timeout',
      message: expect.stringContaining('123ms'),
    });

    const runner = localRunner(async (args) => {
      if (args[0] === 'image') return { stdout: 'sha256:new\n', stderr: '' };
      if (args[0] === 'container' && args[1] === 'inspect') {
        throw new CommandExecutionError('not found', 1, 'No such container');
      }
      return { stdout: '', stderr: '' };
    });
    await expect(new DockerContainerService({
      runner,
      readiness: async () => false,
      retries: 1,
    }).ensure(client(), desired)).resolves.toMatchObject({
      status: 'error',
      code: 'readiness_timeout',
    });
  });

  it('inspects exact managed containers and reports live health', async () => {
      const runner = localRunner(async (args) => {
        if (args[0] === 'container' && args[1] === 'inspect') {
          return {
            stdout: JSON.stringify([{
              State: { Running: true },
              Config: {
                Image: 'clarinet-hero:local',
                Labels: { [MANAGED_LABEL]: 'true', [CLAIM_LABEL]: 'clarinet-hero' },
              },
              HostConfig: { PortBindings: { '80/tcp': [{ HostIp: '127.0.0.1', HostPort: '4173' }] } },
            }]),
            stderr: '',
          };
        }
        return { stdout: '', stderr: '' };
      });
      const status = await new DockerContainerService({ runner, readiness: async () => true }).inspect(desired);
      expect(status).toMatchObject({
        displayName: 'Clarinet Hero',
        claimId: 'clarinet-hero',
        state: 'healthy',
        ready: true,
        dockerContext: 'desktop-linux',
        url: 'http://localhost:4173/',
      });
  });

  it('stops only the exact healthy managed container without removing it', async () => {
      const calls: string[][] = [];
      const runner = localRunner(async (args) => {
        if (args[0] === 'container' && args[1] === 'inspect') {
          return {
            stdout: JSON.stringify([{
              State: { Running: true },
              Config: {
                Image: 'clarinet-hero:local',
                Labels: { [MANAGED_LABEL]: 'true', [CLAIM_LABEL]: 'clarinet-hero' },
              },
              HostConfig: { PortBindings: { '80/tcp': [{ HostIp: '127.0.0.1', HostPort: '4173' }] } },
            }]),
            stderr: '',
          };
        }
        return { stdout: '', stderr: '' };
      }, calls);
      const result = await new DockerContainerService({ runner, readiness: async () => true }).stop(desired);
      expect(result).toMatchObject({ status: 'stopped', detail: { state: 'stopped', lastAction: 'Stopped' } });
      expect(calls).toContainEqual(['--context', 'desktop-linux', 'container', 'stop', 'working-memory-clarinet-hero']);
      expect(calls.some((args) => args.includes('rm'))).toBe(false);
  });

  it('does not issue stop for missing or already stopped managed containers', async () => {
    const missingRunner = localRunner(async (args) => {
      if (args[0] === 'container' && args[1] === 'inspect') {
        throw new CommandExecutionError('not found', 1, 'No such container');
      }
      return { stdout: '', stderr: '' };
    });
    await expect(new DockerContainerService({ runner: missingRunner }).stop(desired))
      .resolves.toMatchObject({ status: 'missing', detail: { state: 'missing' } });
    expect(missingRunner.run).not.toHaveBeenCalledWith('docker', expect.arrayContaining(['stop']), expect.anything());

    const stoppedRunner = localRunner(async (args) => {
      if (args[0] === 'container' && args[1] === 'inspect') {
        return {
          stdout: JSON.stringify([{
            State: { Running: false },
            Config: {
              Image: 'clarinet-hero:local',
              Labels: { [MANAGED_LABEL]: 'true', [CLAIM_LABEL]: 'clarinet-hero' },
            },
            HostConfig: { PortBindings: { '80/tcp': [{ HostIp: '127.0.0.1', HostPort: '4173' }] } },
          }]),
          stderr: '',
        };
      }
      return { stdout: '', stderr: '' };
    });
    await expect(new DockerContainerService({ runner: stoppedRunner }).stop(desired))
      .resolves.toMatchObject({ status: 'already_stopped', detail: { state: 'stopped' } });
    expect(stoppedRunner.run).not.toHaveBeenCalledWith('docker', expect.arrayContaining(['stop']), expect.anything());
  });

  it('refuses unrelated containers but stops an exactly owned unhealthy running container', async () => {
      const unrelatedRunner = localRunner(async (args) => {
        if (args[0] === 'container' && args[1] === 'inspect') {
          return { stdout: JSON.stringify([{ State: { Running: true }, Config: { Image: 'other', Labels: {} } }]), stderr: '' };
        }
        return { stdout: '', stderr: '' };
      });
      await expect(new DockerContainerService({ runner: unrelatedRunner }).stop(desired))
        .resolves.toMatchObject({ status: 'error', detail: { state: 'error' } });
      expect(unrelatedRunner.run).not.toHaveBeenCalledWith('docker', expect.arrayContaining(['stop']), expect.anything());

      const unhealthyRunner = localRunner(async (args) => {
        if (args[0] === 'container' && args[1] === 'inspect') {
          return {
            stdout: JSON.stringify([{
              State: { Running: true, Health: { Status: 'unhealthy' } },
              Config: {
                Image: 'clarinet-hero:local',
                Labels: { [MANAGED_LABEL]: 'true', [CLAIM_LABEL]: 'clarinet-hero' },
              },
              HostConfig: { PortBindings: { '80/tcp': [{ HostIp: '127.0.0.1', HostPort: '4173' }] } },
            }]),
            stderr: '',
          };
        }
        return { stdout: '', stderr: '' };
      });
      await expect(new DockerContainerService({ runner: unhealthyRunner }).stop(desired))
        .resolves.toMatchObject({ status: 'stopped', detail: { state: 'stopped' } });
      expect(unhealthyRunner.run).toHaveBeenCalledWith(
        'docker',
        expect.arrayContaining(['container', 'stop', 'working-memory-clarinet-hero']),
        expect.anything(),
      );
  });
});

describe('ExecFileCommandRunner', () => {
  it('terminates a subprocess at its operation timeout', async () => {
    await expect(new ExecFileCommandRunner().run(
      process.execPath,
      ['-e', 'setTimeout(() => {}, 1000)'],
      { timeoutMs: 20 },
    )).rejects.toMatchObject({ code: 'ETIMEDOUT', timeoutMs: 20 });
  });
});

describe('claim-owned container isolation', () => {
  const banking = CONTAINER_APP_FIXTURES[1];

  it('cannot stop another app container when given the banking definition', async () => {
      const bankingDesired: ContainerClaimCreateInput = {
        id: banking.id,
        title: banking.displayName,
        repository: '/repo/BankingApp',
        runtime: {
          ...banking.runtime,
          buildContext: '/repo/BankingApp',
          dockerfile: '/repo/BankingApp/Dockerfile',
        },
      };
      const calls: string[][] = [];
      const runner = localRunner(async (args) => {
        if (args[0] === 'container' && args[1] === 'inspect') {
          expect(args[2]).toBe('working-memory-banking-app');
          return {
            stdout: JSON.stringify([{
              State: { Running: true },
              Config: {
                Image: 'banking-app:local',
                Labels: { [MANAGED_LABEL]: 'true', [CLAIM_LABEL]: 'banking-app' },
              },
              HostConfig: { PortBindings: { '4174/tcp': [{ HostIp: '127.0.0.1', HostPort: '4174' }] } },
              Mounts: [{
                Type: 'volume',
                Name: 'working-memory-banking-app-data',
                Destination: '/data',
              }],
            }]),
            stderr: '',
          };
        }
        return { stdout: '', stderr: '' };
      }, calls);
      await expect(new DockerContainerService({ runner, readiness: async () => true }).stop(bankingDesired))
        .resolves.toMatchObject({ status: 'stopped' });
      expect(calls).toContainEqual([
        '--context', 'desktop-linux', 'container', 'stop', 'working-memory-banking-app',
      ]);
      expect(calls.flat()).not.toContain('working-memory-clarinet-hero');
  });
});
