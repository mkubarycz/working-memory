import type { CanonicalToolDef, ToolCallOutcome } from '../../../src/controlPlaneClient';
import type { ModelEndpointMode } from './config';
import type { ChatContext } from '../shared/contracts';
import {
  appendToolResults,
  createModelConversation,
  desktopToolDescriptors,
  isDestructiveTool,
  modelTurnRequest,
  parseModelTurn,
  type ModelConversation,
  type ModelToolCall,
  type ParsedModelTurn,
} from './modelTools';

export interface ToolProgress {
  name: string;
  status: 'completed' | 'failed' | 'cancelled';
  summary: string;
}

export interface NavigationHint {
  kind: 'workstream' | 'topic';
  identifier: string;
}

export interface PendingConfirmation {
  id: string;
  tool: string;
  arguments: Record<string, unknown>;
}

export interface DesktopAgentResult {
  message: string;
  progress: ToolProgress[];
  mutated: boolean;
  navigation?: NavigationHint;
  pendingConfirmation?: PendingConfirmation;
}

export interface ModelHttpRequest {
  url: string;
  headers: Record<string, string>;
  body: Record<string, unknown>;
  timeoutMs: number;
}

export interface DesktopChatAgentOptions {
  listTools: () => Promise<CanonicalToolDef[]>;
  callTool: (name: string, args: Record<string, unknown>) => Promise<ToolCallOutcome>;
  callModel: (request: ModelHttpRequest) => Promise<unknown>;
  maxIterations?: number;
  totalTimeoutMs?: number;
  requestTimeoutMs?: number;
  now?: () => number;
  createId?: () => string;
}

export interface StartChatInput {
  mode: ModelEndpointMode;
  url: string;
  model: string;
  message: string;
  headers: Record<string, string>;
  context?: ChatContext;
}

interface Session {
  conversation: ModelConversation;
  url: string;
  headers: Record<string, string>;
  startedAt: number;
  iterations: number;
  progress: ToolProgress[];
  mutated: boolean;
  executed: Map<string, unknown>;
  navigation?: NavigationHint;
  suspended?: {
    turn: ParsedModelTurn;
    calls: ModelToolCall[];
    results: Array<{ call: ModelToolCall; output: unknown }>;
    index: number;
  };
}

const SYSTEM_PROMPT = [
  'You are the Working Memory desktop assistant.',
  'Use the provided ws-* tools to read and maintain Working Memory. Prefer exact reads before updates.',
  'Tool errors include the authoritative schema; correct the arguments and retry.',
  'When the task is complete, answer concisely. Never claim a destructive action ran unless its tool result says it ran.',
].join(' ');

export function systemPromptForContext(context?: ChatContext): string {
  if (!context) return SYSTEM_PROMPT;
  const selected = `Selected document: kind=${JSON.stringify(context.kind)}, identifier=${JSON.stringify(context.identifier)}, title=${JSON.stringify(context.title)}.`;
  return [
    SYSTEM_PROMPT,
    selected,
    'Unless the user says otherwise, deictic references including "this", "it", and "current document" refer to this selected document.',
    'Use this exact kind and identifier in tool calls that act on or read the selected document; do not guess its identity from the title.',
  ].join(' ');
}

const MUTATING_ACTION = /-(create|update|delete|run)$/;

export class DesktopChatAgent {
  private readonly pending = new Map<string, Session>();
  private readonly maxIterations: number;
  private readonly totalTimeoutMs: number;
  private readonly requestTimeoutMs: number;
  private readonly now: () => number;
  private readonly createId: () => string;

  constructor(private readonly options: DesktopChatAgentOptions) {
    this.maxIterations = options.maxIterations ?? 8;
    this.totalTimeoutMs = options.totalTimeoutMs ?? 90_000;
    this.requestTimeoutMs = options.requestTimeoutMs ?? 20_000;
    this.now = options.now ?? Date.now;
    this.createId = options.createId ?? (() => crypto.randomUUID());
  }

  async start(input: StartChatInput): Promise<DesktopAgentResult> {
    const tools = desktopToolDescriptors(await this.options.listTools());
    const session: Session = {
      conversation: createModelConversation({
        mode: input.mode,
        model: input.model,
        systemPrompt: systemPromptForContext(input.context),
        userMessage: input.message,
        tools,
      }),
      url: input.url,
      headers: input.headers,
      startedAt: this.now(),
      iterations: 0,
      progress: [],
      mutated: false,
      executed: new Map(),
    };
    return this.continue(session);
  }

  async resolveConfirmation(id: string, confirmed: boolean): Promise<DesktopAgentResult> {
    const session = this.pending.get(id);
    if (!session?.suspended) throw new Error('This pending tool action no longer exists.');
    this.pending.delete(id);
    const state = session.suspended;
    const call = state.calls[state.index];
    session.suspended = undefined;
    if (confirmed) {
      state.results.push({ call, output: await this.execute(session, call) });
    } else {
      const output = { ok: false, error: 'User cancelled this destructive action. Do not retry it unless the user asks again.' };
      state.results.push({ call, output });
      session.progress.push({ name: call.name, status: 'cancelled', summary: 'Cancelled' });
    }
    const paused = await this.executeCalls(session, state.turn, state.calls, state.results, state.index + 1);
    if (paused) return paused;
    appendToolResults(session.conversation, state.turn, state.results);
    return this.continue(session);
  }

  private async continue(session: Session): Promise<DesktopAgentResult> {
    while (session.iterations < this.maxIterations) {
      if (this.now() - session.startedAt >= this.totalTimeoutMs) {
        return this.finish(session, 'Stopped after reaching the total tool-run time limit.');
      }
      session.iterations += 1;
      let payload: unknown;
      try {
        payload = await this.options.callModel({
          url: session.url,
          headers: session.headers,
          body: modelTurnRequest(session.conversation),
          timeoutMs: Math.max(1, Math.min(this.requestTimeoutMs, this.totalTimeoutMs - (this.now() - session.startedAt))),
        });
      } catch (error) {
        return this.finish(session, `Model request failed: ${error instanceof Error ? error.message : String(error)}`);
      }
      const turn = parseModelTurn(session.conversation.mode, payload);
      if (turn.calls.length === 0) {
        return this.finish(session, turn.text || 'The model returned an empty response.');
      }
      const results: Array<{ call: ModelToolCall; output: unknown }> = [];
      const paused = await this.executeCalls(session, turn, turn.calls, results, 0);
      if (paused) return paused;
      appendToolResults(session.conversation, turn, results);
    }
    return this.finish(session, `Stopped after ${this.maxIterations} model turns without a final response.`);
  }

  private async executeCalls(
    session: Session,
    turn: ParsedModelTurn,
    calls: ModelToolCall[],
    results: Array<{ call: ModelToolCall; output: unknown }>,
    startIndex: number,
  ): Promise<DesktopAgentResult | undefined> {
    for (let index = startIndex; index < calls.length; index += 1) {
      const call = calls[index];
      if (isDestructiveTool(call.name, call.arguments)) {
        const id = this.createId();
        session.suspended = { turn, calls, results, index };
        this.pending.set(id, session);
        return {
          message: `Confirmation required before running ${call.name}.`,
          progress: session.progress,
          mutated: session.mutated,
          navigation: session.navigation,
          pendingConfirmation: { id, tool: call.name, arguments: sanitizeArguments(call.arguments) },
        };
      }
      results.push({ call, output: await this.execute(session, call) });
    }
    return undefined;
  }

  private async execute(session: Session, call: ModelToolCall): Promise<unknown> {
    const key = `${call.name}:${stableStringify(cleanArguments(call.arguments))}`;
    if (session.executed.has(key)) {
      session.progress.push({ name: call.name, status: 'completed', summary: 'Skipped duplicate call' });
      return { ok: true, deduped: true, result: session.executed.get(key) };
    }
    let outcome: ToolCallOutcome;
    if (call.argumentError) {
      outcome = { ok: false, error: call.argumentError };
    } else if (!session.conversation.tools.some((tool) => tool.name === call.name)) {
      outcome = { ok: false, error: `Unknown or unavailable desktop tool "${call.name}".` };
    } else {
      outcome = await this.options.callTool(call.name, cleanArguments(call.arguments));
    }
    if (!outcome.ok) {
      const schema = session.conversation.tools.find((tool) => tool.name === call.name)?.inputSchema;
      const output = {
        ok: false,
        error: outcome.error ?? 'Tool failed.',
        correction: 'Correct the arguments using this schema and retry within the remaining turn limit.',
        schema,
      };
      session.progress.push({ name: call.name, status: 'failed', summary: concise(outcome.error ?? 'Failed') });
      session.executed.set(key, output);
      return output;
    }
    const mutating = MUTATING_ACTION.test(call.name);
    session.mutated ||= mutating;
    session.navigation = navigationHint(call.name, call.arguments, outcome.result) ?? session.navigation;
    session.progress.push({ name: call.name, status: 'completed', summary: mutating ? 'Updated Working Memory' : 'Read Working Memory' });
    const output = { ok: true, result: trimResult(outcome.result) };
    session.executed.set(key, output);
    return output;
  }

  private finish(session: Session, message: string): DesktopAgentResult {
    return {
      message,
      progress: session.progress,
      mutated: session.mutated,
      navigation: session.navigation,
    };
  }
}

function cleanArguments(args: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(args).filter(([, value]) => value !== undefined && value !== null && value !== ''));
}

export function sanitizeArguments(args: Record<string, unknown>): Record<string, unknown> {
  const sensitive = /api[-_]?key|authorization|password|secret|token/i;
  return Object.fromEntries(Object.entries(args).map(([key, value]) => {
    if (sensitive.test(key)) return [key, '[redacted]'];
    if (Array.isArray(value)) return [key, value.map((item) => item && typeof item === 'object' ? sanitizeArguments(item as Record<string, unknown>) : item)];
    if (value && typeof value === 'object') return [key, sanitizeArguments(value as Record<string, unknown>)];
    return [key, typeof value === 'string' && value.length > 300 ? `${value.slice(0, 300)}...` : value];
  }));
}

function concise(message: string): string {
  return message.replace(/\s+/g, ' ').slice(0, 160);
}

function trimResult(result: unknown): unknown {
  const serialized = JSON.stringify(result);
  return serialized && serialized.length > 8_000
    ? { truncated: true, preview: serialized.slice(0, 8_000) }
    : result;
}

function navigationHint(name: string, args: Record<string, unknown>, result: unknown): NavigationHint | undefined {
  const match = name.match(/^ws-(workstream|topic)-(create|read)$/);
  if (!match) return undefined;
  const kind = match[1] as NavigationHint['kind'];
  const resultRecord = result && typeof result === 'object' ? result as Record<string, unknown> : undefined;
  const collection = resultRecord?.[kind === 'workstream' ? 'workstreams' : 'topics'];
  const candidates = [result, ...(Array.isArray(result) ? result : []), ...(Array.isArray(collection) ? collection : [])];
  for (const candidate of candidates) {
    if (!candidate || typeof candidate !== 'object') continue;
    const record = candidate as Record<string, unknown>;
    const identifier = record.slug ?? record.id;
    if (typeof identifier === 'string' && identifier) return { kind, identifier };
  }
  const identifier = args.slug ?? args.id;
  return typeof identifier === 'string' && identifier ? { kind, identifier } : undefined;
}

function stableStringify(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, child]) => `${JSON.stringify(key)}:${stableStringify(child)}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
}