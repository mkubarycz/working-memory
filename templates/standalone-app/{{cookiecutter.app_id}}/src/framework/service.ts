import { ResourceRegistry } from './registry.js';
import { ResourceStore } from './store.js';
import type { OperationResult, RequestContext, ResourceEnvelope } from './types.js';

export class ResourceService {
  constructor(
    readonly registry: ResourceRegistry,
    readonly store: ResourceStore,
  ) {}

  query(
    kind: string,
    specEquals: Record<string, unknown> | undefined,
    transactionId: string = crypto.randomUUID(),
  ): OperationResult<ResourceEnvelope[]> {
    this.registry.get(kind);
    return { transactionId, result: this.store.query(kind, specEquals) };
  }

  get(
    kind: string,
    id: string,
    transactionId: string = crypto.randomUUID(),
  ): OperationResult<ResourceEnvelope> {
    this.registry.get(kind);
    const resource = this.store.get(kind, id);
    if (!resource) throw new Error(`${kind} "${id}" was not found.`);
    return { transactionId, result: resource };
  }

  create(input: {
    kind: string;
    spec: unknown;
    status?: unknown;
    relationships?: unknown;
    transactionId?: string;
    actor?: string;
  }): OperationResult<ResourceEnvelope> {
    const definition = this.registry.get(input.kind);
    const context = requestContext(input);
    const candidate: ResourceEnvelope = {
      kind: input.kind,
      metadata: {
        id: crypto.randomUUID(),
        createdAt: '',
        updatedAt: '',
        resourceVersion: 1,
      },
      spec: definition.spec.parse(input.spec),
      status: definition.status.parse(input.status ?? {}),
      relationships: definition.relationships.parse(input.relationships ?? {}),
    };
    definition.validate?.(candidate, this.store);
    return {
      transactionId: context.transactionId,
      result: this.store.create({
        kind: candidate.kind,
        id: candidate.metadata.id,
        spec: candidate.spec,
        status: candidate.status,
        relationships: candidate.relationships,
      }, context),
    };
  }

  update(input: {
    kind: string;
    id: string;
    expectedResourceVersion: number;
    spec: unknown;
    status: unknown;
    relationships: unknown;
    transactionId?: string;
    actor?: string;
  }): OperationResult<ResourceEnvelope> {
    const definition = this.registry.get(input.kind);
    const context = requestContext(input);
    const candidate: ResourceEnvelope = {
      kind: input.kind,
      metadata: {
        id: input.id,
        createdAt: '',
        updatedAt: '',
        resourceVersion: input.expectedResourceVersion,
      },
      spec: definition.spec.parse(input.spec),
      status: definition.status.parse(input.status),
      relationships: definition.relationships.parse(input.relationships),
    };
    definition.validate?.(candidate, this.store);
    return {
      transactionId: context.transactionId,
      result: this.store.update({
        kind: candidate.kind,
        id: candidate.metadata.id,
        expectedResourceVersion: input.expectedResourceVersion,
        spec: candidate.spec,
        status: candidate.status,
        relationships: candidate.relationships,
      }, context),
    };
  }

  delete(input: {
    kind: string;
    id: string;
    expectedResourceVersion: number;
    transactionId?: string;
    actor?: string;
  }): OperationResult<ResourceEnvelope> {
    this.registry.get(input.kind);
    const context = requestContext(input);
    return {
      transactionId: context.transactionId,
      result: this.store.delete(
        input.kind,
        input.id,
        input.expectedResourceVersion,
        context,
      ),
    };
  }
}

function requestContext(input: { transactionId?: string; actor?: string }): RequestContext {
  return {
    transactionId: input.transactionId ?? crypto.randomUUID(),
    actor: input.actor,
  };
}
