import { createHash } from 'node:crypto';
import { z } from 'zod';
import { scriptParametersSchema, type ScriptArguments } from './hostScriptParameters.js';
export { scriptParametersSchema, validateScriptArguments, exampleScriptArguments } from './hostScriptParameters.js';
export type { ScriptParameters, ScriptArguments } from './hostScriptParameters.js';

export const scriptDefinitionSchema = z.object({
  name: z.string().trim().min(1).max(100).regex(/^[^\p{Cc}\p{Cf}\p{Zl}\p{Zp}]*$/u),
  description: z.string().max(1000),
  hostId: z.string().uuid(),
  source: z.string().min(1).refine(value => Buffer.byteLength(value) <= 32768, 'Script exceeds 32 KiB'),
  parameters: scriptParametersSchema,
  timeoutMs: z.number().int().min(1000).max(30000),
}).strict();

export type ScriptDefinition = z.infer<typeof scriptDefinitionSchema>;
export type ScriptTask = Omit<ScriptDefinition, 'source'> & {
  id: string; definitionHash: string; createdAt: number; revokedAt: number | null; publishedVersion: number; latestVersion: number;
  draftName?: string; draftDescription?: string;
};
export interface ScriptVersion {
  version: number; definition: ScriptDefinition; definitionHash: string; createdAt: number;
}
export interface ScriptDetails { task: ScriptTask; versions: ScriptVersion[] }
export interface ScriptGrant {
  id: string; taskId: string; appId: string; definitionHash: string; expiresAt: number; revokedAt: number | null;
}
export interface ScriptJob {
  id: string; taskId: string; appId: string | null; state: string;
  createdAt: number; expiresAt: number; resultJson: string | null; error: string | null; version: number;
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
  publishedVersion: z.number().int().positive(),
  latestVersion: z.number().int().positive(),
  draftName: z.string().optional(), draftDescription: z.string().optional(),
});
export const scriptVersionSchema = z.object({
  version: z.number().int().positive(), definition: scriptDefinitionSchema,
  definitionHash: z.string().regex(/^[a-f0-9]{64}$/), createdAt: z.number().int(),
});
export const scriptDetailsSchema = z.object({ task: scriptTaskSchema, versions: z.array(scriptVersionSchema).min(1) });
export const scriptJobSchema = z.object({
  id: z.string().uuid(), taskId: z.string().uuid(), appId: z.string().uuid().nullable(),
  state: z.enum(['queued', 'running', 'succeeded', 'failed', 'cancelled', 'expired']),
  createdAt: z.number().int(), expiresAt: z.number().int(),
  resultJson: z.string().nullable(), error: z.string().nullable(),
  version: z.number().int().positive(),
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
