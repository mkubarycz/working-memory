import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';

export const DEFAULT_ENDPOINT = 'http://localhost:11434/v1';

export interface StoredConfig {
  endpoint: string;
  model: string;
  encryptedApiKey?: string;
}

export interface CredentialStorage {
  isEncryptionAvailable(): boolean;
  encryptString(value: string): Buffer;
  decryptString(value: Buffer): string;
}

export type CredentialStorageMode = 'secure' | 'session' | 'unavailable';

export class CredentialManager {
  private sessionApiKey = '';
  private warnedUnavailable = false;

  constructor(
    private readonly storage: CredentialStorage,
    private readonly warn: (message: string) => void = console.warn,
  ) {}

  read(config: StoredConfig): string {
    if (this.sessionApiKey) return this.sessionApiKey;
    if (!config.encryptedApiKey) return '';
    if (!this.storage.isEncryptionAvailable()) {
      this.warnUnavailable();
      return '';
    }
    try {
      return this.storage.decryptString(Buffer.from(config.encryptedApiKey, 'base64'));
    } catch (error) {
      this.warn(
        `Stored API key could not be decrypted; re-enter it in Settings. ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
      return '';
    }
  }

  store(config: StoredConfig, apiKey?: string): StoredConfig {
    const value = apiKey?.trim();
    if (!value) return config;
    if (this.storage.isEncryptionAvailable()) {
      this.sessionApiKey = '';
      return {
        ...config,
        encryptedApiKey: this.storage.encryptString(value).toString('base64'),
      };
    }
    this.sessionApiKey = value;
    this.warnUnavailable();
    return config;
  }

  hasApiKey(config: StoredConfig): boolean {
    return Boolean(this.read(config));
  }

  mode(): CredentialStorageMode {
    if (this.storage.isEncryptionAvailable()) return 'secure';
    return this.sessionApiKey ? 'session' : 'unavailable';
  }

  private warnUnavailable(): void {
    if (this.warnedUnavailable) return;
    this.warnedUnavailable = true;
    this.warn(
      'OS-backed credential storage is unavailable; API keys will remain in memory for this app session only.',
    );
  }
}

export type ModelEndpointMode = 'chat-completions' | 'responses';

export function normalizeEndpoint(value: string): string {
  return (value.trim() || DEFAULT_ENDPOINT).replace(/\/+$/, '');
}

export function chatCompletionsUrl(endpoint: string): string {
  const base = normalizeEndpoint(endpoint);
  return base.endsWith('/chat/completions') ? base : `${base}/chat/completions`;
}

export function modelEndpoint(endpoint: string): { mode: ModelEndpointMode; url: string } {
  const normalized = normalizeEndpoint(endpoint);
  if (normalized.endsWith('/responses')) return { mode: 'responses', url: normalized };
  return { mode: 'chat-completions', url: chatCompletionsUrl(normalized) };
}

export function modelAuthHeaders(url: string, apiKey: string): Record<string, string> {
  if (!apiKey) return {};
  try {
    if (new URL(url).hostname.endsWith('.azure.com')) return { 'api-key': apiKey };
  } catch {
    // Fetch will report the invalid endpoint with more context.
  }
  return { authorization: `Bearer ${apiKey}` };
}

export function publicConfig(config: StoredConfig): {
  endpoint: string;
  model: string;
  hasApiKey: boolean;
} {
  return {
    endpoint: normalizeEndpoint(config.endpoint),
    model: config.model.trim(),
    hasApiKey: Boolean(config.encryptedApiKey),
  };
}

export async function readStoredConfig(file: string): Promise<StoredConfig> {
  try {
    const parsed = JSON.parse(await readFile(file, 'utf8')) as Partial<StoredConfig>;
    return {
      endpoint: normalizeEndpoint(parsed.endpoint ?? ''),
      model: typeof parsed.model === 'string' ? parsed.model.trim() : '',
      ...(typeof parsed.encryptedApiKey === 'string' && parsed.encryptedApiKey
        ? { encryptedApiKey: parsed.encryptedApiKey }
        : {}),
    };
  } catch {
    return { endpoint: DEFAULT_ENDPOINT, model: '' };
  }
}

export async function writeStoredConfig(file: string, config: StoredConfig): Promise<void> {
  await mkdir(dirname(file), { recursive: true });
  await writeFile(file, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
}