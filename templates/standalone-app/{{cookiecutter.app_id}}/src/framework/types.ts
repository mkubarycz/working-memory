import type { z } from 'zod';

export interface ResourceMetadata {
  id: string;
  createdAt: string;
  updatedAt: string;
  resourceVersion: number;
}

export interface ResourceEnvelope {
  kind: string;
  metadata: ResourceMetadata;
  spec: Record<string, unknown>;
  status: Record<string, unknown>;
  relationships: Record<string, unknown>;
}

export interface RelationshipDescriptor {
  field: string;
  targetKind: string;
  cardinality: 'one' | 'many';
  required?: boolean;
}

export interface ResourceDefinition {
  kind: string;
  description: string;
  spec: z.ZodType<Record<string, unknown>>;
  status: z.ZodType<Record<string, unknown>>;
  relationships: z.ZodType<Record<string, unknown>>;
  relationshipDescriptors: RelationshipDescriptor[];
  businessRules: string[];
  validate?: (candidate: ResourceEnvelope, context: ValidationContext) => void;
}

export interface ValidationContext {
  get(kind: string, id: string): ResourceEnvelope | undefined;
}

export interface RequestContext {
  transactionId: string;
  actor?: string;
}

export interface OperationResult<T> {
  transactionId: string;
  result: T;
}
