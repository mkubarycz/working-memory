import {
  createCipheriv,
  createDecipheriv,
  randomBytes,
} from 'node:crypto';
import {
  chmodSync,
  closeSync,
  mkdirSync,
  openSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import { dirname } from 'node:path';
import type { CredentialStorageMode, StoredConfig } from './config';

const LOCAL_CREDENTIAL_PREFIX = 'wm-local-v1:';
const LOCAL_KEY_BYTES = 32;
const IV_BYTES = 12;
const AUTH_TAG_BYTES = 16;

export interface NativeCredentialStorage {
  isEncryptionAvailable(): boolean;
  encryptString(value: string): Buffer;
  decryptString(value: Buffer): string;
}

export class DesktopCredentialVault {
  constructor(
    private readonly nativeStorage: NativeCredentialStorage,
    private readonly platform: NodeJS.Platform,
    private readonly localKeyFile: string,
  ) {}

  mode(): CredentialStorageMode {
    if (this.platform === 'darwin') return 'local';
    return this.nativeStorage.isEncryptionAvailable() ? 'secure' : 'unavailable';
  }

  decrypt(config: StoredConfig): string {
    const encrypted = config.encryptedApiKey;
    if (!encrypted) return '';
    if (encrypted.startsWith(LOCAL_CREDENTIAL_PREFIX)) {
      return this.decryptLocal(encrypted.slice(LOCAL_CREDENTIAL_PREFIX.length));
    }
    if (!this.nativeStorage.isEncryptionAvailable()) {
      throw new Error('OS-backed credential storage is unavailable on this system');
    }
    return this.nativeStorage.decryptString(Buffer.from(encrypted, 'base64'));
  }

  store(config: StoredConfig, apiKey?: string): StoredConfig {
    const value = apiKey?.trim();
    if (!value) return config;
    if (this.platform === 'darwin') {
      return { ...config, encryptedApiKey: this.encryptLocal(value) };
    }
    if (!this.nativeStorage.isEncryptionAvailable()) {
      throw new Error('OS-backed credential storage is unavailable on this system');
    }
    return {
      ...config,
      encryptedApiKey: this.nativeStorage.encryptString(value).toString('base64'),
    };
  }

  migrate(config: StoredConfig): StoredConfig {
    if (this.platform !== 'darwin') return config;
    const migrateOne = <T extends StoredConfig>(candidate: T): T => {
      const encrypted = candidate.encryptedApiKey;
      if (!encrypted || encrypted.startsWith(LOCAL_CREDENTIAL_PREFIX)) return candidate;
      return this.store(candidate, this.decrypt(candidate)) as T;
    };
    const migrated = migrateOne(config);
    const profiles = migrated.profiles?.map((profile) =>
      migrateOne({ ...profile, profiles: undefined, routing: undefined }));
    return profiles ? { ...migrated, profiles } : migrated;
  }

  private encryptLocal(value: string): string {
    const iv = randomBytes(IV_BYTES);
    const cipher = createCipheriv('aes-256-gcm', this.localKey(), iv);
    const ciphertext = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]);
    return `${LOCAL_CREDENTIAL_PREFIX}${Buffer.concat([
      iv,
      cipher.getAuthTag(),
      ciphertext,
    ]).toString('base64')}`;
  }

  private decryptLocal(encoded: string): string {
    const payload = Buffer.from(encoded, 'base64');
    if (payload.length <= IV_BYTES + AUTH_TAG_BYTES) {
      throw new Error('Stored local credential is malformed');
    }
    const iv = payload.subarray(0, IV_BYTES);
    const authTag = payload.subarray(IV_BYTES, IV_BYTES + AUTH_TAG_BYTES);
    const ciphertext = payload.subarray(IV_BYTES + AUTH_TAG_BYTES);
    const decipher = createDecipheriv('aes-256-gcm', this.localKey(), iv);
    decipher.setAuthTag(authTag);
    return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8');
  }

  private localKey(): Buffer {
    try {
      const existing = readFileSync(this.localKeyFile);
      if (existing.length !== LOCAL_KEY_BYTES) {
        throw new Error('Local credential key has an invalid length');
      }
      return existing;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }

    mkdirSync(dirname(this.localKeyFile), { recursive: true });
    const key = randomBytes(LOCAL_KEY_BYTES);
    try {
      const descriptor = openSync(this.localKeyFile, 'wx', 0o600);
      try {
        writeFileSync(descriptor, key);
      } finally {
        closeSync(descriptor);
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      const existing = readFileSync(this.localKeyFile);
      if (existing.length !== LOCAL_KEY_BYTES) {
        throw new Error('Local credential key has an invalid length');
      }
      return existing;
    }
    chmodSync(this.localKeyFile, 0o600);
    return key;
  }
}
