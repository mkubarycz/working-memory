import { describe, expect, it } from 'vitest';
import {
  chatCompletionsUrl,
  modelAuthHeaders,
  modelEndpoint,
  normalizeEndpoint,
  publicConfig,
} from '../src/main/config';

describe('desktop config', () => {
  it('normalizes endpoint paths without exposing encrypted credentials', () => {
    expect(normalizeEndpoint(' https://models.example/v1/ ')).toBe('https://models.example/v1');
    expect(chatCompletionsUrl('https://models.example/v1')).toBe('https://models.example/v1/chat/completions');
    expect(publicConfig({ endpoint: 'https://models.example/v1', model: 'demo', encryptedApiKey: 'ciphertext' }))
      .toEqual({ endpoint: 'https://models.example/v1', model: 'demo', hasApiKey: true });
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

});