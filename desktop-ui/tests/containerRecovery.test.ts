import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ContainerProviderAdapter } from '../src/main/containerProvider';
import { checkContainerOwnership, ownershipFileName, readContainerOwnership } from '../src/main/containerOwnership';
import { assertNoInterruptedRecovery, commitRecoveryMetadata, metadataFile, restoreInterruptedRecovery } from '../src/main/containerRecovery';
import { DataTierManager, dataTierInstanceNames } from '../src/main/dataTier';
import { CLAIM_LABEL, DockerContainerService, MANAGED_LABEL, type CommandRunner } from '../src/main/dockerContainerService';
import type { ContainerClaim } from '../../shared/controlPlaneClient';
import { ObservabilityContainer, OPENOBSERVE_IMAGE, observabilityAppId } from '../src/main/observabilityContainer';
import type { ObservabilityStatus } from '../../control-plane/src/observability';
import type { ClaimClient } from '../src/main/dockerContainerService';

const directories: string[] = [];
function directory(): string {
  const path = mkdtempSync(join(tmpdir(), 'wm-recovery-test-'));
  directories.push(path);
  return path;
}
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  for (const path of directories.splice(0)) rmSync(path, { recursive: true, force: true });
});

const digest = 'a'.repeat(64);
const imageId = `sha256:${'b'.repeat(64)}`;
const image = `registry.example/team/app:v1.2.3@sha256:${digest}`;
const canonical = `registry.example/team/app@sha256:${digest}`;
const selected = 'replacement (2026-11-12; user/run/user/1000/podman/podman.sock)';
const oldOwner = { provider: 'podman' as const, connection: 'original machine' };
const owner = { provider: 'podman' as const, connection: selected };
const host = { platform: 'win32' as const, homedir: 'C:\\Users\\test', env: {} };

function providerRunner(handler: (args: string[]) => string): { runner: CommandRunner; calls: string[][] } {
  const calls: string[][] = [];
  return {
    calls,
    runner: { run: vi.fn(async (_file, args) => {
      if (args[0] === 'system') return { stdout: JSON.stringify([{
        Name: 'replacement', URI: 'ssh://user@127.0.0.1:5000/run/user/1000/podman/podman.sock',
        Default: true, IsMachine: true, Identity: '/local/test-key',
      }]), stderr: '' };
      if (args[0] === 'machine') return { stdout: JSON.stringify([{
        Name: 'replacement', Created: '2026-11-12', State: 'running',
        SSHConfig: { Port: 5000, IdentityPath: '/local/test-key', RemoteUsername: 'user' },
      }]), stderr: '' };
      expect(args.slice(0, 2)).toEqual(['--connection', 'replacement']);
      const command = args.slice(2);
      calls.push(command);
      return { stdout: command[0] === 'info' ? '{}' : handler(command), stderr: '' };
    }) },
  };
}

function appFixture(privateEnvironment?: (claim: ContainerClaim) => Promise<Record<string, string>>) {
  const dir = directory();
  const claim: ContainerClaim = {
    id: 'test-claim', title: 'Test app', repository: 'https://example.invalid/app',
    created_at: 1, updated_at: 1, resourceVersion: 1,
    runtime: {
      type: 'docker', imageSource: 'registry', imageName: image, containerName: 'wm-test-app',
      hostPort: 64419, containerPort: 5080, healthPath: '/healthz', entryPath: '/',
      volumes: [{ name: 'wm-test-app-data', mountPath: '/data' }],
      environment: { PUBLIC_SETTING: 'true' }, network: 'wm_default',
      restartPolicy: 'unless-stopped', memoryMb: 768, cpus: 1,
    },
  };
  const current = {
    Id: 'container-id', Name: '/wm-test-app', Image: imageId,
    Config: { Image: canonical, Labels: { [MANAGED_LABEL]: 'true', [CLAIM_LABEL]: claim.id },
      Env: ['PUBLIC_SETTING=true', 'PRIVATE_SETTING=retained-secret'] },
    State: { Running: true, Health: { Status: 'healthy' } },
    Mounts: [{ Type: 'volume', Name: 'wm-test-app-data', Destination: '/data' }],
    HostConfig: { PortBindings: { '5080/tcp': [{ HostIp: '127.0.0.1', HostPort: '64419' }] },
      RestartPolicy: { Name: 'unless-stopped' }, Memory: 768 * 1024 * 1024, NanoCpus: 1e9 },
    NetworkSettings: { Networks: { wm_default: {} } },
  };
  let candidates = 'container-id';
  const { runner, calls } = providerRunner(args => {
    if (args[0] === 'container' && args[1] === 'ls') return candidates;
    if (args[0] === 'container' && args[1] === 'inspect') return JSON.stringify([current]);
    if (args[0] === 'image' && args[1] === 'inspect') return imageId;
    if (args[0] === 'volume' && args[1] === 'inspect') return '[{}]';
    throw new Error(`Unexpected command: ${args.join(' ')}`);
  });
  const resources = [claim.id, 'volume:wm-test-app-data', `pending-volume:${claim.id}:wm-test-app-data`];
  for (const resource of resources) checkContainerOwnership(dir, resource, oldOwner, true);
  const service = new DockerContainerService({
    provider: 'podman', stateDirectory: dir, runner, readiness: async () => true,
    privateEnvironment: () => privateEnvironment?.(claim) ?? Promise.resolve({ PRIVATE_SETTING: 'retained-secret' }),
  });
  return { dir, claim, current, calls, resources, service, candidates: (value: string) => { candidates = value; } };
}

describe('explicit Container App recovery', () => {
  it('classifies ownership failures without claiming the provider is down', async () => {
    const { service, claim, calls } = appFixture();
    expect(await service.launch(claim)).toMatchObject({ status: 'error', code: 'provider_conflict' });
    expect(await service.inspect(claim)).toMatchObject({ recoveryAvailable: true, state: 'error' });
    expect(calls.every(args => args[0] === 'info')).toBe(true);
  });

  it('recovers all three bindings only after approval and reuses the canonical pinned image', async () => {
    const { service, claim, resources, dir, calls } = appFixture();
    const confirm = vi.fn(async preview => {
      expect(preview.detail).toContain('wm-test-app-data');
      expect(preview.detail).toContain(selected);
      expect(preview.detail).not.toContain('retained-secret');
      for (const resource of resources) expect(readContainerOwnership(dir, resource)).toEqual(oldOwner);
      return true;
    });
    expect(await service.recover(claim, confirm)).toBe(true);
    for (const resource of resources) expect(readContainerOwnership(dir, resource)).toEqual(owner);
    expect(readdirSync(join(dir, 'recovery-backups'))).toHaveLength(1);
    expect(existsSync(join(dir, 'ownership-recovery.json'))).toBe(false);
    expect(await service.inspect(claim)).toMatchObject({ ready: true });
    expect(await service.launch(claim)).toMatchObject({ status: 'ready', action: 'reused' });
    expect(calls.some(args => args.some(value => ['run', 'start', 'stop', 'rm', 'create', 'pull', 'build'].includes(value)))).toBe(false);
  });

  it('does not rebind anything when cancelled', async () => {
    const { service, claim, resources, dir } = appFixture();
    expect(await service.recover(claim, async () => false)).toBe(false);
    for (const resource of resources) expect(readContainerOwnership(dir, resource)).toEqual(oldOwner);
    expect(existsSync(join(dir, 'recovery-backups'))).toBe(false);
  });

  it.each(['missing', 'ambiguous', 'label', 'image-content', 'digest', 'repository', 'volume', 'extra-mount',
    'port', 'environment', 'private-environment', 'network', 'limits', 'provider'] as const)(
    'rejects an unverified destination before confirmation: %s', async fault => {
      const f = appFixture();
      if (fault === 'missing') f.candidates('');
      if (fault === 'ambiguous') f.candidates('one\ntwo');
      if (fault === 'label') f.current.Config.Labels[CLAIM_LABEL] = 'other-claim';
      if (fault === 'image-content') f.current.Image = `sha256:${'c'.repeat(64)}`;
      if (fault === 'digest') f.current.Config.Image = canonical.replace(digest, 'd'.repeat(64));
      if (fault === 'repository') f.current.Config.Image = canonical.replace('/team/', '/other/');
      if (fault === 'volume') f.current.Mounts[0].Name = 'unrelated-data';
      if (fault === 'extra-mount') f.current.Mounts.push({ Type: 'volume', Name: 'extra', Destination: '/extra' });
      if (fault === 'port') f.current.HostConfig.PortBindings['5080/tcp'][0].HostIp = '0.0.0.0';
      if (fault === 'environment') f.current.Config.Env = ['PUBLIC_SETTING=false', 'PRIVATE_SETTING=retained-secret'];
      if (fault === 'private-environment') f.current.Config.Env = ['PUBLIC_SETTING=true'];
      if (fault === 'network') f.current.NetworkSettings.Networks = {};
      if (fault === 'limits') f.current.HostConfig.Memory = 0;
      if (fault === 'provider') writeFileSync(join(f.dir, ownershipFileName(f.claim.id)), JSON.stringify({ ...oldOwner, provider: 'docker' }));
      const confirm = vi.fn(async () => true);
      const before = f.resources.map(resource => readFileSync(join(f.dir, ownershipFileName(resource)), 'utf8'));
      await expect(f.service.recover(f.claim, confirm)).rejects.toThrow();
      expect(confirm).not.toHaveBeenCalled();
      expect(f.resources.map(resource => readFileSync(join(f.dir, ownershipFileName(resource)), 'utf8'))).toEqual(before);
    });

  it('rechecks after approval and rejects container or metadata changes', async () => {
    const f = appFixture();
    await expect(f.service.recover(f.claim, async () => {
      f.current.Id = 'replacement-during-confirmation';
      return true;
    })).rejects.toThrow('changed during confirmation');
    await expect(f.service.recover(f.claim, async () => {
      writeFileSync(join(f.dir, ownershipFileName(f.claim.id)), JSON.stringify({ ...oldOwner, connection: 'changed' }));
      return true;
    })).rejects.toThrow('metadata changed');
  });

  it('accepts raw image IDs only after resolving the registered local image content', async () => {
    const f = appFixture();
    f.current.Config.Image = imageId.replace('sha256:', '');
    expect(await f.service.recover(f.claim, async () => true)).toBe(true);
    expect(await f.service.inspect(f.claim)).toMatchObject({ ready: true });
    f.current.Config.Image = 'c'.repeat(64);
    expect(await f.service.inspect(f.claim)).toMatchObject({ ready: false, error: expect.stringContaining('does not match') });
  });

  it('completes observability enablement after recovery through real service matching and authenticated bootstrap', async () => {
    const url = 'http://127.0.0.1:7719/mcp';
    const credentials = { username: 'test@example.invalid', password: 'a-retained-password-with-at-least-32-characters' };
    const vault = { available: () => true, read: vi.fn(async () => JSON.stringify(credentials)), save: vi.fn() };
    const status: ObservabilityStatus = {
      enabled: false, configured: true, uiUrl: null, claimId: null, retentionDays: 7, exportIntervalMs: 10000,
      lastSuccessAt: null, lastError: null, pendingLogs: 0, droppedLogs: 0, droppedSeries: 0,
    };
    const identity = {
      observability: vi.fn(async (_url: string, configuration?: unknown) => {
        if (configuration) expect(configuration).toMatchObject(credentials);
        return status;
      }),
      setFeatures: vi.fn(async () => ({ hostTasks: false, search: false, observability: true })),
    };
    const observability = new ObservabilityContainer(vault, identity);
    const f = appFixture(claim => observability.privateEnvironment(url, claim));
    const id = observabilityAppId(url);
    const runtime = f.claim.runtime!;
    Object.assign(f.claim, { title: 'Working Memory Observability', repository: 'https://github.com/openobserve/openobserve',
      application: { id, contractVersion: '1.0', discovery: { toolName: 'not-supported' }, capabilities: [],
        dataOwnership: 'application', uiUrl: `http://localhost:${runtime.hostPort}/web/` },
      desktop: { icon: 'pulse', embeddable: true } });
    Object.assign(runtime, { imageName: OPENOBSERVE_IMAGE, containerName: id, entryPath: '/web/',
      environment: { ZO_DATA_DIR: '/data', ZO_LOCAL_MODE: 'true', ZO_TELEMETRY: 'false',
        ZO_COMPACT_DATA_RETENTION_DAYS: '7', ZO_COOKIE_SAME_SITE_LAX: 'true' },
      volumes: [{ name: `${id}-data`, mountPath: '/data' }] });
    f.current.Name = `/${id}`;
    f.current.Config.Image = OPENOBSERVE_IMAGE.replace(':v1.1.2@', '@');
    f.current.Config.Env = [...Object.entries(runtime.environment!).map(([key, value]) => `${key}=${value}`),
      `ZO_ROOT_USER_EMAIL=${credentials.username}`, `ZO_ROOT_USER_PASSWORD=${credentials.password}`];
    f.current.Mounts[0].Name = `${id}-data`;
    const client: ClaimClient = {
      containerClaimRead: vi.fn(async () => [f.claim]),
      containerClaimCreate: vi.fn(async () => { throw new Error('Must not create a replacement claim'); }),
      containerClaimUpdate: vi.fn(async input => Object.assign(f.claim, input)),
    };
    const fetch = vi.fn(async (_input: string | URL | Request, options?: RequestInit) => {
      expect(options?.headers).toMatchObject({
        Authorization: `Basic ${Buffer.from(`${credentials.username}:${credentials.password}`).toString('base64')}`,
      });
      return Response.json({ dashboards: [{ title: 'Working Memory diagnostics' }] });
    });
    vi.stubGlobal('fetch', fetch);
    expect(await f.service.recover(f.claim, async () => true)).toBe(true);
    expect(await observability.change(url, { observability: true }, client, {
      backendNetwork: async () => 'wm_default', ensure: f.service.ensure.bind(f.service), stop: f.service.stop.bind(f.service),
    }, () => {})).toMatchObject({ observability: true });
    expect(fetch).toHaveBeenCalledOnce();
    expect(identity.observability).toHaveBeenLastCalledWith(url, expect.objectContaining({ claimId: f.claim.id, ...credentials }));
    expect(vault.save).not.toHaveBeenCalled();
    expect(f.calls.some(args => args[0] === 'container' && ['run', 'rm', 'start', 'stop'].includes(args[1]))).toBe(false);
  });
});

function backendFixture() {
  const dir = directory();
  const instances = [7719, 7720].map(port => ({
    port, name: `Backend ${port}`, createdAt: '', image: 'ghcr.io/mkubarycz/working-memory-control-plane:1.10.0', ...oldOwner,
  }));
  writeFileSync(join(dir, 'instances.json'), JSON.stringify({ instances }));
  checkContainerOwnership(join(dir, 'ownership'), 'data-tier', oldOwner, true);
  const containers = instances.map(instance => {
    const names = dataTierInstanceNames(instance.port);
    return {
      Id: `backend-${instance.port}`, Name: `/${names.container}`, Image: imageId,
      Config: { Image: imageId.replace('sha256:', ''), Labels: {
        'com.docker.compose.project': names.project, 'com.docker.compose.service': 'control-plane',
      } },
      Mounts: [{ Type: 'volume', Name: names.volume, Source: '/engine/volume', Destination: '/data' }],
      State: { Running: true },
      NetworkSettings: { Ports: { [`${instance.port}/tcp`]: [{ HostIp: '127.0.0.1', HostPort: String(instance.port) }] } },
    };
  });
  const { runner, calls } = providerRunner(args => {
    if (args[0] === 'ps') {
      if (args.includes('label=com.docker.compose.service=control-plane')) return containers.map(c => c.Name.slice(1)).join('\n');
      return containers.map(c => `${c.Name.slice(1)}\trunning\tUp (healthy)\t${c.Config.Image}`).join('\n');
    }
    if (args[0] === 'inspect') return JSON.stringify(containers.filter(c => args.slice(1).includes(c.Name.slice(1))));
    if (args[0] === 'image' && args[1] === 'inspect') return imageId;
    if (args[0] === 'volume' && args[1] === 'inspect') return '[{}]';
    if (args[0] === 'exec') return args.at(-1)?.includes('instance-bootstrap.secret') ? 'a'.repeat(48) : '';
    if (args[0] === 'compose' && args[1] === 'version') return 'Compose test';
    throw new Error(`Unexpected command: ${args.join(' ')}`);
  });
  const manager = new DataTierManager({ ...host, provider: 'podman', version: '1.11.0',
    stateDirectory: dir, buildContext: dir, fileExists: () => true, runner, healthy: async () => true });
  return { manager, dir, calls, containers, instances };
}

describe('explicit backend recovery', () => {
  it('preserves ownership classification and transfers global and all instance bindings together', async () => {
    const f = backendFixture();
    expect(await f.manager.list()).toMatchObject({ recoveryAvailable: true,
      dockerError: expect.not.stringContaining('Podman is unavailable'),
      instances: [{ version: null }, { version: null }] });
    await expect(f.manager.upgrade(7719)).rejects.toMatchObject({ code: 'provider-conflict' });
    expect(await f.manager.recover(async preview => {
      expect(preview.detail).toContain('Backend 7719');
      expect(preview.detail).toContain('Backend 7720');
      expect(f.manager.instances[0].connection).toBe(oldOwner.connection);
      return true;
    })).toBe(true);
    expect(readContainerOwnership(join(f.dir, 'ownership'), 'data-tier')).toEqual(owner);
    expect(f.manager.instances.every(instance => instance.connection === selected)).toBe(true);
    expect(await f.manager.list()).toMatchObject({ dockerError: null,
      instances: [{ state: 'running', version: '1.10.0', updateAvailable: true }, { version: '1.10.0' }] });
    expect(await f.manager.bootstrapCredential(7719)).toBe('a'.repeat(48));
    expect(f.calls.some(args => args.some(value => ['up', 'start', 'stop', 'create', 'pull', 'load', 'rm'].includes(value)))).toBe(false);
  });

  it('recognizes a per-instance-only conflict and does not change it on cancellation', async () => {
    const f = backendFixture();
    writeFileSync(join(f.dir, 'ownership', ownershipFileName('data-tier')), JSON.stringify(owner));
    expect(await f.manager.list()).toMatchObject({ recoveryAvailable: true,
      dockerError: expect.stringContaining('selected connection differs') });
    expect(await f.manager.recover(async () => false)).toBe(false);
    expect(f.manager.instances[0].connection).toBe(oldOwner.connection);
  });

  it.each(['volume', 'image', 'label', 'loopback', 'missing', 'changed'] as const)(
    'refuses unsafe backend recovery without changing registrations: %s', async fault => {
      const f = backendFixture();
      if (fault === 'volume') f.containers[1].Mounts[0].Name = 'other';
      if (fault === 'image') f.containers[1].Image = 'c'.repeat(64);
      if (fault === 'label') f.containers[1].Config.Labels['com.docker.compose.project'] = 'other';
      if (fault === 'loopback') f.containers[1].NetworkSettings.Ports['7720/tcp'][0].HostIp = '0.0.0.0';
      if (fault === 'missing') f.containers.pop();
      const registrations = readFileSync(join(f.dir, 'instances.json'), 'utf8');
      await expect(f.manager.recover(async () => {
        if (fault === 'changed') f.containers[0].Id = 'changed-container';
        return true;
      })).rejects.toThrow();
      expect(readFileSync(join(f.dir, 'instances.json'), 'utf8')).toBe(registrations);
      expect(readContainerOwnership(join(f.dir, 'ownership'), 'data-tier')).toEqual(oldOwner);
    });
});

describe('recoverable metadata commits', () => {
  it('retains the original metadata backup and requires approval to roll back an interrupted commit', async () => {
    const dir = directory();
    writeFileSync(join(dir, 'instances.json'), 'before');
    const files = [metadataFile(dir, 'instances.json', 'after'), metadataFile(dir, 'new.json', 'new')];
    const backup = commitRecoveryMetadata(dir, files);
    expect(JSON.parse(readFileSync(backup, 'utf8')).files[0].before).toBe('before');
    writeFileSync(join(dir, 'ownership-recovery.json'), JSON.stringify({ files }));
    expect(() => assertNoInterruptedRecovery(dir)).toThrow('interrupted');
    expect(await restoreInterruptedRecovery(dir, async () => false)).toBe(false);
    expect(readFileSync(join(dir, 'instances.json'), 'utf8')).toBe('after');
    expect(await restoreInterruptedRecovery(dir, async () => true)).toBe(true);
    expect(readFileSync(join(dir, 'instances.json'), 'utf8')).toBe('before');
    expect(existsSync(join(dir, 'new.json'))).toBe(false);
    expect(() => assertNoInterruptedRecovery(dir)).not.toThrow();
  });

  it('rejects transaction paths outside the ownership directory', () => {
    expect(() => metadataFile(directory(), '../outside.json', 'x')).toThrow();
  });

  it('does not overwrite external edits while restoring interrupted metadata', async () => {
    const dir = directory();
    writeFileSync(join(dir, 'instances.json'), 'before');
    const files = [metadataFile(dir, 'instances.json', 'after')];
    writeFileSync(join(dir, 'ownership-recovery.json'), JSON.stringify({ files }));
    await expect(restoreInterruptedRecovery(dir, async () => {
      writeFileSync(join(dir, 'instances.json'), 'external edit');
      return true;
    })).rejects.toThrow('changed during confirmation');
    expect(readFileSync(join(dir, 'instances.json'), 'utf8')).toBe('external edit');
    await expect(restoreInterruptedRecovery(dir, async () => true)).rejects.toThrow('edited outside');
  });
});

describe('conservative Podman pinned references', () => {
  it('normalizes only the same repository and digest, leaving Docker and arbitrary IDs unchanged', () => {
    const { runner } = providerRunner(() => '');
    const podman = new ContainerProviderAdapter({ provider: 'podman', host, runner });
    const docker = new ContainerProviderAdapter({ provider: 'docker', host, runner });
    expect(podman.imageReference(canonical, image)).toBe(image);
    for (const changed of [canonical.replace('/team/', '/other/'), canonical.replace(digest, 'c'.repeat(64)), imageId]) {
      expect(podman.imageReference(changed, image)).toBe(changed);
    }
    expect(docker.imageReference(canonical, image)).toBe(canonical);
  });
});
