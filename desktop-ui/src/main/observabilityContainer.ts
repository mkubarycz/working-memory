import { createHash, randomBytes } from 'node:crypto';
import { createServer } from 'node:net';
import { z } from 'zod';
import type { ContainerClaim } from '../../../shared/controlPlaneClient';
import type { InstanceFeatures, InstanceFeatureUpdate } from '../../../control-plane/src/instanceFeatures';
import type { DesktopInstanceIdentity } from './instanceIdentity';
import type { DockerContainerService, ClaimClient } from './dockerContainerService';
import type { NativeInstanceCredentialVault } from './instancePasswordVault';
import { observabilityDashboard } from '../../../shared/observabilityDashboard';

export const OPENOBSERVE_IMAGE = 'public.ecr.aws/zinclabs/openobserve:v1.1.2@sha256:4a154849432f75c4fb024de32fe34163c02406c905dab22bf8d213d2e3386392';
const OPENOBSERVE_ENVIRONMENT = {
  ZO_DATA_DIR: '/data', ZO_LOCAL_MODE: 'true', ZO_TELEMETRY: 'false',
  ZO_COMPACT_DATA_RETENTION_DAYS: '7', ZO_COOKIE_SAME_SITE_LAX: 'true',
};
const credentialsSchema = z.object({ username: z.string().email(), password: z.string().min(32) }).strict();
export type ObservabilityCredentials = z.infer<typeof credentialsSchema>;

export function observabilityAppId(mcpUrl: string): string {
  return `wm-observability-${createHash('sha256').update(new URL(mcpUrl).origin).digest('hex').slice(0, 16)}`;
}
export function isObservabilityClaim(claim: ContainerClaim): boolean {
  return claim.application?.id.startsWith('wm-observability-') === true;
}

export class ObservabilityContainer {
  private changing = false;
  constructor(private readonly vault: Pick<NativeInstanceCredentialVault, 'read' | 'save' | 'available'>,
    private readonly identity: Pick<DesktopInstanceIdentity, 'observability' | 'setFeatures'>) {}

  async credentials(mcpUrl: string): Promise<ObservabilityCredentials> {
    const saved = await this.vault.read(new URL(mcpUrl).origin);
    if (!saved) throw new Error("OpenObserve credentials are missing from native secure storage. Restore this device's saved credentials; existing telemetry storage will not be reset.");
    return credentialsSchema.parse(JSON.parse(saved));
  }

  async privateEnvironment(mcpUrl: string, claim: ContainerClaim): Promise<Record<string, string>> {
    if (!isObservabilityClaim(claim)) return {};
    if (claim.application?.id !== observabilityAppId(mcpUrl)) throw new Error('Observability belongs to another instance.');
    if (claim.runtime?.imageName !== OPENOBSERVE_IMAGE || claim.runtime.imageSource !== 'registry') {
      throw new Error('Refusing to pass private observability credentials to an unrecognized image.');
    }
    if (JSON.stringify(claim.runtime.environment) !== JSON.stringify(OPENOBSERVE_ENVIRONMENT)
      || claim.runtime.containerName !== observabilityAppId(mcpUrl)
      || claim.runtime.containerPort !== 5080 || claim.runtime.additionalPorts?.length
      || JSON.stringify(claim.runtime.volumes) !== JSON.stringify([{ name: `${observabilityAppId(mcpUrl)}-data`, mountPath: '/data' }])) {
      throw new Error('Managed observability configuration changed. Re-enable its feature to repair it before launch.');
    }
    const credentials = await this.credentials(mcpUrl);
    return { ZO_ROOT_USER_EMAIL: credentials.username, ZO_ROOT_USER_PASSWORD: credentials.password };
  }

  async change(mcpUrl: string, flags: InstanceFeatureUpdate, client: ClaimClient,
    service: Pick<DockerContainerService, 'backendNetwork' | 'ensure' | 'stop'>,
    ensureCurrent: () => void, signal?: AbortSignal): Promise<InstanceFeatures> {
    if (this.changing) throw new Error('Wait for observability setup to finish.');
    this.changing = true;
    try {
      const state = await this.identity.observability(mcpUrl);
      ensureCurrent();
      const id = observabilityAppId(mcpUrl);
      const claims = (await client.containerClaimRead()).filter(claim => claim.application?.id === id);
      if (claims.length > 1) throw new Error('Multiple Observability Container Apps are registered for this instance.');
      const existing = claims[0];
      ensureCurrent();
      if (!flags.observability) {
        const features = await this.identity.setFeatures(mcpUrl, flags);
        ensureCurrent();
        if (existing) {
          const stopped = await service.stop(existing, signal);
          if (stopped.status === 'error') throw new Error(`Telemetry export is off, but OpenObserve could not be stopped. ${stopped.message}`);
        }
        return features;
      }
      if (!this.vault.available()) throw new Error('Native encrypted credential storage is required for password-free observability.');
      const origin = new URL(mcpUrl).origin;
      let saved = await this.vault.read(origin);
      if (!saved) {
        if (existing || state.configured) throw new Error('Saved OpenObserve credentials are missing. Restore them before starting existing storage.');
        saved = JSON.stringify({ username: 'working-memory@localhost.invalid', password: `Wm1!${randomBytes(36).toString('base64url')}` });
        await this.vault.save(origin, saved);
      }
      const credentials = credentialsSchema.parse(JSON.parse(saved));
      const network = await service.backendNetwork(mcpUrl, signal);
      ensureCurrent();
      const hostPort = existing?.runtime?.hostPort ?? await availablePort();
      const result = await service.ensure(client, {
        ...(existing ? { id: existing.id } : {}),
        title: 'Working Memory Observability',
        repository: 'https://github.com/openobserve/openobserve',
        runtime: {
          type: 'docker', imageSource: 'registry', imageName: OPENOBSERVE_IMAGE,
          restartPolicy: 'unless-stopped', memoryMb: 768, cpus: 1,
          containerName: id, hostPort, containerPort: 5080, network, healthPath: '/healthz', entryPath: '/web/',
          volumes: [{ name: `${id}-data`, mountPath: '/data' }],
          environment: OPENOBSERVE_ENVIRONMENT,
        },
        application: {
          id, contractVersion: '1.0', discovery: { toolName: 'not-supported' }, capabilities: [],
          dataOwnership: 'application', uiUrl: `http://localhost:${hostPort}/web/`,
        },
        desktop: { icon: 'pulse', embeddable: true },
      }, signal);
      if (result.status !== 'ready') throw new Error(result.message);
      ensureCurrent();
      await this.bootstrap(`http://localhost:${hostPort}`, credentials);
      ensureCurrent();
      await this.identity.observability(mcpUrl, {
        endpoint: `http://${id}:5080`, uiUrl: `http://localhost:${hostPort}`,
        ...credentials, claimId: result.claim.id, organization: 'default', retentionDays: 7,
      });
      ensureCurrent();
      return await this.identity.setFeatures(mcpUrl, flags);
    } finally { this.changing = false; }
  }

  private async bootstrap(origin: string, credentials: ObservabilityCredentials): Promise<void> {
    const request = async (path: string, body?: unknown) => {
      const response = await fetch(`${origin}${path}`, {
        method: body === undefined ? 'GET' : 'POST',
        headers: {
          Authorization: `Basic ${Buffer.from(`${credentials.username}:${credentials.password}`).toString('base64')}`,
          'Content-Type': 'application/json',
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        redirect: 'error', signal: AbortSignal.timeout(10000),
      });
      if (!response.ok) {
        await response.body?.cancel();
        throw new Error(`OpenObserve baseline setup failed (HTTP ${response.status}, ${path}).`);
      }
      return response.json() as Promise<unknown>;
    };
    const dashboards = z.object({ dashboards: z.array(z.object({ title: z.string() })) }).parse(
      await request('/api/default/dashboards'));
    if (!dashboards.dashboards.some(dashboard => dashboard.title === 'Working Memory diagnostics')) {
      await request('/api/default/dashboards', observabilityDashboard(origin));
    }
  }
}

function availablePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (!address || typeof address === 'string') { server.close(); reject(new Error('Cannot allocate an OpenObserve port.')); return; }
      server.close(error => error ? reject(error) : resolve(address.port));
    });
  });
}
