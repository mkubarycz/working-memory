import { describe, expect, it, vi } from 'vitest';
import {
  CLAIM_LABEL,
  CommandExecutionError,
  CommandTimeoutError,
  DockerContainerService,
  ExecFileCommandRunner,
  MANAGED_LABEL,
  resolveClarinetHeroClaim,
  type ClaimClient,
  type CommandRunner,
} from '../src/main/dockerContainerService';
import type { ContainerClaimCreateInput } from '../../src/controlPlaneClient';

const desired: ContainerClaimCreateInput = {
  slug: 'clarinet-hero',
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
): CommandRunner {
  return {
    run: vi.fn(async (_file, args, options) => {
      calls.push(args);
      const command = args.slice(2);
      if (command[0] === 'context') return { stdout: '"unix:///local/docker.sock"\n', stderr: '' };
      if (command[0] === 'info') return { stdout: '"27.0.0"\n', stderr: '' };
      return handler(command, options);
    }),
  };
}

describe('DockerContainerService', () => {
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

  it('refuses a configured remote context before build, start, or removal', async () => {
    const calls: string[][] = [];
    const runner: CommandRunner = {
      run: vi.fn(async (_file, args) => {
        calls.push(args);
        return { stdout: '"tcp://remote.example:2376"\n', stderr: '' };
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
        displayName: 'Claranet Hero',
        claimSlug: 'clarinet-hero',
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

describe('resolveClarinetHeroClaim', () => {
  const validPaths = (root: string) => (path: string) => {
    if (path === root) return 'directory' as const;
    if (path === `${root}/Dockerfile` || path === `${root}/package.json`) return 'file' as const;
    return null;
  };

  it('preserves an existing claim with a valid runtime', () => {
    const existing = claim({
      repository: '/saved/source',
      runtime: { ...desired.runtime, buildContext: '/saved/source', dockerfile: '/saved/source/Dockerfile' },
    });
    const resolved = resolveClarinetHeroClaim(existing, { pathKind: validPaths('/saved/source') });
    expect(resolved.repository).toBe('/saved/source');
    expect(resolved.runtime).toEqual(existing.runtime);
  });

  it('prefers a configured source and reports every checked candidate when none is valid', () => {
    const configured = resolveClarinetHeroClaim(undefined, {
      configuredPath: '/configured/source',
      cwd: '/workspace',
      pathKind: validPaths('/configured/source'),
    });
    expect(configured.repository).toBe('/configured/source');

    expect(() => resolveClarinetHeroClaim(undefined, {
      configuredPath: '/missing/source',
      cwd: '/workspace',
      searchRoots: ['/another/missing'],
      pathKind: () => null,
    })).toThrow(/CLARINET_HERO_SOURCE.*\/missing\/source.*\/another\/missing/);
  });
});
