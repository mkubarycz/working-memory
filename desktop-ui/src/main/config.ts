import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';

export const DEFAULT_ENDPOINT = 'http://localhost:11434/v1';
export const DEFAULT_MODEL_PROFILE_ID = 'default';
export const DEFAULT_HUMAN_NAME = 'Flesh Bag';

export type AiSpeed = 'slow' | 'medium' | 'fast';
export type AiDepth = 'simple' | 'complex' | 'deep';
export type AiRouteKey = `${AiDepth}:${AiSpeed}`;

export interface StoredModelProfile {
  id: string;
  name: string;
  endpoint: string;
  model: string;
  encryptedApiKey?: string;
}

export interface StoredConfig {
  endpoint: string;
  model: string;
  encryptedApiKey?: string;
  humanName?: string;
  profiles?: StoredModelProfile[];
  routing?: Partial<Record<AiRouteKey, string>>;
}

export interface CredentialStorage {
  isEncryptionAvailable(): boolean;
  encryptString(value: string): Buffer;
  decryptString(value: Buffer): string;
}

export type CredentialStorageMode = 'secure' | 'local' | 'session' | 'unavailable';

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

export function publicConfig(config: StoredConfig, credentialStorage: CredentialStorageMode = 'secure'): {
  endpoint: string;
  model: string;
  hasApiKey: boolean;
  credentialStorage: CredentialStorageMode;
  humanName: string;
  profiles: Array<{
    id: string;
    name: string;
    endpoint: string;
    model: string;
    hasApiKey: boolean;
  }>;
  routing: Record<AiRouteKey, string>;
} {
  const profiles = modelProfiles(config);
  const primary = profiles[0];
  return {
    endpoint: primary.endpoint,
    model: primary.model,
    hasApiKey: Boolean(primary.encryptedApiKey),
    credentialStorage,
    humanName: config.humanName?.trim() || DEFAULT_HUMAN_NAME,
    profiles: profiles.map((profile) => ({
      id: profile.id,
      name: profile.name,
      endpoint: profile.endpoint,
      model: profile.model,
      hasApiKey: Boolean(profile.encryptedApiKey),
    })),
    routing: modelRouting(config, primary.id),
  };
}

export async function readStoredConfig(file: string): Promise<StoredConfig> {
  try {
    const parsed = JSON.parse(await readFile(file, 'utf8')) as Partial<StoredConfig>;
    const config: StoredConfig = {
      endpoint: normalizeEndpoint(parsed.endpoint ?? ''),
      model: typeof parsed.model === 'string' ? parsed.model.trim() : '',
      ...(typeof parsed.encryptedApiKey === 'string' && parsed.encryptedApiKey
        ? { encryptedApiKey: parsed.encryptedApiKey }
        : {}),
      ...(typeof parsed.humanName === 'string' ? { humanName: parsed.humanName.trim() } : {}),
      ...(Array.isArray(parsed.profiles)
        ? {
            profiles: parsed.profiles
              .filter((profile): profile is StoredModelProfile => (
                typeof profile === 'object'
                && profile !== null
                && typeof profile.id === 'string'
                && typeof profile.name === 'string'
                && typeof profile.endpoint === 'string'
                && typeof profile.model === 'string'
              ))
              .map((profile) => ({
                id: profile.id.trim(),
                name: profile.name.trim(),
                endpoint: normalizeEndpoint(profile.endpoint),
                model: profile.model.trim(),
                ...(typeof profile.encryptedApiKey === 'string' && profile.encryptedApiKey
                  ? { encryptedApiKey: profile.encryptedApiKey }
                  : {}),
              }))
              .filter((profile) => profile.id && profile.name),
          }
        : {}),
      ...(typeof parsed.routing === 'object' && parsed.routing !== null
        ? { routing: parsed.routing as Partial<Record<AiRouteKey, string>> }
        : {}),
    };
    return normalizeModelConfig(config);
  } catch {
    return normalizeModelConfig({ endpoint: DEFAULT_ENDPOINT, model: '' });
  }
}

export async function writeStoredConfig(file: string, config: StoredConfig): Promise<void> {
  await mkdir(dirname(file), { recursive: true });
  await writeFile(file, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
}

export function modelProfiles(config: StoredConfig): StoredModelProfile[] {
  if (config.profiles?.length) {
    return config.profiles.map((profile) => ({
      ...profile,
      endpoint: normalizeEndpoint(profile.endpoint),
      model: profile.model.trim(),
    }));
  }
  return [{
    id: DEFAULT_MODEL_PROFILE_ID,
    name: 'Default',
    endpoint: normalizeEndpoint(config.endpoint),
    model: config.model.trim(),
    ...(config.encryptedApiKey ? { encryptedApiKey: config.encryptedApiKey } : {}),
  }];
}

export function modelRouting(
  config: StoredConfig,
  fallbackProfileId = modelProfiles(config)[0]?.id ?? DEFAULT_MODEL_PROFILE_ID,
): Record<AiRouteKey, string> {
  const profileIds = new Set(modelProfiles(config).map((profile) => profile.id));
  const result = {} as Record<AiRouteKey, string>;
  for (const depth of ['simple', 'complex', 'deep'] as const) {
    for (const speed of ['slow', 'medium', 'fast'] as const) {
      const key: AiRouteKey = `${depth}:${speed}`;
      const selected = config.routing?.[key];
      result[key] = selected && profileIds.has(selected) ? selected : fallbackProfileId;
    }
  }
  return result;
}

export function resolveModelProfile(
  config: StoredConfig,
  speed: AiSpeed,
  depth: AiDepth,
): StoredModelProfile {
  const profiles = modelProfiles(config);
  const selectedId = modelRouting(config, profiles[0]?.id)[`${depth}:${speed}`];
  return profiles.find((profile) => profile.id === selectedId) ?? profiles[0];
}

export function normalizeModelConfig(config: StoredConfig): StoredConfig {
  const profiles = modelProfiles(config);
  const primary = profiles[0];
  return {
    endpoint: primary.endpoint,
    model: primary.model,
    ...(primary.encryptedApiKey ? { encryptedApiKey: primary.encryptedApiKey } : {}),
    humanName: config.humanName?.trim() || DEFAULT_HUMAN_NAME,
    profiles,
    routing: modelRouting({ ...config, profiles }, primary.id),
  };
}