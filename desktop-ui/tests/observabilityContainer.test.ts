import { randomUUID } from 'node:crypto';
import { afterEach, expect, it, vi } from 'vitest';
import type { ContainerClaim } from '../../shared/controlPlaneClient';
import type { ObservabilityStatus } from '../../control-plane/src/observability';
import { ObservabilityContainer, OPENOBSERVE_IMAGE, observabilityAppId } from '../src/main/observabilityContainer';
import type { ClaimClient, DockerContainerService } from '../src/main/dockerContainerService';
import type { DesktopInstanceIdentity } from '../src/main/instanceIdentity';

afterEach(() => vi.unstubAllGlobals());
const mcpUrl = 'http://127.0.0.1:7719/mcp';
function setup() {
  const status: ObservabilityStatus = {
    enabled: false, configured: false, uiUrl: null, claimId: null, retentionDays: 7,
    exportIntervalMs: 10000, lastSuccessAt: null, lastError: null, pendingLogs: 0, droppedLogs: 0, droppedSeries: 0,
  };
  const claims: ContainerClaim[] = [];
  let secret: string | null = null;
  const vault = { available: () => true, read: vi.fn(async () => secret),
    save: vi.fn(async (_origin: string, value: string) => { secret = value; }) };
  const identity: Pick<DesktopInstanceIdentity, 'observability' | 'setFeatures'> = {
    observability: vi.fn(async (_url, config) => {
      if (config) Object.assign(status, { configured: true, claimId: config.claimId, uiUrl: config.uiUrl });
      return { ...status };
    }),
    setFeatures: vi.fn(async (_url, flags) => {
      status.enabled = flags.observability ?? false;
      return { hostTasks: false, search: false, observability: status.enabled };
    }),
  };
  const client: ClaimClient = {
    containerClaimRead: vi.fn(async () => claims),
    containerClaimCreate: vi.fn(), containerClaimUpdate: vi.fn(),
  };
  const stop = vi.fn<DockerContainerService['stop']>();
  const service: Pick<DockerContainerService, 'backendNetwork' | 'ensure' | 'stop'> = {
    backendNetwork: vi.fn(async () => 'working-memory_default'),
    ensure: vi.fn(async (_client, desired) => {
      const claim: ContainerClaim = { ...desired, id: desired.id ?? randomUUID(),
        created_at: 1, updated_at: 1, resourceVersion: 1 };
      claims.splice(0, claims.length, claim);
      return { status: 'ready', claim, action: 'created', url: `http://localhost:${claim.runtime!.hostPort}/web/` };
    }),
    stop,
  };
  vi.stubGlobal('fetch', vi.fn(async () => Response.json({ dashboards: [] })));
  const manager = new ObservabilityContainer(vault, identity);
  return { manager, vault, identity, client, service, stop, claims, status };
}

it('generates credentials once, keeps them out of claims, configures before enabling and reuses the data volume', async () => {
  const { manager, vault, identity, client, service, claims } = setup();
  await manager.change(mcpUrl, { observability: true }, client, service, () => {});
  const claim = claims[0];
  const privateEnv = await manager.privateEnvironment(mcpUrl, claim);
  expect(privateEnv.ZO_ROOT_USER_PASSWORD.length).toBeGreaterThanOrEqual(32);
  expect(privateEnv.ZO_ROOT_USER_PASSWORD).toMatch(/^(?=.*[a-z])(?=.*[A-Z])(?=.*\d)(?=.*[^a-zA-Z0-9]).{8,128}$/);
  expect(JSON.stringify(claim)).not.toContain(privateEnv.ZO_ROOT_USER_PASSWORD);
  expect(claim.runtime).toMatchObject({ imageName: OPENOBSERVE_IMAGE, imageSource: 'registry',
    network: 'working-memory_default', environment: { ZO_TELEMETRY: 'false', ZO_COMPACT_DATA_RETENTION_DAYS: '7' } });
  const originalVolume = claim.runtime!.volumes;
  await manager.change(mcpUrl, { observability: true }, client, service, () => {});
  expect(vault.save).toHaveBeenCalledTimes(1);
  expect(claims[0].runtime!.volumes).toEqual(originalVolume);
  expect(vi.mocked(identity.observability).mock.invocationCallOrder[1])
    .toBeLessThan(vi.mocked(identity.setFeatures).mock.invocationCallOrder[0]);
});

it('disables export before stopping and reports a failed stop without claiming success', async () => {
  const { manager, identity, client, service, stop, status } = setup();
  await manager.change(mcpUrl, { observability: true }, client, service, () => {});
  stop.mockRejectedValueOnce(new Error('Engine unavailable'));
  await expect(manager.change(mcpUrl, { observability: false }, client, service, () => {})).rejects.toThrow('Engine unavailable');
  expect(status.enabled).toBe(false);
  expect(vi.mocked(identity.setFeatures).mock.invocationCallOrder.at(-1)).toBeLessThan(stop.mock.invocationCallOrder[0]);
});

it('refuses secrets for another instance or an edited image', async () => {
  const { manager, client, service, claims } = setup();
  await manager.change(mcpUrl, { observability: true }, client, service, () => {});
  await expect(manager.privateEnvironment('http://127.0.0.1:7717/mcp', claims[0])).rejects.toThrow('another instance');
  const changed: ContainerClaim = { ...claims[0], runtime: { ...claims[0].runtime!, imageName: 'untrusted:latest' } };
  await expect(manager.privateEnvironment(mcpUrl, changed)).rejects.toThrow('unrecognized image');
  expect(observabilityAppId(mcpUrl)).not.toBe(observabilityAppId('http://127.0.0.1:7717/mcp'));
});

it('does not enable export when baseline setup fails or selection changes', async () => {
  const { manager, identity, client, service } = setup();
  vi.stubGlobal('fetch', vi.fn(async () => new Response('', { status: 503 })));
  await expect(manager.change(mcpUrl, { observability: true }, client, service, () => {})).rejects.toThrow('HTTP 503');
  expect(identity.setFeatures).not.toHaveBeenCalled();
  await expect(manager.change(mcpUrl, { observability: true }, client, service, () => {
    throw new Error('Selected environment changed');
  })).rejects.toThrow('environment changed');
  expect(identity.setFeatures).not.toHaveBeenCalled();
});

it('never silently recreates credentials for registered telemetry storage', async () => {
  const { manager, vault, identity, client, service } = setup();
  await manager.change(mcpUrl, { observability: true }, client, service, () => {});
  vault.read.mockResolvedValueOnce(null);
  await expect(manager.change(mcpUrl, { observability: true }, client, service, () => {})).rejects.toThrow('credentials are missing');
  expect(vault.save).toHaveBeenCalledTimes(1);
  expect(identity.setFeatures).toHaveBeenCalledTimes(1);
});
