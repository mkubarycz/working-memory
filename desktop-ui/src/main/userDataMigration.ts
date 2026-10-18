import { cpSync, existsSync } from 'node:fs';
import { join } from 'node:path';

/** Packaged builds before productName was declared used this userData folder name. */
export const LEGACY_USER_DATA_NAME = 'working-memory-desktop';

const MIGRATED_ENTRIES = [
  'config.json',
  'environment.json',
  'window-state.json',
  'credential-vault.key',
  'data-tier',
  // Holds the Windows safeStorage key that protects saved API keys.
  'Local State',
  'Local Storage',
] as const;

/**
 * Copies settings from the legacy packaged-app folder into a fresh userData folder.
 * Never overwrites existing entries and leaves the legacy folder intact for rollback.
 */
export function migrateLegacyUserData(userData: string, legacyUserData: string): string[] {
  if (userData === legacyUserData) return [];
  if (existsSync(join(userData, 'config.json')) || existsSync(join(userData, 'data-tier'))) return [];
  if (!existsSync(join(legacyUserData, 'config.json')) && !existsSync(join(legacyUserData, 'data-tier'))) {
    return [];
  }
  const migrated: string[] = [];
  for (const entry of MIGRATED_ENTRIES) {
    const source = join(legacyUserData, entry);
    const target = join(userData, entry);
    if (!existsSync(source) || existsSync(target)) continue;
    cpSync(source, target, { recursive: true, errorOnExist: false, force: false, preserveTimestamps: true });
    migrated.push(entry);
  }
  return migrated;
}
