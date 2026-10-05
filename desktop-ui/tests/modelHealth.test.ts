import { describe, expect, it, vi } from 'vitest';
import { checkConfiguredModel } from '../src/main/modelHealth';

describe('configured model health', () => {
  it('reports an unconfigured model without making a request', async () => {
    const probe = vi.fn();

    await expect(checkConfiguredModel({
      endpoint: 'https://api.openai.com/v1',
      model: '',
    }, probe)).resolves.toEqual({
      ok: false,
      message: 'Choose a model first.',
    });
    expect(probe).not.toHaveBeenCalled();
  });

  it('reports successful startup connectivity', async () => {
    await expect(checkConfiguredModel({
      endpoint: 'https://api.openai.com/v1',
      model: 'gpt-test',
    }, async () => 'Connected.')).resolves.toEqual({
      ok: true,
      message: 'Connected.',
    });
  });

  it('surfaces missing credentials and endpoint failures', async () => {
    await expect(checkConfiguredModel({
      endpoint: 'https://api.openai.com/v1',
      model: 'gpt-test',
    }, async () => {
      throw new Error('Model endpoint returned HTTP 401. Check the API key.');
    })).resolves.toEqual({
      ok: false,
      message: 'Model endpoint returned HTTP 401. Check the API key.',
    });
  });
});
