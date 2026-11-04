import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import type { ContainerProvider } from './containerProvider';
import type { ContainerClaim } from '../../../shared/controlPlaneClient';

const ownershipSchema = z.object({
  provider: z.enum(['docker', 'podman']),
  connection: z.string().min(1),
});

function ownershipFile(directory: string, resource: string): string {
  return join(directory, `${createHash('sha256').update(resource).digest('hex')}.json`);
}

export function readContainerOwnership(directory: string, resource: string): z.infer<typeof ownershipSchema> | undefined {
  try {
    return ownershipSchema.parse(JSON.parse(readFileSync(ownershipFile(directory, resource), 'utf8')));
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return undefined;
    throw error;
  }
}

export function assertContainerProviderForClaims(
  directory: string,
  provider: ContainerProvider,
  claims: ReadonlyArray<Pick<ContainerClaim, 'id' | 'runtime'>>,
): void {
  for (const claim of claims) {
    if (!claim.runtime?.volumes?.length) continue;
    const owners = [readContainerOwnership(directory, claim.id),
      ...claim.runtime.volumes.map(volume => readContainerOwnership(directory, `volume:${volume.name}`))];
    const knownOwners = owners.filter(owner => owner !== undefined);
    if (knownOwners.length ? knownOwners.some(owner => owner.provider !== provider) : provider !== 'docker') {
      throw new Error('This environment has Container Apps with engine-owned data volumes belonging to another provider. Select their original provider; changing provider does not migrate data.');
    }
  }
}

/** Pins engine-owned storage before a command can create or recreate it. */
export function checkContainerOwnership(
  directory: string,
  resource: string,
  owner: { provider: ContainerProvider; connection: string },
  reserve = false,
): boolean {
  const file = ownershipFile(directory, resource);
  const existing = readContainerOwnership(directory, resource);
  if (existing) {
    if (existing.provider !== owner.provider || existing.connection !== owner.connection) {
      throw new Error('This resource belongs to another container provider or connection. Restore the original provider and connection. Data is never migrated or replaced automatically.');
    }
    return true;
  }
  if (reserve) {
    mkdirSync(directory, { recursive: true });
    writeFileSync(file, `${JSON.stringify(owner)}\n`, { flag: 'wx', mode: 0o600 });
  }
  return false;
}
