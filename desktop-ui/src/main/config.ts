import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';

export const DEFAULT_ENDPOINT = 'http://localhost:11434/v1';

export interface StoredConfig {
  endpoint: string;
  model: string;
  encryptedApiKey?: string;
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