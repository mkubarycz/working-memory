import { describe, expect, it } from 'vitest';
import { CopilotClient } from '@github/copilot-sdk';
import { copilotConnection, LocalCopilotProvider } from '../src/main/copilotProvider';
import { appendToolResults, createModelConversation } from '../src/main/modelTools';
import { systemPromptForContext } from '../src/main/desktopChatAgent';

describe.runIf(process.env.WM_COPILOT_SMOKE === '1')('local Copilot live smoke', () => {
  it('looks up eight case numbers and saves verified links instead of stopping after the MBR read', async () => {
    let lastReply = '';
    const provider = new LocalCopilotProvider(gitHubToken => {
      const client = new CopilotClient({
        connection: copilotConnection(), ...(gitHubToken ? { gitHubToken } : {}), logLevel: 'error',
      });
      const createSession = client.createSession.bind(client);
      client.createSession = async config => {
        const session = await createSession(config);
        const sendAndWait = session.sendAndWait.bind(session);
        session.sendAndWait = async (...args) => {
          const response = await sendAndWait(...args);
          lastReply = response?.data.content ?? '';
          return response;
        };
        return session;
      };
      return client;
    });
    const numbers = Array.from({ length: 8 }, (_, index) => `26102600400069${56 + index}`);
    const original = `# October MBR\n\n${numbers.map(number => `- ${number}`).join('\n')}\n\nKeep this summary unchanged.`;
    let body = original;
    const cases = numbers.map((number, index) => ({
      id: `case-${index}`, title: `${number} - Case notes`, body: `Support case ${number}.`,
    }));
    const calls: Array<{ name: string; arguments: Record<string, unknown> }> = [];
    const conversation = createModelConversation({
      mode: 'chat-completions', model: process.env.WM_COPILOT_SMOKE_MODEL ?? 'gpt-5.4-mini',
      systemPrompt: systemPromptForContext({ kind: 'Topic', routeKind: 'topic', identifier: 'mbr', title: 'October MBR' }),
      userMessage: 'For each of the cases listed in this mbr, add a link to their associated working memory document.',
      tools: [{
        name: 'ws-topic-read',
        description: 'Read one topic by id or list topics using a case-insensitive query over title and body. Always returns {count,topics}.',
        inputSchema: { type: 'object', properties: { id: { type: 'string' }, query: { type: 'string' }, limit: { type: 'integer' } }, additionalProperties: false },
      }, {
        name: 'ws-topic-update', description: 'Update the body of an existing topic by id.',
        inputSchema: { type: 'object', properties: { id: { type: 'string' }, body: { type: 'string' } }, required: ['id', 'body'], additionalProperties: false },
      }],
    });
    try {
      let completed = false;
      for (let iteration = 0; iteration < 16; iteration++) {
        const turn = await provider.turn(conversation, 60_000, new AbortController().signal);
        if (!turn.calls.length) { completed = true; break; }
        const results = turn.calls.map(call => {
          calls.push(call);
          const args = call.arguments;
          if (call.name === 'ws-topic-update') {
            expect(args.id).toBe('mbr');
            expect(typeof args.body).toBe('string');
            body = String(args.body);
            return { call, output: { ok: true, result: { id: 'mbr', title: 'October MBR', body } } };
          }
          const topics = [{ id: 'mbr', title: 'October MBR', body }, ...cases].filter(topic =>
            args.id ? topic.id === args.id
              : !args.query || JSON.stringify(topic).toLowerCase().includes(String(args.query).toLowerCase()));
          return { call, output: { ok: true, result: { count: topics.length, topics } } };
        });
        appendToolResults(conversation, turn, results);
      }
      expect(completed).toBe(true);
      expect(body).toContain('# October MBR');
      expect(body).toContain('Keep this summary unchanged.');
      for (const [index, number] of numbers.entries()) {
        expect(body).toContain(number);
        expect(body).toContain(`working-memory://open/topic/case-${index}`);
      }
      expect(calls.some(call => call.name === 'ws-topic-read' && call.arguments.query)).toBe(true);
      const updateIndex = calls.findIndex(call => call.name === 'ws-topic-update');
      expect(updateIndex).toBeGreaterThan(0);
      expect(calls.slice(updateIndex + 1).some(call => call.name === 'ws-topic-read' && call.arguments.id === 'mbr')).toBe(true);
    } catch (error) {
      throw new Error(`Synthetic case-linking run failed after ${calls.length} tool calls. Last reply: ${lastReply}`, { cause: error });
    } finally {
      await provider.stop();
    }
  }, 240_000);

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
