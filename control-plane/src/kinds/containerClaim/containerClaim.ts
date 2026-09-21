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
}

export interface IContainerClaim {
  id: string;
  slug: string;
  title: string;
  repository: string;
  sourceRevision?: string;
  runtime?: DockerRuntimeSpec;
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
    if (isDockerRuntimeSpec(spec.runtime)) {
      this.runtime = spec.runtime;
    }
    this.created_at = env.metadata.createdAt;
    this.updated_at = env.metadata.updatedAt;
    this.resourceVersion = env.metadata.resourceVersion;
  }
}

function isDockerRuntimeSpec(value: unknown): value is DockerRuntimeSpec {
  if (!value || typeof value !== 'object') return false;
  const runtime = value as Record<string, unknown>;
  return runtime.type === 'docker'
    && typeof runtime.buildContext === 'string'
    && typeof runtime.dockerfile === 'string'
    && typeof runtime.imageName === 'string'
    && typeof runtime.containerName === 'string'
    && typeof runtime.hostPort === 'number'
    && typeof runtime.containerPort === 'number'
    && typeof runtime.healthPath === 'string'
    && typeof runtime.entryPath === 'string';
}