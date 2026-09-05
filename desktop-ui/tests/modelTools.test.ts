import { describe, expect, it } from 'vitest';
import {
  appendToolResults,
  createModelConversation,
  desktopToolDescriptors,
  isDestructiveTool,
  modelTurnRequest,
  parseModelTurn,
} from '../src/main/modelTools';

const tools = [
  { name: 'ws-workstream-read', description: 'Read workstreams', inputSchema: { type: 'object', properties: {} } },
  { name: 'ws-topic-create', description: 'Create topic', inputSchema: { type: 'object', required: ['title'] } },
  { name: 'ws-topictype-read' },
  { name: 'ws-alert-update' },
  { name: 'ws-nanite-run' },
  { name: 'ws-nanitetemplate-create' },
  { name: 'ws-nanitejournal-read' },
  { name: 'ws-config-read' },
  { name: 'wm-document-read' },
];

describe('desktop model tools', () => {
  it('projects the supported high-level ws suite from canonical descriptors', () => {
    expect(desktopToolDescriptors(tools).map((tool) => tool.name)).toEqual([
      'ws-workstream-read',
      'ws-topic-create',
      'ws-topictype-read',
      'ws-alert-update',
      'ws-nanite-run',
      'ws-nanitetemplate-create',
      'ws-nanitejournal-read',
      'ws-config-read',
    ]);
  });

  it('classifies delete and nanite reset calls as destructive', () => {
    expect(isDestructiveTool('ws-topic-delete', { slug: 'x' })).toBe(true);
    expect(isDestructiveTool('ws-topic-delete', { slug: 'x', restore: true })).toBe(false);
    expect(isDestructiveTool('ws-nanite-run', { id: 'x', reset: true })).toBe(true);
  });

  it('continues Chat Completions with the assistant call and every tool result', () => {
    const conversation = createModelConversation({
      mode: 'chat-completions', model: 'test', systemPrompt: 'system', userMessage: 'read', tools,
    });
    const turn = parseModelTurn('chat-completions', { choices: [{ message: {
      role: 'assistant', content: null, tool_calls: [
        { id: 'a', type: 'function', function: { name: 'ws-workstream-read', arguments: '{}' } },
        { id: 'b', type: 'function', function: { name: 'ws-topic-create', arguments: '{"title":"One"}' } },
      ],
    } }] });
    appendToolResults(conversation, turn, turn.calls.map((call) => ({ call, output: { ok: true } })));
    expect(turn.calls).toHaveLength(2);
    expect(modelTurnRequest(conversation).messages).toEqual(expect.arrayContaining([
      expect.objectContaining({ role: 'assistant' }),
      expect.objectContaining({ role: 'tool', tool_call_id: 'a' }),
      expect.objectContaining({ role: 'tool', tool_call_id: 'b' }),
    ]));
  });

  it('continues Responses with previous_response_id and function outputs', () => {
    const conversation = createModelConversation({
      mode: 'responses', model: 'test', systemPrompt: 'system', userMessage: 'read', tools,
    });
    const turn = parseModelTurn('responses', { id: 'resp_1', output: [
      { type: 'function_call', call_id: 'a', name: 'ws-workstream-read', arguments: '{}' },
      { type: 'function_call', call_id: 'b', name: 'ws-topic-read', arguments: '{"query":"roadmap"}' },
    ] });
    appendToolResults(conversation, turn, turn.calls.map((call) => ({ call, output: { ok: true } })));
    expect(modelTurnRequest(conversation)).toMatchObject({
      previous_response_id: 'resp_1',
      input: [
        { type: 'function_call_output', call_id: 'a' },
        { type: 'function_call_output', call_id: 'b' },
      ],
    });
  });
});