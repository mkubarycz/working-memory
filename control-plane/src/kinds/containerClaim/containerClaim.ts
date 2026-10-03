import type { DocumentEnvelope } from '../../store.js';

export const CONTAINER_CLAIM_KIND = 'ContainerClaim';

export interface DockerRuntimeSpec {
  type: 'docker';
  buildContext: string;
  dockerfile: string;
  imageName: string;
  containerName: string;
  hostPort: number;
  containerPort: number;
  healthPath: string;
  entryPath: string;
  volumes?: Array<{ name: string; mountPath: string }>;
}

export interface AppMcpEndpoint {
  transport: 'streamable-http';
  url: string;
}

export interface ApplicationContractMetadata {
  id: string;
  contractVersion: string;
  discovery: { toolName: string; url?: string };
  capabilities: string[];
  dataOwnership: 'application';
  healthUrl?: string;
  uiUrl?: string;
  httpUrl?: string;
}

export interface IContainerClaim {
  id: string;
  slug: string;
  title: string;
  repository: string;
  sourceRevision?: string;
  runtime?: DockerRuntimeSpec;
  mcp?: AppMcpEndpoint;
  application?: ApplicationContractMetadata;
  created_at: number;
  updated_at: number;
  resourceVersion: number;
}

/** A pure-data projection of a live ContainerClaim document. */
export class ContainerClaim implements IContainerClaim {
  id: string;
  slug: string;
  title: string;
  repository: string;
  sourceRevision?: string;
  runtime?: DockerRuntimeSpec;
  mcp?: AppMcpEndpoint;
  application?: ApplicationContractMetadata;
  created_at: number;
  updated_at: number;
  resourceVersion: number;

  constructor(env: DocumentEnvelope) {
    const spec = env.spec ?? {};
    this.id = env.metadata.id;
    this.slug = env.metadata.slug ?? '';
    this.title = typeof spec.title === 'string' ? spec.title : '';
    this.repository = typeof spec.repository === 'string' ? spec.repository : '';
    if (typeof spec.sourceRevision === 'string') {
      this.sourceRevision = spec.sourceRevision;
    }
    if (isDockerRuntimeSpec(spec.runtime)) this.runtime = spec.runtime;
    if (isAppMcpEndpoint(spec.mcp)) this.mcp = spec.mcp;
    if (isApplicationContractMetadata(spec.application)) this.application = spec.application;
    this.created_at = env.metadata.createdAt;
    this.updated_at = env.metadata.updatedAt;
    this.resourceVersion = env.metadata.resourceVersion;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function isDockerRuntimeSpec(value: unknown): value is DockerRuntimeSpec {
  if (!isRecord(value)) return false;
  return value.type === 'docker'
    && typeof value.buildContext === 'string'
    && typeof value.dockerfile === 'string'
    && typeof value.imageName === 'string'
    && typeof value.containerName === 'string'
    && typeof value.hostPort === 'number'
    && typeof value.containerPort === 'number'
    && typeof value.healthPath === 'string'
    && typeof value.entryPath === 'string';
}

function isAppMcpEndpoint(value: unknown): value is AppMcpEndpoint {
  return isRecord(value) && value.transport === 'streamable-http' && typeof value.url === 'string';
}

function isApplicationContractMetadata(value: unknown): value is ApplicationContractMetadata {
  return isRecord(value)
    && typeof value.id === 'string'
    && typeof value.contractVersion === 'string'
    && isRecord(value.discovery)
    && typeof value.discovery.toolName === 'string'
    && Array.isArray(value.capabilities)
    && value.capabilities.every((item) => typeof item === 'string')
    && value.dataOwnership === 'application';
}