import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import type { ContainerClaim } from '../../shared/controlPlaneClient';
import {
  containerAppDefinitions as definitionsFromClaims,
  containerAppRegistration as claimRegistration,
  isRegisteredContainerAppUiUrl as registeredUiUrl,
} from '../src/main/containerAppRegistry';
import { CONTAINER_APP_FIXTURES } from './fixtures/containerApps';
import { resolveContainerAppMentions } from '../src/main/appToolRouting';
import {
  effectiveContainerAppMcp,
  loadRegisteredContainerApps,
  refreshRegisteredContainerApps,
} from '../src/renderer/containerApps';

const claims: ContainerClaim[] = CONTAINER_APP_FIXTURES.map((app) => ({
  id: app.id,
  slug: app.id,
  title: app.displayName,
  repository: `/source/${app.id}`,
  runtime: { ...app.runtime, buildContext: `/source/${app.id}`, dockerfile: `/source/${app.id}/Dockerfile` },
  mcp: app.mcp,
  application: app.application,
  desktop: { icon: app.icon, embeddable: app.embeddable ?? false },
  created_at: 1,
  updated_at: 1,
  resourceVersion: 1,
}));
const containerAppDefinitions = () => definitionsFromClaims(claims);
const containerAppRegistration = (id: string) => claimRegistration(id, claims);
const isRegisteredContainerAppUiUrl = (url: string) => registeredUiUrl(url, containerAppDefinitions());

describe('container app registry', () => {
  it('discovers arbitrary persisted Docker claims without a compiled-in app definition', () => {
    const custom: ContainerClaim = {
      ...claims[0],
      id: 'new-id',
      slug: 'brand-new-app',
      title: 'My New App',
      sourceRevision: 'feature/new-app',
      desktop: { icon: 'beaker', embeddable: true },
      application: { ...claims[1].application!, uiUrl: 'http://127.0.0.1:4999/app' },
    };
    const definitions = definitionsFromClaims([custom]);
    expect(definitions).toEqual([expect.objectContaining({
      id: 'brand-new-app', displayName: 'My New App', icon: 'beaker', embeddable: true,
    })]);
    expect(claimRegistration(custom.slug, [custom])).toBe(custom);
    expect(claimRegistration(custom.slug, [custom]).sourceRevision).toBe('feature/new-app');
    expect(resolveContainerAppMentions('@brand-new-app help', definitions).appIds).toEqual([custom.slug]);
    expect(registeredUiUrl('http://127.0.0.1:4999/app/resource', definitions)).toBe(true);
    expect(registeredUiUrl('http://127.0.0.1:4999/application', definitions)).toBe(false);
    expect(registeredUiUrl('http://127.0.0.1:4998/app', definitions)).toBe(false);
    expect(definitionsFromClaims([])).toEqual([]);
    expect(definitionsFromClaims([{ ...custom, runtime: undefined }])).toEqual([]);
    expect(() => claimRegistration(custom.slug, [])).toThrow('No live Docker ContainerClaim');
  });

  it('uses authored metadata instead of overwriting claims with defaults', () => {
    const claim = { ...claims[1], title: 'Renamed bank', mcp: undefined, application: undefined,
      desktop: { icon: 'beaker', embeddable: false } };
    expect(definitionsFromClaims([claim])).toEqual([{
      id: 'banking-app', displayName: 'Renamed bank', icon: 'beaker',
    }]);
    expect(claimRegistration('banking-app', [claim])).toBe(claim);
  });

  it('uses the same generic presentation defaults for every app ID', () => {
    for (const slug of ['clarinet-hero', 'banking-app', 'sunset-chess', 'brand-new-app']) {
      expect(definitionsFromClaims([{ ...claims[0], slug, desktop: undefined }])).toEqual([{
        id: slug, displayName: claims[0].title, icon: 'server-environment',
      }]);
    }
  });

  it('permits runtime UI navigation without requiring an MCP application contract', () => {
    const claim = { ...claims[0], slug: 'simple-web-app', application: undefined };
    expect(registeredUiUrl('http://localhost:4173/', [claim])).toBe(true);
    expect(registeredUiUrl('http://localhost:4174/', [claim])).toBe(false);
  });
  it('publishes all app definitions to the renderer', () => {
    expect(containerAppDefinitions()).toEqual([
      { id: 'clarinet-hero', displayName: 'Clarinet Hero', icon: 'server-environment' },
      {
        id: 'banking-app',
        displayName: 'Banking App',
        icon: 'credit-card',
        embeddable: true,
        mcp: { transport: 'streamable-http', url: 'http://127.0.0.1:4174/mcp' },
        application: {
          id: 'banking-app',
          contractVersion: '3.0',
          discovery: {
            toolName: 'contract-discover',
            url: 'http://127.0.0.1:4174/.well-known/banking-app-contract',
          },
          capabilities: ['contract-discovery'],
          dataOwnership: 'application',
          healthUrl: 'http://127.0.0.1:4174/health',
          uiUrl: 'http://127.0.0.1:4174/',
          httpUrl: 'http://127.0.0.1:4174/api',
        },
      },
      {
        id: 'sunset-chess',
        displayName: 'Sunset Chess',
        icon: 'device-camera',
        mcp: { transport: 'streamable-http', url: 'http://127.0.0.1:4175/mcp' },
        application: {
          id: 'sunset-chess',
          contractVersion: '1.0',
          discovery: {
            toolName: 'contract-discover',
            url: 'http://127.0.0.1:4175/.well-known/sunset-chess-contract',
          },
          capabilities: ['contract-discovery'],
          dataOwnership: 'application',
          healthUrl: 'http://127.0.0.1:4175/health',
          uiUrl: 'http://127.0.0.1:4175/',
          httpUrl: 'http://127.0.0.1:4175/api',
        },
      },
    ]);
  });

  it('keeps claims, containers, ports, volumes, and URLs isolated', () => {
    const [clarinet, banking, sunset] = CONTAINER_APP_FIXTURES;
    expect(new Set(CONTAINER_APP_FIXTURES.map((app) => app.id)).size).toBe(3);
    expect(new Set(CONTAINER_APP_FIXTURES.map((app) => app.runtime.containerName)).size).toBe(3);
    expect(new Set(CONTAINER_APP_FIXTURES.map((app) => app.runtime.hostPort)).size).toBe(3);
    expect(clarinet.runtime.hostPort).toBe(4173);
    expect(banking.runtime.hostPort).toBe(4174);
    expect(banking.runtime.containerName).toBe('working-memory-banking-app');
    expect(banking.runtime.imageName).toBe('banking-app:local');
    expect(banking).toMatchObject({
      runtime: {
        containerPort: 4174,
        healthPath: '/health',
        volumes: [{ name: 'working-memory-banking-app-data', mountPath: '/data' }],
      },
      mcp: { transport: 'streamable-http', url: 'http://127.0.0.1:4174/mcp' },
      application: {
        id: 'banking-app',
        discovery: {
          toolName: 'contract-discover',
          url: 'http://127.0.0.1:4174/.well-known/banking-app-contract',
        },
        dataOwnership: 'application',
      },
    });
    expect(sunset).toMatchObject({
      id: 'sunset-chess',
      displayName: 'Sunset Chess',
      runtime: {
        imageName: 'sunset-chess:1.2',
        containerName: 'working-memory-sunset-chess',
        hostPort: 4175,
        containerPort: 4175,
        healthPath: '/health',
        entryPath: '/',
        volumes: [{ name: 'working-memory-sunset-chess-data', mountPath: '/data' }],
      },
      mcp: { transport: 'streamable-http', url: 'http://127.0.0.1:4175/mcp' },
      application: {
        id: 'sunset-chess',
        contractVersion: '1.0',
        discovery: {
          toolName: 'contract-discover',
          url: 'http://127.0.0.1:4175/.well-known/sunset-chess-contract',
        },
        dataOwnership: 'application',
      },
    });
  });

  it('routes by exact app ID and rejects unknown apps', () => {
    expect(containerAppRegistration('banking-app').id).toBe('banking-app');
    expect(containerAppRegistration('clarinet-hero').id).toBe('clarinet-hero');
    expect(containerAppRegistration('sunset-chess').id).toBe('sunset-chess');
    expect(() => containerAppRegistration('sunset-chess-vnext')).toThrow('Unsupported container app');
    expect(() => containerAppRegistration('sunset-chess-1-2')).toThrow('Unsupported container app');
    expect(() => containerAppRegistration('banking')).toThrow('Unsupported container app');
  });

  it('allows embedded navigation only within registered loopback app URLs', () => {
    expect(isRegisteredContainerAppUiUrl('http://127.0.0.1:4174/')).toBe(true);
    expect(isRegisteredContainerAppUiUrl('http://127.0.0.1:4174/?resource=Account&id=cash')).toBe(true);
    expect(isRegisteredContainerAppUiUrl('http://localhost:4174/')).toBe(false);
    expect(isRegisteredContainerAppUiUrl('https://127.0.0.1:4174/')).toBe(false);
    expect(isRegisteredContainerAppUiUrl('https://example.com/')).toBe(false);
  });

  it('exposes only the canonical Sunset Chess mention', () => {
    expect(resolveContainerAppMentions(
      '@sunset-chess list players',
      containerAppDefinitions(),
    )).toEqual({
      appIds: ['sunset-chess'],
      mentions: [
        { raw: '@sunset-chess', appId: 'sunset-chess' },
      ],
    });
    expect(() => resolveContainerAppMentions('@sunset-chess-vnext list players', containerAppDefinitions()))
      .toThrow('Unknown Container App mention @sunset-chess-vnext');
  });

  it('uses inspected claim MCP metadata as source of truth with registry fallback only while loading', () => {
    const registryEndpoint = { transport: 'streamable-http' as const, url: 'http://127.0.0.1:4175/mcp' };
    const liveEndpoint = { transport: 'streamable-http' as const, url: 'http://localhost:4999/live-mcp' };

    expect(effectiveContainerAppMcp({ mcp: registryEndpoint }, undefined)).toEqual(registryEndpoint);
    expect(effectiveContainerAppMcp({ mcp: registryEndpoint }, { mcp: liveEndpoint })).toEqual(liveEndpoint);
    expect(effectiveContainerAppMcp({}, { mcp: liveEndpoint })).toEqual(liveEndpoint);
    expect(effectiveContainerAppMcp({ mcp: registryEndpoint }, {})).toBeUndefined();
  });

  it('keeps app-specific definitions out of production discovery, service, and IPC code', () => {
    for (const path of ['src/main/containerAppRegistry.ts', 'src/main/dockerContainerService.ts', 'src/main/index.ts']) {
      const source = readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');
      expect(source).not.toMatch(/sunset[-_ ]chess|banking[-_ ]app|clarinet[-_ ]hero/i);
      expect(source).not.toContain('sourceEnvironmentVariable');
      expect(source).not.toContain('projectDirectory');
      expect(source).not.toContain('resolveContainerAppClaim');
    }
  });

  it('initializes every registered app status without leaking inspection failures', async () => {
    const apps = containerAppDefinitions();
    const inspected: string[] = [];
    const statuses: string[] = [];
    const errors: unknown[] = [];
    await refreshRegisteredContainerApps(
      apps,
      async (id) => {
        inspected.push(id);
        return {
          id,
          displayName: id,
          claimTitle: id,
          claimSlug: id,
          repository: '',
          buildContext: '',
          dockerfile: '',
          image: '',
          containerName: id,
          dockerContext: null,
          state: 'healthy',
          hostPort: id === 'clarinet-hero' ? 4173 : id === 'banking-app' ? 4174 : 4175,
          containerPort: 80,
          url: `http://localhost:${id === 'clarinet-hero' ? 4173 : id === 'banking-app' ? 4174 : 4175}/`,
          ready: true,
          lastAction: 'Inspected',
          error: null,
        };
      },
      () => true,
      (app) => statuses.push(app.id),
      (error) => errors.push(error),
    );
    expect(inspected).toEqual(['clarinet-hero', 'banking-app', 'sunset-chess']);
    expect(statuses).toEqual(['clarinet-hero', 'banking-app', 'sunset-chess']);
    expect(errors).toEqual([]);

    await expect(refreshRegisteredContainerApps(
      apps,
      async () => { throw new Error('offline'); },
      () => true,
      () => {},
      (error) => errors.push(error),
    )).resolves.toBeUndefined();
    expect(errors).toHaveLength(3);

    const staleStatuses: string[] = [];
    await refreshRegisteredContainerApps(
      apps,
      async (id) => ({
        id, displayName: id, claimTitle: id, claimSlug: id, repository: '', buildContext: '',
        dockerfile: '', image: '', containerName: id, dockerContext: null, state: 'stopped',
        hostPort: 0, containerPort: 80, url: '', ready: false, lastAction: 'Inspected', error: null,
      }),
      () => false,
      (app) => staleStatuses.push(app.id),
      () => {},
    );
    expect(staleStatuses).toEqual([]);
  });

  it('discards an asynchronous catalog result from a previously selected environment', async () => {
    let resolveList!: (apps: ReturnType<typeof containerAppDefinitions>) => void;
    const list = new Promise<ReturnType<typeof containerAppDefinitions>>((resolve) => {
      resolveList = resolve;
    });
    let environment = 'before-switch';
    const visible: string[] = [];
    const statuses: string[] = [];
    const loading = loadRegisteredContainerApps(
      () => list,
      async (id) => ({
        id, displayName: id, claimTitle: id, claimSlug: id, repository: '', buildContext: '',
        dockerfile: '', image: '', containerName: id, dockerContext: null, state: 'healthy',
        hostPort: 0, containerPort: 80, url: '', ready: true, lastAction: 'Status refreshed', error: null,
      }),
      () => environment,
      (apps) => visible.push(...apps.map((app) => app.id)),
      (app) => statuses.push(app.id),
      () => {},
    );

    environment = 'after-switch';
    resolveList(containerAppDefinitions());
    await loading;

    expect(visible).toEqual([]);
    expect(statuses).toEqual([]);
  });
});
