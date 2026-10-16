import { describe, expect, it } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  chatCompletionsUrl,
  CredentialManager,
  modelAuthHeaders,
  modelEndpoint,
  resolveModelProfile,
  normalizeEndpoint,
  publicConfig,
  normalizeModelConfig,
  readStoredConfig,
  writeStoredConfig,
} from '../src/main/config';

describe('desktop config', () => {
  it('normalizes endpoint paths without exposing encrypted credentials', () => {
    expect(normalizeEndpoint(' https://models.example/v1/ ')).toBe('https://models.example/v1');
    expect(chatCompletionsUrl('https://models.example/v1')).toBe('https://models.example/v1/chat/completions');
    expect(publicConfig({ endpoint: 'https://models.example/v1', model: 'demo', encryptedApiKey: 'ciphertext' }))
      .toEqual({
        endpoint: 'https://models.example/v1',
        model: 'demo',
        hasApiKey: true,
        credentialStorage: 'secure',
        humanName: 'Flesh Bag',
        profiles: [{
          id: 'default',
          name: 'Default',
          provider: 'openai-compatible',
          endpoint: 'https://models.example/v1',
          model: 'demo',
          hasApiKey: true,
        }],
        routing: {
          'simple:slow': 'default',
          'simple:medium': 'default',
          'simple:fast': 'default',
          'complex:slow': 'default',
          'complex:medium': 'default',
          'complex:fast': 'default',
          'deep:slow': 'default',
          'deep:medium': 'default',
          'deep:fast': 'default',
        },
      });

  });

  it('persists mixed providers and keeps each of the nine routes on its selected profile', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'wm-provider-config-'));
    try {
      const config = normalizeModelConfig({
        endpoint: 'https://example.services.ai.azure.com/openai/v1/responses',
        model: 'azure-model',
        profiles: [
          { id: 'azure', name: 'Azure', endpoint: 'https://example.services.ai.azure.com/openai/v1/responses', model: 'azure-model', encryptedApiKey: 'azure-secret' },
          { id: 'copilot', name: 'Copilot', provider: 'copilot', endpoint: '', model: 'auto' },
        ],
        routing: { 'complex:medium': 'copilot', 'simple:fast': 'copilot' },
      });
      const file = join(directory, 'config.json');
      await writeStoredConfig(file, config);
      const restored = await readStoredConfig(file);
      expect(resolveModelProfile(restored, 'medium', 'complex').provider).toBe('copilot');
      expect(resolveModelProfile(restored, 'fast', 'simple').provider).toBe('copilot');
      expect(resolveModelProfile(restored, 'slow', 'deep')).toMatchObject({
        provider: 'openai-compatible', model: 'azure-model', encryptedApiKey: 'azure-secret',
      });
      expect(Object.keys(publicConfig(restored).routing)).toHaveLength(9);
      expect(publicConfig(restored).profiles[1]).toMatchObject({ provider: 'copilot', hasApiKey: false });
      expect(JSON.stringify(publicConfig(restored))).not.toContain('azure-secret');
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('defaults fresh installs to Copilot on every route instead of a local Ollama server', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'wm-fresh-config-'));
    try {
      const fresh = await readStoredConfig(join(directory, 'missing.json'));
      expect(publicConfig(fresh).profiles).toEqual([expect.objectContaining({
        id: 'default', name: 'GitHub Copilot', provider: 'copilot', model: 'auto', hasApiKey: false,
      })]);
      expect(new Set(Object.values(publicConfig(fresh).routing))).toEqual(new Set(['default']));
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('preserves Copilot as the primary provider on reload', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'wm-primary-provider-'));
    try {
      const file = join(directory, 'config.json');
      await writeStoredConfig(file, normalizeModelConfig({ provider: 'copilot', endpoint: '', model: 'auto' }));
      expect(await readStoredConfig(file)).toMatchObject({ provider: 'copilot' });
      expect(publicConfig(await readStoredConfig(file)).profiles[0].provider).toBe('copilot');
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('resolves each request through the configured speed and depth route', () => {
    const config = {
      endpoint: 'http://localhost:11434/v1',
      model: 'primary',
      profiles: [
        { id: 'primary', name: 'Primary', endpoint: 'http://localhost:11434/v1', model: 'large' },
        { id: 'quick', name: 'Quick', endpoint: 'http://localhost:11434/v1', model: 'small' },
      ],
      routing: { 'simple:fast': 'quick' },
    };
    expect(resolveModelProfile(config, 'fast', 'simple').id).toBe('quick');
    expect(resolveModelProfile(config, 'medium', 'complex').id).toBe('primary');
  });

  it('preserves Responses endpoints and resolves other endpoints to Chat Completions', () => {
    expect(modelEndpoint('https://models.example/v1')).toEqual({
      mode: 'chat-completions',
      url: 'https://models.example/v1/chat/completions',
    });
    expect(modelEndpoint('https://models.example/v1/chat/completions/')).toEqual({
      mode: 'chat-completions',
      url: 'https://models.example/v1/chat/completions',
    });
    expect(modelEndpoint('https://example.services.ai.azure.com/openai/v1/responses')).toEqual({
      mode: 'responses',
      url: 'https://example.services.ai.azure.com/openai/v1/responses',
    });
  });

  it('uses Azure API-key auth and bearer auth for standard OpenAI-compatible hosts', () => {
    expect(modelAuthHeaders('https://example.services.ai.azure.com/openai/v1/responses', 'secret'))
      .toEqual({ 'api-key': 'secret' });
    expect(modelAuthHeaders('https://api.openai.com/v1/responses', 'secret'))
      .toEqual({ authorization: 'Bearer secret' });
    expect(modelAuthHeaders('http://localhost:11434/v1/chat/completions', ''))
      .toEqual({});
  });

  it('keeps API keys in memory when secure storage is unavailable', () => {
    const warnings: string[] = [];
    const credentials = new CredentialManager(
      {
        isEncryptionAvailable: () => false,
        encryptString: () => {
          throw new Error('must not encrypt');
        },
        decryptString: () => {
          throw new Error('must not decrypt');
        },
      },
      (message) => warnings.push(message),
    );
    const config = credentials.store(
      { endpoint: 'https://models.example/v1', model: 'demo' },
      'session-secret',
    );

    expect(config.encryptedApiKey).toBeUndefined();
    expect(credentials.read(config)).toBe('session-secret');
    expect(credentials.hasApiKey(config)).toBe(true);
    expect(credentials.mode()).toBe('session');
    expect(warnings).toHaveLength(1);
  });

  it('ignores an unreadable persisted API key without blocking keyless endpoints', () => {
    const warnings: string[] = [];
    const credentials = new CredentialManager(
      {
        isEncryptionAvailable: () => false,
        encryptString: () => {
          throw new Error('must not encrypt');
        },
        decryptString: () => {
          throw new Error('must not decrypt');
        },
      },
      (message) => warnings.push(message),
    );
    const config = {
      endpoint: 'http://localhost:11434/v1',
      model: 'local',
      encryptedApiKey: 'legacy-ciphertext',
    };

    expect(credentials.read(config)).toBe('');
    expect(credentials.hasApiKey(config)).toBe(false);
    expect(credentials.mode()).toBe('unavailable');
    expect(warnings).toHaveLength(1);
  });
});