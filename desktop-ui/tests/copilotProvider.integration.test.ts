import { describe, expect, it } from 'vitest';
import { LocalCopilotProvider } from '../src/main/copilotProvider';
import { appendToolResults, createModelConversation } from '../src/main/modelTools';

describe.runIf(process.env.WM_COPILOT_SMOKE === '1')('local Copilot live smoke', () => {
  it('discovers models and completes a model-only tool round trip with the signed-in CLI', async () => {
    const provider = new LocalCopilotProvider();
    try {
      const available = await provider.listModels();
      expect(available.account).toBeTruthy();
      expect(available.models.length).toBeGreaterThan(0);
      const model = process.env.WM_COPILOT_SMOKE_MODEL ?? 'gpt-5.4-mini';
      expect(await provider.complete(model, 'Reply with only: connected', 60_000)).toMatch(/connected/i);
      const conversation = createModelConversation({
        mode: 'chat-completions',
        model,
        systemPrompt: 'You are testing the host tool protocol. Use the requested tool before answering.',
        userMessage: 'Use ws-topic-read with id smoke-topic, then tell me its title.',
        tools: [{
          name: 'ws-topic-read',
          description: 'Read a topic by its id.',
          inputSchema: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] },
        }],
      });
      const signal = new AbortController().signal;
      const first = await provider.turn(conversation, 60_000, signal);
      expect(first.calls).toHaveLength(1);
      expect(first.calls[0]).toMatchObject({ name: 'ws-topic-read', arguments: { id: 'smoke-topic' } });
      appendToolResults(conversation, first, [{
        call: first.calls[0],
        output: { ok: true, result: { title: 'Synthetic Copilot Smoke Topic' } },
      }]);
      const second = await provider.turn(conversation, 60_000, signal);
      expect(second.calls).toHaveLength(0);
      expect(second.text).toContain('Synthetic Copilot Smoke Topic');
      const autocomplete = await provider.complete(model,
        'Suggest a topic title and type for "Test local Copilot authentication". Return only JSON with string fields title and topicType. The only allowed topicType is topic.',
        60_000);
      expect(JSON.parse(autocomplete)).toMatchObject({ title: expect.any(String), topicType: 'topic' });
    } finally {
      await provider.stop();
    }
  }, 240_000);
});
