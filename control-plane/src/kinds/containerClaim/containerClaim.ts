import type { DocumentEnvelope } from '../../store.js';

export const CONTAINER_CLAIM_KIND = 'ContainerClaim';

export interface IContainerClaim {
  id: string;
  slug: string;
  title: string;
  repository: string;
  sourceRevision?: string;
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
    this.created_at = env.metadata.createdAt;
    this.updated_at = env.metadata.updatedAt;
    this.resourceVersion = env.metadata.resourceVersion;
  }
}