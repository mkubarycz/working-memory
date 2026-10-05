import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DesktopCredentialVault } from '../src/main/credentialVault';

const temporaryDirectories: string[] = [];

function temporaryKeyFile(): string {
  const directory = mkdtempSync(join(tmpdir(), 'working-memory-credentials-'));
  temporaryDirectories.push(directory);
  return join(directory, 'credential-vault.key');
}

function nativeStorage() {
  return {
    isEncryptionAvailable: vi.fn(() => true),
    encryptString: vi.fn((value: string) => Buffer.from(`native:${value}`)),
    decryptString: vi.fn((value: Buffer) => value.toString().replace(/^native:/, '')),
  };
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe('DesktopCredentialVault', () => {
  it('uses a private local AES-GCM vault on macOS without native storage access', () => {
    const native = nativeStorage();
    const keyFile = temporaryKeyFile();
    const vault = new DesktopCredentialVault(native, 'darwin', keyFile);
    const config = vault.store({ endpoint: 'https://example.test', model: 'test' }, 'secret');

    expect(config.encryptedApiKey).toMatch(/^wm-local-v1:/);
    expect(vault.decrypt(config)).toBe('secret');
    expect(vault.mode()).toBe('local');
    expect(native.encryptString).not.toHaveBeenCalled();
    expect(native.decryptString).not.toHaveBeenCalled();
    expect(readFileSync(keyFile)).toHaveLength(32);
    expect(statSync(keyFile).mode & 0o777).toBe(0o600);
  });

  it('migrates legacy macOS Safe Storage ciphertext exactly once', () => {
    const native = nativeStorage();
    const vault = new DesktopCredentialVault(native, 'darwin', temporaryKeyFile());
    const legacy = {
      endpoint: 'https://example.test',
      model: 'test',
      encryptedApiKey: Buffer.from('native:secret').toString('base64'),
    };

    const migrated = vault.migrate(legacy);

    expect(migrated.encryptedApiKey).toMatch(/^wm-local-v1:/);
    expect(vault.decrypt(migrated)).toBe('secret');
    expect(vault.migrate(migrated)).toBe(migrated);
    expect(native.decryptString).toHaveBeenCalledTimes(1);
  });

  it('uses OS-backed storage on Windows', () => {
    const native = nativeStorage();
    const vault = new DesktopCredentialVault(native, 'win32', temporaryKeyFile());
    const config = vault.store({ endpoint: 'https://example.test', model: 'test' }, 'secret');

    expect(config.encryptedApiKey).toBe(Buffer.from('native:secret').toString('base64'));
    expect(vault.decrypt(config)).toBe('secret');
    expect(vault.mode()).toBe('secure');
    expect(native.encryptString).toHaveBeenCalledTimes(1);
    expect(native.decryptString).toHaveBeenCalledTimes(1);
  });

  it('rejects modified local ciphertext', () => {
    const vault = new DesktopCredentialVault(nativeStorage(), 'darwin', temporaryKeyFile());
    const config = vault.store({ endpoint: 'https://example.test', model: 'test' }, 'secret');
    const encryptedApiKey = config.encryptedApiKey!;
    const modified = `${encryptedApiKey.slice(0, -2)}AA`;

    expect(() => vault.decrypt({ ...config, encryptedApiKey: modified })).toThrow();
  });
});
