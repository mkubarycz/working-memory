import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  CONTAINER_APP_REGISTRY,
  containerAppDefinitions,
  containerAppRegistration,
} from '../src/main/containerAppRegistry';
import { resolveContainerAppMentions } from '../src/main/appToolRouting';
import {
  effectiveContainerAppMcp,
  loadRegisteredContainerApps,
  refreshRegisteredContainerApps,
} from '../src/renderer/containerApps';

describe('container app registry', () => {
  it('publishes all app definitions to the renderer', () => {
    expect(containerAppDefinitions()).toEqual([
      { id: 'clarinet-hero', displayName: 'Claranet Hero', icon: 'server-environment' },
      {
        id: 'banking-app',
        displayName: 'Banking App',
        icon: 'credit-card',
        mcp: { transport: 'streamable-http', url: 'http://127.0.0.1:4174/mcp' },
        application: {
          id: 'banking-app',
          contractVersion: '1.0',
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
    const [clarinet, banking, sunset] = CONTAINER_APP_REGISTRY;
    expect(new Set(CONTAINER_APP_REGISTRY.map((app) => app.id)).size).toBe(3);
    expect(new Set(CONTAINER_APP_REGISTRY.map((app) => app.runtime.containerName)).size).toBe(3);
    expect(new Set(CONTAINER_APP_REGISTRY.map((app) => app.runtime.hostPort)).size).toBe(3);
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
      claimTitle: 'Sunset Chess',
      sourceEnvironmentVariable: 'SUNSET_CHESS_SOURCE',
      projectDirectory: 'SunsetChess',
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

  it('keeps Sunset Chess as registry data rather than app-specific service or IPC logic', () => {
    for (const path of ['src/main/dockerContainerService.ts', 'src/main/index.ts']) {
      const source = readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');
      expect(source).not.toMatch(/sunset[-_ ]chess/i);
      expect(source).not.toContain('SUNSET_CHESS_SOURCE');
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

  it('keeps an asynchronous registry result across an environment switch and refreshes all statuses', async () => {
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

    expect(visible).toEqual(['clarinet-hero', 'banking-app', 'sunset-chess']);
    expect(statuses).toEqual(['clarinet-hero', 'banking-app', 'sunset-chess']);
  });
});
