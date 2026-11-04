import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import type { ContainerProvider } from './containerProvider';

const ownershipSchema = z.object({
  provider: z.enum(['docker', 'podman']),
  connection: z.string().min(1),
});

/** Pins engine-owned storage before a command can create or recreate it. */
export function checkContainerOwnership(
  directory: string,
  resource: string,
  owner: { provider: ContainerProvider; connection: string },
  reserve = false,
): boolean {
  const file = join(directory, `${createHash('sha256').update(resource).digest('hex')}.json`);
  try {
    const existing = ownershipSchema.parse(JSON.parse(readFileSync(file, 'utf8')));
    if (existing.provider !== owner.provider || existing.connection !== owner.connection) {
      throw new Error('This resource belongs to another container provider or connection. Restore the original provider and connection. Data is never migrated or replaced automatically.');
    }
    return true;
  } catch (error) {
    if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error;
  }
  if (reserve) {
    mkdirSync(directory, { recursive: true });
    writeFileSync(file, `${JSON.stringify(owner)}\n`, { flag: 'wx', mode: 0o600 });
  }
  return false;
}
