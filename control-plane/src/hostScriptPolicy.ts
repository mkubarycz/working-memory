import { createHash } from 'node:crypto';
import { z } from 'zod';

const required = z.boolean().default(false);
const parameter = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('string'), required, maxLength: z.number().int().min(1).max(4096).default(256),
    enum: z.array(z.string().max(4096)).min(1).max(50).optional(),
  }).strict(),
  z.object({
    type: z.literal('integer'), required,
    minimum: z.number().int().min(-1_000_000).max(1_000_000),
    maximum: z.number().int().min(-1_000_000).max(1_000_000),
  }).strict().refine(value => value.minimum <= value.maximum, 'Invalid integer bounds'),
  z.object({ type: z.literal('boolean'), required }).strict(),
]);

export const scriptParametersSchema = z.record(
  z.string().regex(/^[a-zA-Z][a-zA-Z0-9_]{0,39}$/)
    .refine(key => !['constructor', 'prototype', '__proto__'].includes(key)),
  parameter,
).refine(value => Object.keys(value).length <= 20, 'At most 20 parameters are allowed');

export const scriptDefinitionSchema = z.object({
  name: z.string().trim().min(1).max(100).regex(/^[^\p{Cc}\p{Cf}\p{Zl}\p{Zp}]*$/u),
  description: z.string().max(1000),
  hostId: z.string().uuid(),
  source: z.string().min(1).refine(value => Buffer.byteLength(value) <= 32768, 'Script exceeds 32 KiB'),
  parameters: scriptParametersSchema,
  timeoutMs: z.number().int().min(1000).max(30000),
}).strict();

export type ScriptDefinition = z.infer<typeof scriptDefinitionSchema>;
export type ScriptParameters = ScriptDefinition['parameters'];
export type ScriptArguments = Record<string, string | number | boolean>;
export type ScriptTask = Omit<ScriptDefinition, 'source'> & {
  id: string; definitionHash: string; createdAt: number; revokedAt: number | null;
};
export interface ScriptGrant {
  id: string; taskId: string; appId: string; definitionHash: string; expiresAt: number; revokedAt: number | null;
}
export interface ScriptJob {
  id: string; taskId: string; appId: string | null; state: string;
  createdAt: number; expiresAt: number; resultJson: string | null; error: string | null;
}
export interface ScriptSnapshot {
  tasks: ScriptTask[]; grants: ScriptGrant[]; jobs: ScriptJob[];
  apps: Array<{ id: string; label: string; revokedAt: number | null }>;
}
export interface ScriptLease {
  jobId: string; leaseToken: string; definition: ScriptDefinition; definitionHash: string;
  parameters: ScriptArguments; deadline: number;
}

export const scriptTaskSchema = scriptDefinitionSchema.omit({ source: true }).extend({
  id: z.string().uuid(), definitionHash: z.string().regex(/^[a-f0-9]{64}$/),
  createdAt: z.number().int(), revokedAt: z.number().int().nullable(),
});
export const scriptJobSchema = z.object({
  id: z.string().uuid(), taskId: z.string().uuid(), appId: z.string().uuid().nullable(),
  state: z.enum(['queued', 'running', 'succeeded', 'failed', 'cancelled', 'expired']),
  createdAt: z.number().int(), expiresAt: z.number().int(),
  resultJson: z.string().nullable(), error: z.string().nullable(),
});
export const scriptSnapshotSchema = z.object({
  tasks: z.array(scriptTaskSchema),
  grants: z.array(z.object({
    id: z.string().uuid(), taskId: z.string().uuid(), appId: z.string().uuid(),
    definitionHash: z.string(), expiresAt: z.number().int(), revokedAt: z.number().int().nullable(),
  })),
  jobs: z.array(scriptJobSchema),
  apps: z.array(z.object({ id: z.string().uuid(), label: z.string(), revokedAt: z.number().int().nullable() })),
});
export const scriptLeaseSchema = z.object({
  jobId: z.string().uuid(), leaseToken: z.string().regex(/^[a-f0-9]{64}$/),
  definition: scriptDefinitionSchema, definitionHash: z.string().regex(/^[a-f0-9]{64}$/),
  parameters: z.record(z.string(), z.union([z.string(), z.number(), z.boolean()])),
  deadline: z.number().int(),
});

export function scriptDefinitionHash(definition: ScriptDefinition): string {
  return createHash('sha256').update(JSON.stringify(definition, (_key, value: unknown) =>
    value && typeof value === 'object' && !Array.isArray(value)
      ? Object.fromEntries(Object.entries(value).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0))
      : value)).digest('hex');
}

export function validateScriptArguments(schema: ScriptParameters, input: unknown): ScriptArguments {
  const raw = z.record(z.string(), z.unknown()).parse(input);
  const result: ScriptArguments = {};
  for (const key of Object.keys(raw)) {
    if (!Object.hasOwn(schema, key)) throw new Error(`Unknown parameter: ${key}`);
  }
  for (const [key, rule] of Object.entries(schema)) {
    const value = raw[key];
    if (value === undefined) {
      if (rule.required) throw new Error(`Missing parameter: ${key}`);
      continue;
    }
    if (rule.type === 'string') {
      if (typeof value !== 'string' || value.length > rule.maxLength || rule.enum && !rule.enum.includes(value)) {
        throw new Error(`Invalid string parameter: ${key}`);
      }
    } else if (rule.type === 'integer') {
      if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < rule.minimum || value > rule.maximum) {
        throw new Error(`Invalid integer parameter: ${key}`);
      }
    } else if (typeof value !== 'boolean') throw new Error(`Invalid boolean parameter: ${key}`);
    if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') result[key] = value;
  }
  if (Buffer.byteLength(JSON.stringify(result)) > 16384) throw new Error('Parameters exceed 16 KiB');
  return result;
}
