import type { DockerRuntimeSpec } from '../../../src/controlPlaneClient';
import type { ContainerAppDefinition, ContainerAppId } from '../shared/contracts';

export interface ContainerAppRegistration extends ContainerAppDefinition {
  claimTitle: string;
  sourceEnvironmentVariable: string;
  projectDirectory: string;
  runtime: Omit<DockerRuntimeSpec, 'buildContext' | 'dockerfile'>;
  mcp?: ContainerAppDefinition['mcp'];
  application?: ContainerAppDefinition['application'];
}

export const CONTAINER_APP_REGISTRY: readonly ContainerAppRegistration[] = [
  {
    id: 'clarinet-hero',
    displayName: 'Claranet Hero',
    icon: 'server-environment',
    claimTitle: 'Clarinet Hero',
    sourceEnvironmentVariable: 'CLARINET_HERO_SOURCE',
    projectDirectory: 'ClarinetHero',
    runtime: {
      type: 'docker',
      imageName: 'clarinet-hero:local',
      containerName: 'working-memory-clarinet-hero',
      hostPort: 4173,
      containerPort: 80,
      healthPath: '/',
      entryPath: '/',
    },
  },
  {
    id: 'banking-app',
    displayName: 'Banking App',
    icon: 'credit-card',
    claimTitle: 'Banking App',
    sourceEnvironmentVariable: 'BANKING_APP_SOURCE',
    projectDirectory: 'BankingApp',
    runtime: {
      type: 'docker',
      imageName: 'banking-app:local',
      containerName: 'working-memory-banking-app',
      hostPort: 4174,
      containerPort: 4174,
      healthPath: '/health',
      entryPath: '/',
      volumes: [{ name: 'working-memory-banking-app-data', mountPath: '/data' }],
    },
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
    claimTitle: 'Sunset Chess',
    sourceEnvironmentVariable: 'SUNSET_CHESS_SOURCE',
    projectDirectory: 'SunsetChess',
    runtime: {
      type: 'docker',
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
      capabilities: ['contract-discovery'],
      dataOwnership: 'application',
      healthUrl: 'http://127.0.0.1:4175/health',
      uiUrl: 'http://127.0.0.1:4175/',
      httpUrl: 'http://127.0.0.1:4175/api',
    },
  },
];

export function containerAppRegistration(id: string): ContainerAppRegistration {
  const registration = CONTAINER_APP_REGISTRY.find((candidate) => candidate.id === id);
  if (!registration) throw new Error(`Unsupported container app: ${id}`);
  return registration;
}

export function containerAppDefinitions(): ContainerAppDefinition[] {
  return CONTAINER_APP_REGISTRY.map(({ id, displayName, icon, mcp, application }) => ({
    id,
    displayName,
    icon,
    ...(mcp ? { mcp } : {}),
    ...(application ? { application } : {}),
  }));
}

export function isContainerAppId(id: string): id is ContainerAppId {
  return CONTAINER_APP_REGISTRY.some((app) => app.id === id);
}
