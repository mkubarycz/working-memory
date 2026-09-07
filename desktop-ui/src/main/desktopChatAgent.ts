import type {
  CanonicalToolDef,
  CommandJournal,
  CommandJournalAppendInput,
  CommandJournalCreateInput,
  CommandJournalEntityRef,
  CommandJournalEvent,
  CommandJournalFinalizeInput,
  CommandJournalScopeRef,
  ToolCallOutcome,
} from '../../../src/controlPlaneClient';
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
  journalId: string;
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

export interface DesktopChatDependencies {
  listTools: () => Promise<CanonicalToolDef[]>;
  callTool: (name: string, args: Record<string, unknown>) => Promise<ToolCallOutcome>;
  journal: {
    create: (input: CommandJournalCreateInput) => Promise<CommandJournal>;
    append: (input: CommandJournalAppendInput) => Promise<CommandJournal>;
    finalize: (input: CommandJournalFinalizeInput) => Promise<CommandJournal>;
  };
}

export interface DesktopChatAgentOptions extends DesktopChatDependencies {
  callModel: (request: ModelHttpRequest) => Promise<unknown>;
  resolveDependencies?: () => DesktopChatDependencies;
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
  run: ActiveRun;
  conversation: ModelConversation;
  url: string;
  headers: Record<string, string>;
  startedAt: number;
  iterations: number;
  progress: ToolProgress[];
  mutated: boolean;
  journal: CommandJournal;
  modelMs: number;
  toolsMs: number;
  usage: NonNullable<CommandJournal['completion']>['usage'];
  cancelled: boolean;
  executed: Map<string, { callId: string; output: unknown }>;
  lastExecutionByTool: Map<string, { callId: string; key: string; status: 'success' | 'failure' }>;
  journalCallIds: Map<ModelToolCall, string>;
  usedCallIds: Set<string>;
  navigation?: NavigationHint;
  suspended?: {
    turn: ParsedModelTurn;
    calls: ModelToolCall[];
    results: Array<{ call: ModelToolCall; output: unknown }>;
    index: number;
  };
  finalization?: Promise<DesktopAgentResult>;
}

interface ActiveRun {
  generation: number;
  cancelled: boolean;
  dependencies: DesktopChatDependencies;
  external: Set<Promise<unknown>>;
  journalTail: Promise<void>;
  session?: Session;
  interruption?: Promise<DesktopAgentResult | undefined>;
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
  private readonly active = new Set<ActiveRun>();
  private generation = 0;
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

  async reset(): Promise<void> {
    this.generation += 1;
    const active = [...this.active];
    active.forEach((run) => { run.cancelled = true; });
    const pending = new Map(this.pending);
    this.pending.clear();
    await Promise.allSettled(active.map((run) => {
      const confirmation = [...pending.entries()].find(([, session]) => session.run === run);
      return this.interrupt(run, confirmation?.[0]);
    }));
    active.forEach((run) => { this.active.delete(run); });
  }

  async start(input: StartChatInput): Promise<DesktopAgentResult> {
    const run: ActiveRun = {
      generation: this.generation,
      cancelled: false,
      dependencies: this.options.resolveDependencies?.() ?? this.options,
      external: new Set(),
      journalTail: Promise.resolve(),
    };
    this.active.add(run);
    try {
    const tools = desktopToolDescriptors(await this.external(run, run.dependencies.listTools()));
    this.assertCurrent(run);
    const startedAt = this.now();
    const secretValues = secretHeaderValues(input.headers);
    let journal: CommandJournal;
    try {
      journal = await this.external(run, run.dependencies.journal.create({
        startedAt,
        provider: { endpoint: sanitizedEndpoint(input.url), mode: input.mode, model: input.model.slice(0, 256) },
        request: { userText: sanitizeJournalText(input.message, secretValues).slice(0, 32_768) },
        primaryScope: scopeForContext(input.context, secretValues),
        ...(input.context ? { entityRefs: [{ ...scopeForContext(input.context, secretValues), relation: 'referenced' }] } : {}),
      }));
    } catch (error) {
      throw journalFailure('create', error);
    }
    const session: Session = {
      run,
      conversation: createModelConversation({
        mode: input.mode,
        model: input.model,
        systemPrompt: systemPromptForContext(input.context),
        userMessage: input.message,
        tools,
      }),
      url: input.url,
      headers: input.headers,
      startedAt,
      iterations: 0,
      progress: [],
      mutated: false,
      journal,
      modelMs: 0,
      toolsMs: 0,
      usage: undefined,
      cancelled: false,
      executed: new Map(),
      lastExecutionByTool: new Map(),
      journalCallIds: new Map(),
      usedCallIds: new Set(),
    };
    run.session = session;
    this.assertCurrent(run);
    return await this.continue(session);
    } catch (error) {
      if (isEnvironmentChanged(error)) {
        const interrupted = await this.interrupt(run);
        if (interrupted) return interrupted;
      }
      throw error;
    } finally {
      if (!run.session?.suspended) this.active.delete(run);
    }
  }

  async resolveConfirmation(id: string, confirmed: boolean): Promise<DesktopAgentResult> {
    const session = this.pending.get(id);
    if (!session?.suspended) throw new Error('This pending tool action no longer exists.');
    this.assertCurrent(session.run);
    try {
    const state = session.suspended;
    const call = state.calls[state.index];
    await this.append(session, [{
      ...this.eventBase(session, 'confirmation-resolution'),
      type: 'confirmation_resolved',
      confirmationId: id,
      callId: this.journalCallId(session, call),
      resolution: confirmed ? 'approved' : 'rejected',
    }]);
    this.pending.delete(id);
    session.suspended = undefined;
    if (confirmed) {
      state.results.push({ call, output: await this.execute(session, call) });
    } else {
      const output = { ok: false, error: 'User cancelled this destructive action. Do not retry it unless the user asks again.' };
      state.results.push({ call, output });
      session.progress.push({ name: call.name, status: 'cancelled', summary: 'Cancelled' });
      session.cancelled = true;
      await this.append(session, [{
        ...this.eventBase(session, 'tool-result'),
        type: 'tool_result',
        callId: this.journalCallId(session, call),
        status: 'cancelled',
        error: sanitizeForJournal(output, secretHeaderValues(session.headers)),
        durationMs: 0,
      }]);
    }
    const paused = await this.executeCalls(session, state.turn, state.calls, state.results, state.index + 1);
    if (paused) return paused;
    appendToolResults(session.conversation, state.turn, state.results);
    return await this.continue(session);
    } catch (error) {
      if (isEnvironmentChanged(error)) {
        const interrupted = await this.interrupt(session.run);
        if (interrupted) return interrupted;
      }
      throw error;
    } finally {
      if (!session.suspended) this.active.delete(session.run);
    }
  }

  private async continue(session: Session): Promise<DesktopAgentResult> {
    while (session.iterations < this.maxIterations) {
      if (this.now() - session.startedAt >= this.totalTimeoutMs) {
        return this.finish(session, 'Stopped after reaching the total tool-run time limit.', 'interrupted', 'total_timeout');
      }
      session.iterations += 1;
      let payload: unknown;
      const modelStartedAt = this.now();
      try {
        payload = await this.external(session.run, this.options.callModel({
          url: session.url,
          headers: session.headers,
          body: modelTurnRequest(session.conversation),
          timeoutMs: Math.max(1, Math.min(this.requestTimeoutMs, this.totalTimeoutMs - (this.now() - session.startedAt))),
        }));
        this.assertCurrent(session.run);
      } catch (error) {
        if (isEnvironmentChanged(error)) throw error;
        const rawMessage = `Model request failed: ${error instanceof Error ? error.message : String(error)}`;
        const persistedMessage = sanitizeJournalText(rawMessage, secretHeaderValues(session.headers));
        await this.append(session, [{
          ...this.eventBase(session, 'run-error'),
          type: 'run_error',
          stage: 'model_request',
          message: persistedMessage.slice(0, 32_768),
          retryable: true,
        }]);
        return this.finish(session, rawMessage, 'failed', 'model_error');
      }
      const modelDurationMs = Math.max(0, this.now() - modelStartedAt);
      session.modelMs += modelDurationMs;
      const turn = parseModelTurn(session.conversation.mode, payload);
      const secretValues = secretHeaderValues(session.headers);
      addUsage(session, turn.usage);
      const modelTurnId = this.nextEventId(session, 'model-turn');
      const events: CommandJournalEvent[] = [{
        id: modelTurnId,
        sequence: session.journal.events.length + 1,
        timestamp: this.now(),
        type: 'model_turn',
        role: 'assistant',
        iteration: session.iterations,
        assistantText: sanitizeJournalText(turn.text, secretValues).slice(0, 32_768),
        ...(turn.contentParts?.length ? { contentParts: turn.contentParts.map((part) => ({ ...part, text: sanitizeJournalText(part.text, secretValues) })) } : {}),
        ...(turn.id ? { providerResponseId: turn.id.slice(0, 256) } : {}),
        ...(turn.finishReason ? { finishReason: turn.finishReason.slice(0, 256) } : {}),
        ...(turn.usage ? { usage: turn.usage } : {}),
        durationMs: modelDurationMs,
      }];
      for (const call of turn.calls) {
        const callId = this.journalCallId(session, call);
        const key = executionKey(call);
        const duplicate = session.executed.get(key);
        const previous = session.lastExecutionByTool.get(call.name);
        events.push({
          id: `${session.journal.id}:event:${session.journal.events.length + events.length + 1}`,
          sequence: session.journal.events.length + events.length + 1,
          timestamp: this.now(),
          type: 'tool_call',
          modelTurnId,
          callId,
          toolName: call.name.slice(0, 256),
          ...(call.argumentError
            ? { argumentParseError: call.argumentError.slice(0, 32_768) }
            : { arguments: sanitizeForJournal(cleanArguments(call.arguments), secretValues) }),
          ...(duplicate ? { dedupedOfCallId: duplicate.callId } : {}),
          ...(!duplicate && previous?.status === 'failure' && previous.key !== key
            ? { retryOfCallId: previous.callId }
            : {}),
        });
      }
      await this.append(session, events, sanitizeEntityRefs(entityRefsForCalls(turn.calls, 'referenced'), secretValues));
      this.assertCurrent(session.run);
      if (turn.calls.length === 0) {
        return this.finish(
          session,
          turn.text || 'The model returned an empty response.',
          session.cancelled ? 'cancelled' : 'succeeded',
          turn.finishReason ?? (session.cancelled ? 'user_rejected' : 'completed'),
        );
      }
      const results: Array<{ call: ModelToolCall; output: unknown }> = [];
      const paused = await this.executeCalls(session, turn, turn.calls, results, 0);
      if (paused) return paused;
      appendToolResults(session.conversation, turn, results);
    }
    return this.finish(session, `Stopped after ${this.maxIterations} model turns without a final response.`, 'interrupted', 'iteration_limit');
  }

  private async executeCalls(
    session: Session,
    turn: ParsedModelTurn,
    calls: ModelToolCall[],
    results: Array<{ call: ModelToolCall; output: unknown }>,
    startIndex: number,
  ): Promise<DesktopAgentResult | undefined> {
    for (let index = startIndex; index < calls.length; index += 1) {
      this.assertCurrent(session.run);
      const call = calls[index];
      if (isDestructiveTool(call.name, call.arguments)) {
        const id = this.createId();
        session.suspended = { turn, calls, results, index };
        await this.append(session, [{
          ...this.eventBase(session, 'confirmation-request'),
          type: 'confirmation_requested',
          confirmationId: id,
          callId: this.journalCallId(session, call),
          prompt: `Confirm ${call.name}`,
          payload: sanitizeForJournal(call.arguments, secretHeaderValues(session.headers)),
        }]);
        this.pending.set(id, session);
        return {
          journalId: session.journal.id,
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
    this.assertCurrent(session.run);
    const key = executionKey(call);
    const previous = session.executed.get(key);
    if (previous) {
      session.progress.push({ name: call.name, status: 'completed', summary: 'Skipped duplicate call' });
      const output = { ok: true, deduped: true, result: previous.output };
      await this.persistToolResult(session, call, output, 'success', 0);
      return output;
    }
    const toolStartedAt = this.now();
    let outcome: ToolCallOutcome;
    if (call.argumentError) {
      outcome = { ok: false, error: call.argumentError };
    } else if (!session.conversation.tools.some((tool) => tool.name === call.name)) {
      outcome = { ok: false, error: `Unknown or unavailable desktop tool "${call.name}".` };
    } else {
      try {
        this.assertCurrent(session.run);
        outcome = await this.external(
          session.run,
          session.run.dependencies.callTool(call.name, cleanArguments(call.arguments)),
        );
        this.assertCurrent(session.run);
      } catch (error) {
        if (isEnvironmentChanged(error)) throw error;
        outcome = { ok: false, error: error instanceof Error ? error.message : String(error) };
      }
    }
    const durationMs = Math.max(0, this.now() - toolStartedAt);
    session.toolsMs += durationMs;
    if (!outcome.ok) {
      const schema = session.conversation.tools.find((tool) => tool.name === call.name)?.inputSchema;
      const output = {
        ok: false,
        error: outcome.error ?? 'Tool failed.',
        correction: 'Correct the arguments using this schema and retry within the remaining turn limit.',
        schema,
      };
      session.progress.push({ name: call.name, status: 'failed', summary: concise(outcome.error ?? 'Failed') });
      const callId = this.journalCallId(session, call);
      session.executed.set(key, { callId, output });
      session.lastExecutionByTool.set(call.name, { callId, key, status: 'failure' });
      await this.persistToolResult(session, call, output, 'failure', durationMs);
      return output;
    }
    const mutating = MUTATING_ACTION.test(call.name);
    session.mutated ||= mutating;
    session.navigation = navigationHint(call.name, call.arguments, outcome.result) ?? session.navigation;
    session.progress.push({ name: call.name, status: 'completed', summary: mutating ? 'Updated Working Memory' : 'Read Working Memory' });
    const output = { ok: true, result: trimResult(outcome.result) };
    const callId = this.journalCallId(session, call);
    session.executed.set(key, { callId, output });
    session.lastExecutionByTool.set(call.name, { callId, key, status: 'success' });
    await this.persistToolResult(session, call, output, 'success', durationMs, entityRefsForTool(call, outcome.result, mutating ? 'mutated' : 'referenced'));
    return output;
  }

  private async persistToolResult(
    session: Session,
    call: ModelToolCall,
    output: unknown,
    status: 'success' | 'failure',
    durationMs: number,
    entityRefs?: CommandJournalEntityRef[],
  ): Promise<void> {
    const secretValues = secretHeaderValues(session.headers);
    await this.append(session, [{
      ...this.eventBase(session, 'tool-result'),
      type: 'tool_result',
      callId: this.journalCallId(session, call),
      status,
      ...(status === 'success'
        ? { result: sanitizeForJournal(output, secretValues) }
        : { error: sanitizeForJournal(output, secretValues) }),
      durationMs,
    }], entityRefs ? sanitizeEntityRefs(entityRefs, secretValues) : undefined);
  }

  private journalCallId(session: Session, call: ModelToolCall): string {
    const existing = session.journalCallIds.get(call);
    if (existing) return existing;
    const base = call.id.slice(0, 220) || `call-${session.usedCallIds.size + 1}`;
    let candidate = base;
    let suffix = 2;
    while (session.usedCallIds.has(candidate)) candidate = `${base}:${suffix++}`;
    session.usedCallIds.add(candidate);
    session.journalCallIds.set(call, candidate);
    return candidate;
  }

  private eventBase(session: Session, label: string): Pick<CommandJournalEvent, 'id' | 'sequence' | 'timestamp'> {
    return {
      id: this.nextEventId(session, label),
      sequence: session.journal.events.length + 1,
      timestamp: this.now(),
    };
  }

  private nextEventId(session: Session, _label: string): string {
    return `${session.journal.id}:event:${session.journal.events.length + 1}`;
  }

  private async append(
    session: Session,
    events: CommandJournalEvent[],
    entityRefs?: CommandJournalEntityRef[],
    allowCancelled = false,
  ): Promise<void> {
    await this.withJournal(session, allowCancelled, async () => {
      session.journal = await session.run.dependencies.journal.append({
        id: session.journal.id,
        expectedResourceVersion: session.journal.resourceVersion,
        events,
        ...(entityRefs?.length ? { entityRefs } : {}),
      });
    }, 'append');
  }

  private async finish(
    session: Session,
    message: string,
    status: CommandJournalFinalizeInput['status'],
    stopReason: string,
    allowCancelled = false,
  ): Promise<DesktopAgentResult> {
    if (session.finalization) return session.finalization;
    session.finalization = (async () => {
      await this.withJournal(session, allowCancelled, async () => {
        session.journal = await session.run.dependencies.journal.finalize({
        id: session.journal.id,
        expectedResourceVersion: session.journal.resourceVersion,
        status,
        completedAt: this.now(),
        completion: {
          finalAssistantText: sanitizeJournalText(message, secretHeaderValues(session.headers)).slice(0, 32_768),
          stopReason: stopReason.slice(0, 256),
          ...(session.usage ? { usage: session.usage } : {}),
          timing: {
            totalMs: Math.max(0, this.now() - session.startedAt),
            modelMs: session.modelMs,
            toolsMs: session.toolsMs,
          },
          mutated: session.mutated,
          ...(session.navigation ? { navigationTarget: navigationScopeRef(session.navigation) } : {}),
        },
      });
      }, 'finalize');
      return {
        journalId: session.journal.id,
        message,
        progress: session.progress,
        mutated: session.mutated,
        navigation: session.navigation,
      };
    })();
    return session.finalization;
  }

  private async interrupt(run: ActiveRun, confirmationId?: string): Promise<DesktopAgentResult | undefined> {
    if (run.interruption) return run.interruption;
    run.cancelled = true;
    run.interruption = (async () => {
      await Promise.allSettled([...run.external]);
      await run.journalTail.catch(() => {});
      const session = run.session;
      if (!session) return undefined;
      if (session.finalization) {
        const finalized = await session.finalization.catch(() => undefined);
        if (finalized) return finalized;
        if (isTerminalJournal(session.journal)) {
          return {
            journalId: session.journal.id,
            message: 'Cancelled because the Working Memory environment changed.',
            progress: session.progress,
            mutated: session.mutated,
            navigation: session.navigation,
          };
        }
        session.finalization = undefined;
      }
      const call = confirmationId
        ? session.suspended?.calls[session.suspended.index]
        : undefined;
      session.suspended = undefined;
      session.cancelled = true;
      try {
        if (confirmationId && call) {
          await this.append(session, [{
            ...this.eventBase(session, 'confirmation-resolution'),
            type: 'confirmation_resolved',
            confirmationId,
            callId: this.journalCallId(session, call),
            resolution: 'rejected',
          }], undefined, true);
        } else {
          await this.append(session, [{
            ...this.eventBase(session, 'run-error'),
            type: 'run_error',
            stage: 'environment_switch',
            message: 'Run interrupted because the Working Memory environment changed.',
            code: 'environment_changed',
            retryable: true,
          }], undefined, true);
        }
      } catch {
        // Best effort: finalization may still succeed with the latest known CAS version.
      }
      try {
        return await this.finish(
          session,
          'Cancelled because the Working Memory environment changed.',
          confirmationId ? 'cancelled' : 'interrupted',
          'environment_changed',
          true,
        );
      } catch {
        return {
          journalId: session.journal.id,
          message: 'Cancelled because the Working Memory environment changed.',
          progress: session.progress,
          mutated: session.mutated,
          navigation: session.navigation,
        };
      }
    })();
    return run.interruption;
  }

  private async external<T>(run: ActiveRun, operation: Promise<T>): Promise<T> {
    run.external.add(operation);
    try {
      return await operation;
    } finally {
      run.external.delete(operation);
    }
  }

  private assertCurrent(run: ActiveRun): void {
    if (run.cancelled || run.generation !== this.generation) throw new EnvironmentChangedError();
  }

  private async withJournal(
    session: Session,
    allowCancelled: boolean,
    operation: () => Promise<void>,
    stage: 'append' | 'finalize',
  ): Promise<void> {
    const previous = session.run.journalTail;
    let release = () => {};
    session.run.journalTail = new Promise<void>((resolve) => { release = resolve; });
    await previous;
    try {
      if (!allowCancelled) this.assertCurrent(session.run);
      await operation();
      if (!allowCancelled) this.assertCurrent(session.run);
    } catch (error) {
      if (isEnvironmentChanged(error)) throw error;
      throw journalFailure(stage, error);
    } finally {
      release();
    }
  }
}

class EnvironmentChangedError extends Error {
  constructor() {
    super('Working Memory environment changed.');
    this.name = 'EnvironmentChangedError';
  }
}

function isEnvironmentChanged(error: unknown): error is EnvironmentChangedError {
  return error instanceof EnvironmentChangedError;
}

function isTerminalJournal(journal: CommandJournal): boolean {
  return journal.status === 'succeeded'
    || journal.status === 'failed'
    || journal.status === 'cancelled'
    || journal.status === 'interrupted';
}

function executionKey(call: ModelToolCall): string {
  return `${call.name}:${stableStringify(cleanArguments(call.arguments))}`;
}

function journalFailure(stage: string, error: unknown): Error {
  return new Error(`Command journal ${stage} failed: ${error instanceof Error ? error.message : String(error)}`);
}

function sanitizedEndpoint(raw: string): string {
  const endpoint = new URL(raw);
  endpoint.username = '';
  endpoint.password = '';
  endpoint.search = '';
  endpoint.hash = '';
  return endpoint.toString();
}

function scopeForContext(context?: ChatContext, secrets: string[] = []): CommandJournalScopeRef {
  return context
    ? { kind: context.kind.slice(0, 256), id: context.identifier.slice(0, 256), title: sanitizeJournalText(context.title, secrets).slice(0, 32_768) }
    : { kind: 'DesktopChat', id: 'desktop-chat' };
}

function navigationScopeRef(navigation: NavigationHint): CommandJournalScopeRef {
  const identifier = navigation.identifier.slice(0, 256);
  return {
    kind: navigation.kind === 'workstream' ? 'Workstream' : 'Topic',
    id: identifier,
    slug: identifier,
  };
}

function secretHeaderValues(headers: Record<string, string>): string[] {
  const sensitive = /api[-_]?key|authorization|cookie|credential|password|secret|token/i;
  return Object.entries(headers).flatMap(([key, value]) => sensitive.test(key) && value ? [value] : []);
}

function sanitizeJournalText(value: string, secrets: string[]): string {
  let sanitized = value;
  for (const secret of secrets.filter((candidate) => candidate.length >= 4)) {
    sanitized = sanitized.split(secret).join('[redacted]');
  }
  return sanitized
    .replace(/\bBearer\s+[A-Za-z0-9._~+\/-]+=*/gi, 'Bearer [redacted]')
    .replace(/\b(?:sk|gh[pousr])_[A-Za-z0-9_-]{8,}/gi, '[redacted]')
    .replace(/([?&](?:api[-_]?key|authorization|credential|password|secret|token)=)[^&#\s]+/gi, '$1[redacted]');
}

function sanitizeForJournal(value: unknown, secrets: string[] = []): unknown {
  const sensitive = /api[-_]?key|authorization|cookie|credential|password|secret|token/i;
  const seen = new WeakSet<object>();
  const visit = (candidate: unknown): unknown => {
    if (candidate === null || typeof candidate === 'boolean') return candidate;
    if (typeof candidate === 'number') return Number.isFinite(candidate) ? candidate : String(candidate);
    if (typeof candidate === 'string') return sanitizeJournalText(candidate, secrets).slice(0, 32_768);
    if (typeof candidate !== 'object') return String(candidate);
    if (seen.has(candidate)) return '[circular]';
    seen.add(candidate);
    if (Array.isArray(candidate)) return candidate.slice(0, 1_000).map(visit);
    let sensitiveIndex = 0;
    return Object.fromEntries(Object.entries(candidate as Record<string, unknown>).slice(0, 1_000).map(([key, child]) => [
      sensitive.test(key) ? `sensitiveField${++sensitiveIndex}` : key.slice(0, 256),
      sensitive.test(key) ? '[redacted]' : visit(child),
    ]));
  };
  const sanitized = visit(value);
  const serialized = JSON.stringify(sanitized);
  return serialized.length > 60_000 ? { truncated: true, preview: serialized.slice(0, 50_000) } : sanitized;
}

function sanitizeEntityRefs(refs: CommandJournalEntityRef[], secrets: string[]): CommandJournalEntityRef[] {
  return refs.map((ref) => ({
    ...ref,
    ...(ref.title ? { title: sanitizeJournalText(ref.title, secrets).slice(0, 32_768) } : {}),
  }));
}

function addUsage(session: Session, usage: ParsedModelTurn['usage']): void {
  if (!usage) return;
  session.usage = {
    inputTokens: (session.usage?.inputTokens ?? 0) + (usage.inputTokens ?? 0),
    outputTokens: (session.usage?.outputTokens ?? 0) + (usage.outputTokens ?? 0),
    totalTokens: (session.usage?.totalTokens ?? 0) + (usage.totalTokens ?? 0),
  };
}

const ENTITY_KINDS: Record<string, string> = {
  workstream: 'Workstream', topic: 'Topic', topictype: 'TopicType', alert: 'Alert',
  config: 'Config', nanite: 'Nanite', nanitetemplate: 'NaniteTemplate', nanitejournal: 'NaniteJournal',
};

function entityRefsForCalls(calls: ModelToolCall[], relation: CommandJournalEntityRef['relation']): CommandJournalEntityRef[] {
  return calls.flatMap((call) => entityRefsForTool(call, call.arguments, relation));
}

function entityRefsForTool(call: ModelToolCall, value: unknown, relation: CommandJournalEntityRef['relation']): CommandJournalEntityRef[] {
  const family = call.name.match(/^ws-([a-z]+)-/)?.[1];
  const kind = family ? ENTITY_KINDS[family] : undefined;
  if (!kind) return [];
  const refs = new Map<string, CommandJournalEntityRef>();
  const visit = (candidate: unknown): void => {
    if (Array.isArray(candidate)) return candidate.forEach(visit);
    if (!candidate || typeof candidate !== 'object') return;
    const record = candidate as Record<string, unknown>;
    const id = typeof record.id === 'string' && record.id ? record.id : typeof record.slug === 'string' ? record.slug : undefined;
    if (id) {
      const ref: CommandJournalEntityRef = {
        kind,
        id: id.slice(0, 256),
        relation,
        ...(typeof record.slug === 'string' && record.slug ? { slug: record.slug.slice(0, 256) } : {}),
        ...(typeof record.title === 'string' && record.title ? { title: record.title.slice(0, 32_768) } : {}),
      };
      refs.set(`${ref.kind}:${ref.id}:${ref.relation}`, ref);
    }
    Object.values(record).forEach(visit);
  };
  visit(value);
  return [...refs.values()];
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