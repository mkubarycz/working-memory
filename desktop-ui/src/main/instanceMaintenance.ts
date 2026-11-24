import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';

export const MAX_MAINTENANCE_MS = 15 * 60 * 1000;
export const maintenanceRecordSchema = z.object({
  id: z.string().uuid(),
  mcpUrl: z.string().url(),
  startedAt: z.number().int().nonnegative(),
  expiresAt: z.number().int().nonnegative(),
  completedAt: z.number().int().nonnegative().optional(),
  bootId: z.string().uuid().optional(),
}).strict().refine(record => record.expiresAt >= record.startedAt
  && record.expiresAt - record.startedAt <= MAX_MAINTENANCE_MS
  && (record.completedAt === undefined ? record.bootId === undefined
    : record.bootId !== undefined && record.completedAt >= record.startedAt && record.completedAt < record.expiresAt),
'Invalid maintenance deadline or completion.');

export function maintenancePath(directory: string, mcpUrl: string): string {
  return join(directory, `${createHash('sha256').update(mcpUrl).digest('hex')}.json`);
}

export function readInstanceMaintenance(directory: string, mcpUrl: string) {
  let text: string;
  try { text = readFileSync(maintenancePath(directory, mcpUrl), 'utf8'); }
  catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return null;
    throw error;
  }
  const record = maintenanceRecordSchema.parse(JSON.parse(text));
  if (record.mcpUrl !== mcpUrl) throw new Error('Maintenance record belongs to another instance.');
  return record;
}
