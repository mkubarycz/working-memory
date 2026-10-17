import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { migrateLegacyUserData } from '../src/main/userDataMigration';

const roots: string[] = [];

function fixture(): { userData: string; legacy: string } {
  const root = mkdtempSync(join(tmpdir(), 'wm-userdata-'));
  roots.push(root);
  const userData = join(root, 'Working Memory');
  const legacy = join(root, 'working-memory-desktop');
  mkdirSync(userData, { recursive: true });
  mkdirSync(join(legacy, 'data-tier', 'instances', '7720'), { recursive: true });
  writeFileSync(join(legacy, 'config.json'), '{"legacy":true}');
  writeFileSync(join(legacy, 'Local State'), '{"os_crypt":{}}');
  writeFileSync(join(legacy, 'data-tier', 'instances.json'), '[]');
  writeFileSync(join(legacy, 'Preferences'), '{}');
  return { userData, legacy };
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('legacy userData migration', () => {
  it('copies settings, managed-instance state, and the Windows credential key into a fresh profile', () => {
    const { userData, legacy } = fixture();

    expect(migrateLegacyUserData(userData, legacy)).toEqual(['config.json', 'data-tier', 'Local State']);
    expect(readFileSync(join(userData, 'config.json'), 'utf8')).toBe('{"legacy":true}');
    expect(existsSync(join(userData, 'data-tier', 'instances.json'))).toBe(true);
    expect(existsSync(join(userData, 'Preferences'))).toBe(false);
    expect(existsSync(join(legacy, 'config.json'))).toBe(true);
  });

  it('never overwrites a profile that already has settings or instances', () => {
    const { userData, legacy } = fixture();
    writeFileSync(join(userData, 'config.json'), '{"current":true}');

    expect(migrateLegacyUserData(userData, legacy)).toEqual([]);
    expect(readFileSync(join(userData, 'config.json'), 'utf8')).toBe('{"current":true}');
    expect(existsSync(join(userData, 'data-tier'))).toBe(false);
  });

  it('does nothing without a legacy profile or when both paths match', () => {
    const { userData, legacy } = fixture();
    expect(migrateLegacyUserData(userData, join(legacy, 'missing'))).toEqual([]);
    expect(migrateLegacyUserData(legacy, legacy)).toEqual([]);
  });

  it('gives dev-installed and packaged builds the same app name and single-instance lock', () => {
    const repoRoot = resolve(import.meta.dirname, '../..');
    const pkg = JSON.parse(readFileSync(resolve(repoRoot, 'desktop-ui/package.json'), 'utf8'));
    const builder = readFileSync(resolve(repoRoot, 'desktop-ui/electron-builder.yml'), 'utf8');
    const runtime = readFileSync(resolve(repoRoot, 'scripts/prepare-desktop-runtime.mjs'), 'utf8');
    expect(pkg.productName).toBe('Working Memory');
    expect(builder).toContain(`productName: ${pkg.productName}`);
    expect(runtime).toContain(`productName: '${pkg.productName}'`);
  });
});
