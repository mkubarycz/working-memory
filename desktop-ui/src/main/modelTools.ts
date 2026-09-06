import type { CanonicalToolDef } from '../../../src/controlPlaneClient';
import type { ModelEndpointMode } from './config';

export interface ModelToolCall {
  id: string;
  name: string;
  arguments: Record<string, unknown>;
  argumentError?: string;
}

export interface ParsedModelTurn {
  id?: string;
  text: string;
  calls: ModelToolCall[];
  assistantMessage?: Record<string, unknown>;
  finishReason?: string;
  usage?: {
    inputTokens?: number;
    outputTokens?: number;
    totalTokens?: number;
  };
  contentParts?: Array<{ type: 'text' | 'reasoning'; text: string }>;
}

export interface ModelConversation {
  mode: ModelEndpointMode;
  model: string;
  systemPrompt: string;
  userMessage: string;
  tools: CanonicalToolDef[];
  chatMessages?: Record<string, unknown>[];
  previousResponseId?: string;
  responseInput?: Record<string, unknown>[];
}

const DESKTOP_TOOL_FAMILIES = [
  'workstream',
  'topic',
  'topictype',
  'alert',
  'config',
  'nanite',
  'nanitetemplate',
  'nanitejournal',
];

export function desktopToolDescriptors(tools: CanonicalToolDef[]): CanonicalToolDef[] {
  return tools.filter((tool) => DESKTOP_TOOL_FAMILIES.some((family) => tool.name.startsWith(`ws-${family}-`)));
}

export function isDestructiveTool(name: string, args: Record<string, unknown>): boolean {
  if (/-delete$/.test(name)) return args.restore !== true;
  return name === 'ws-nanite-run' && args.reset === true;
}

export function createModelConversation(input: Omit<ModelConversation, 'chatMessages' | 'responseInput'>): ModelConversation {
  if (input.mode === 'responses') {
    return { ...input, responseInput: [{ role: 'user', content: input.userMessage }] };
  }
  return {
    ...input,
    chatMessages: [
      { role: 'system', content: input.systemPrompt },
      { role: 'user', content: input.userMessage },
    ],
  };
}

function responseTool(tool: CanonicalToolDef): Record<string, unknown> {
  return {
    type: 'function',
    name: tool.name,
    description: tool.description ?? '',
    parameters: tool.inputSchema ?? { type: 'object', properties: {} },
    strict: false,
  };
}

export function modelTurnRequest(conversation: ModelConversation): Record<string, unknown> {
  const tools = conversation.tools.map(responseTool);
  if (conversation.mode === 'responses') {
    return {
      model: conversation.model,
      instructions: conversation.systemPrompt,
      input: conversation.responseInput ?? [],
      tools,
      tool_choice: 'auto',
      ...(conversation.previousResponseId ? { previous_response_id: conversation.previousResponseId } : {}),
    };
  }
  return {
    model: conversation.model,
    messages: conversation.chatMessages ?? [],
    tools: tools.map((tool) => ({ type: 'function', function: {
      name: tool.name,
      description: tool.description,
      parameters: tool.parameters,
    } })),
    tool_choice: 'auto',
  };
}

function parseArguments(value: unknown): { arguments: Record<string, unknown>; error?: string } {
  if (typeof value !== 'string') return { arguments: {}, error: 'Tool arguments were not a JSON string.' };
  try {
    const parsed = JSON.parse(value) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return { arguments: {}, error: 'Tool arguments must be a JSON object.' };
    }
    return { arguments: parsed as Record<string, unknown> };
  } catch (error) {
    return { arguments: {}, error: `Tool arguments were invalid JSON: ${error instanceof Error ? error.message : String(error)}` };
  }
}

function tokenUsage(value: unknown): ParsedModelTurn['usage'] {
  if (!value || typeof value !== 'object') return undefined;
  const record = value as Record<string, unknown>;
  const inputTokens = record.input_tokens ?? record.prompt_tokens;
  const outputTokens = record.output_tokens ?? record.completion_tokens;
  const totalTokens = record.total_tokens;
  const usage = {
    ...(typeof inputTokens === 'number' && Number.isInteger(inputTokens) && inputTokens >= 0 ? { inputTokens } : {}),
    ...(typeof outputTokens === 'number' && Number.isInteger(outputTokens) && outputTokens >= 0 ? { outputTokens } : {}),
    ...(typeof totalTokens === 'number' && Number.isInteger(totalTokens) && totalTokens >= 0 ? { totalTokens } : {}),
  };
  return Object.keys(usage).length ? usage : undefined;
}

function boundedContentPart(type: 'text' | 'reasoning', text: unknown): { type: 'text' | 'reasoning'; text: string } | undefined {
  return typeof text === 'string' ? { type, text: text.slice(0, 32_768) } : undefined;
}

export function parseModelTurn(mode: ModelEndpointMode, payload: unknown): ParsedModelTurn {
  if (!payload || typeof payload !== 'object') return { text: '', calls: [] };
  if (mode === 'responses') {
    const response = payload as {
      id?: unknown;
      status?: unknown;
      incomplete_details?: { reason?: unknown };
      usage?: unknown;
      output_text?: unknown;
      output?: Array<{ type?: unknown; call_id?: unknown; name?: unknown; arguments?: unknown; content?: Array<{ type?: unknown; text?: unknown }> }>;
    };
    const calls = (response.output ?? []).flatMap((item, index) => {
      if (item.type !== 'function_call' || typeof item.name !== 'string') return [];
      const parsed = parseArguments(item.arguments);
      return [{
        id: typeof item.call_id === 'string' ? item.call_id : `response-call-${index}`,
        name: item.name,
        arguments: parsed.arguments,
        ...(parsed.error ? { argumentError: parsed.error } : {}),
      }];
    });
    const nestedText = (response.output ?? [])
      .flatMap((item) => item.content ?? [])
      .find((item) => item.type === 'output_text' && typeof item.text === 'string')?.text;
    const text = typeof response.output_text === 'string'
      ? response.output_text
      : typeof nestedText === 'string'
        ? nestedText
        : '';
    const contentParts = (response.output ?? []).flatMap((item) => (item.content ?? []).flatMap((part) => {
      if (part.type === 'output_text') return boundedContentPart('text', part.text) ?? [];
      if (part.type === 'reasoning_text' || part.type === 'reasoning') return boundedContentPart('reasoning', part.text) ?? [];
      return [];
    }));
    const incompleteReason = response.incomplete_details?.reason;
    const usage = tokenUsage(response.usage);
    return {
      id: typeof response.id === 'string' ? response.id : undefined,
      text: text.trim(),
      calls,
      ...(typeof incompleteReason === 'string'
        ? { finishReason: incompleteReason }
        : typeof response.status === 'string'
          ? { finishReason: response.status }
          : {}),
      ...(usage ? { usage } : {}),
      ...(contentParts.length ? { contentParts } : {}),
    };
  }
  const response = payload as {
    id?: unknown;
    usage?: unknown;
    choices?: Array<{
      finish_reason?: unknown;
      message?: Record<string, unknown> & {
        content?: unknown;
        reasoning_content?: unknown;
        tool_calls?: Array<{ id?: unknown; function?: { name?: unknown; arguments?: unknown } }>;
      };
    }>;
  };
  const choice = response.choices?.[0];
  const message = choice?.message;
  const calls = (message?.tool_calls ?? []).flatMap((call, index) => {
    if (typeof call.function?.name !== 'string') return [];
    const parsed = parseArguments(call.function.arguments);
    return [{
      id: typeof call.id === 'string' ? call.id : `chat-call-${index}`,
      name: call.function.name,
      arguments: parsed.arguments,
      ...(parsed.error ? { argumentError: parsed.error } : {}),
    }];
  });
  const contentParts = [
    boundedContentPart('reasoning', message?.reasoning_content),
    boundedContentPart('text', message?.content),
  ].filter((part): part is { type: 'text' | 'reasoning'; text: string } => part !== undefined);
  const usage = tokenUsage(response.usage);
  return {
    id: typeof response.id === 'string' ? response.id : undefined,
    text: typeof message?.content === 'string' ? message.content.trim() : '',
    calls,
    ...(message ? { assistantMessage: message } : {}),
    ...(typeof choice?.finish_reason === 'string' ? { finishReason: choice.finish_reason } : {}),
    ...(usage ? { usage } : {}),
    ...(contentParts.length ? { contentParts } : {}),
  };
}

export function appendToolResults(
  conversation: ModelConversation,
  turn: ParsedModelTurn,
  results: Array<{ call: ModelToolCall; output: unknown }>,
): void {
  if (conversation.mode === 'responses') {
    conversation.previousResponseId = turn.id;
    conversation.responseInput = results.map(({ call, output }) => ({
      type: 'function_call_output',
      call_id: call.id,
      output: JSON.stringify(output),
    }));
    return;
  }
  if (turn.assistantMessage) conversation.chatMessages?.push(turn.assistantMessage);
  for (const { call, output } of results) {
    conversation.chatMessages?.push({
      role: 'tool',
      tool_call_id: call.id,
      content: JSON.stringify(output),
    });
  }
}