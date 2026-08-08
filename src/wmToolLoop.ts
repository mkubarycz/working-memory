/**
 * The bounded agentic tool-calling loop that powers the right-rail command
 * widget (WM 14.2.1 "poc-right-rail-command-widget").
 *
 * A user's natural-language command is handed to a LOCAL model
 * ({@link LlamaClient}) together with a small set of Working Memory CRUD tools.
 * The model issues tool calls; we execute each through a {@link ToolExecutor}
 * (backed ONLY by the control-plane client — never SQLite), feed the results
 * back, and loop until the model returns a final plain-text answer or we hit an
 * iteration cap. The point of the POC is to surface WHERE a small local model
 * gets stuck (wrong tool, invalid args, never stopping) — so the loop records a
 * full tool-call trail and a stop reason.
 *
 * This module is VS Code-free and depends only on injectable seams (a `chat`
 * function and a `ToolExecutor`), so the whole loop is unit-testable with a
 * scripted fake model + fake executor.
 */

import type { LlamaMessage, LlamaToolCall, LlamaToolDef } from './llamaClient';

/** Result of executing one tool call. */
export interface ToolResult {
  ok: boolean;
  /** JSON-serializable payload fed back to the model on success. */
  result?: unknown;
  /** Human-readable error fed back to the model on failure. */
  error?: string;
  /** True when the call mutated the store destructively (delete) — surfaced in the brief. */
  destructive?: boolean;
}

/** Executes a single named tool call. Backed by the control-plane client. */
export interface ToolExecutor {
  execute(name: string, args: Record<string, unknown>): Promise<ToolResult>;
}

/** One entry in the loop's tool-call trail (for the rendered brief). */
export interface ToolCallRecord {
  name: string;
  args: Record<string, unknown>;
  ok: boolean;
  error?: string;
  destructive: boolean;
  /**
   * True when this exact call (name + normalized args) was already executed
   * earlier in the SAME run and was therefore skipped rather than re-executed.
   * `qwen2.5:14b` likes to emit duplicate/parallel `create` calls; we run the
   * first and feed the prior result back for the rest so the store isn't
   * double-mutated (each auto-generates a unique slug, so a repeat never errors).
   */
  deduped?: boolean;
}

/**
 * One failed-call → corrective-retry record (self-correction story
 * `command-widget-tool-failure-self-correct`). When a tool call fails we feed
 * the model the tool's parameter schema plus a terse hint; if a later call to
 * the SAME tool succeeds within the run we mark this recovered. Journaled so we
 * can see where the model got stuck and how it recovered.
 */
export interface Correction {
  tool: string;
  /** The args that failed. */
  failedArgs: Record<string, unknown>;
  /** The error the tool returned. */
  error: string;
  /** The corrective hint (schema + instruction) fed back to the model. */
  hint?: string;
  /** The args of the corrected retry (present once the model retried). */
  retriedArgs?: Record<string, unknown>;
  /** True once a later call to the same tool succeeded within the run. */
  recovered: boolean;
}

/**
 * A prior conversation turn replayed into a new run as chat history (context
 * carryover baseline A — full replay). `command` was the user's message;
 * `brief` was the assistant's rendered answer.
 */
export interface PriorTurn {
  command: string;
  brief: string;
}

/** The `chat` seam — one model turn (mirrors `LlamaClient.chatConstrained`). */
export type ChatFn = (
  messages: LlamaMessage[],
  tools: LlamaToolDef[],
) => Promise<{ message: LlamaMessage; promptEvalCount?: number; evalCount?: number }>;

/**
 * A lightweight per-turn trace event. Injected via {@link ToolLoopInput.trace}
 * so the pure loop never touches VS Code / `console`; the host wires it to an
 * OutputChannel to confirm parallel-vs-repeat tool calls on the next F5.
 */
export type TraceEvent =
  | {
      type: 'turn';
      iteration: number;
      /** How many tool_calls the model emitted this turn. */
      toolCallCount: number;
      /** The raw calls (name + args) the model requested this turn. */
      toolCalls: { name: string; args: Record<string, unknown> }[];
      /** Ollama prompt-eval token count for this turn (context-window signal). */
      promptTokens?: number;
      /** Ollama eval (generated) token count for this turn. */
      evalTokens?: number;
      /** Wall-clock duration (ms) of this turn's model call. */
      perCallMs?: number;
    }
  | {
      type: 'exec';
      iteration: number;
      name: string;
      /** `ok` executed cleanly, `deduped` skipped as a duplicate, `error` failed. */
      outcome: 'ok' | 'deduped' | 'error';
      error?: string;
    };

export interface ToolLoopInput {
  chat: ChatFn;
  executor: ToolExecutor;
  command: string;
  /** Sticky context: the currently/last-selected WM doc slug (or null). */
  contextSlug: string | null;
  /** Optional context kind (`topic` / `workstream`) for a richer prompt. */
  contextKind?: string | null;
  /**
   * Prior turns of THIS scope's conversation, replayed as chat history so the
   * model sees the ongoing conversation (context carryover baseline A — full
   * replay). Oldest→newest. The host caps this to a bounded window.
   */
  history?: PriorTurn[];
  /** Hard cap on model turns before we give up (default 8). */
  maxIterations?: number;
  /** Optional trace sink for per-turn diagnostics (kept VS Code-free). */
  trace?: (event: TraceEvent) => void;
  /**
   * Injectable wall-clock (ms) seam for deterministic timing tests. Defaults to
   * `Date.now`; tests pass a fake clock so `timings` is reproducible. The loop
   * never calls `Date.now`/`performance.now` inline — always through this.
   */
  now?: () => number;
}

/** Accumulated token usage across a run (context-window instrumentation). */
export interface TokenUsage {
  /** Summed prompt-eval tokens across all model turns. */
  promptTokens: number;
  /** Summed generated (eval) tokens across all model turns. */
  evalTokens: number;
  /** Number of model calls made. */
  calls: number;
}

/**
 * Wall-clock timing accumulated across a run (benchmarking story
 * `performance-concerns-llm-calls`). The loop owns the model-call timings; the
 * host derives the run-total, journal, and tools/overhead splits.
 */
export interface ToolLoopTimings {
  /** Summed duration (ms) of every `chat` (model) call. */
  modelMs: number;
  /** Number of model calls timed. */
  modelCalls: number;
  /** Per-call model durations (ms), in turn order. */
  perCallMs: number[];
}

export interface ToolLoopResult {
  /** The model's final plain-text answer (empty if it never produced one). */
  finalText: string;
  /** The ordered tool-call trail. */
  toolCalls: ToolCallRecord[];
  /** Failed-call → corrective-retry records (self-correction). */
  corrections: Correction[];
  /** Accumulated token usage across the run. */
  tokens: TokenUsage;
  /** Accumulated wall-clock timing for the run's model calls. */
  timings: ToolLoopTimings;
  /** Number of model turns taken. */
  iterations: number;
  /** Why the loop ended. */
  stopReason: 'final' | 'max-iterations' | 'error';
  /** Present when `stopReason === 'error'`. */
  error?: string;
}

const DEFAULT_MAX_ITERATIONS = 8;

/**
 * The Working Memory tool surface exposed to the local model. Kept deliberately
 * SMALL (11 tools) and flat — small local models degrade fast as the schema
 * grows. Names use underscores (broadest cross-server compatibility) and map to
 * `ws-*` control-plane operations in {@link createControlPlaneToolExecutor}.
 */
export const WM_TOOLS: LlamaToolDef[] = [
  fn('topic_read', 'Read Working Memory topics. With no slug, lists topics (optionally filtered by `query` substring or `workstream` membership). Use this to find the exact slug before updating or deleting.', {
    slug: str('Exact topic slug to fetch one topic.'),
    query: str('Substring to search topic titles/bodies.'),
    workstream: str('Only topics that are members of this workstream slug.'),
  }),
  fn('topic_create', 'Create a new topic. Returns the created topic (with its slug).', {
    title: str('Topic title (required).'),
    slug: str('Required unique slug: lowercase words separated by dashes, 3–5 words, e.g. "product-roadmap". Derive it from the title.'),
    body: str('Markdown body describing the topic.'),
    topicType: str('Topic type slug, e.g. feature | bug | task | user-story.'),
    workstreams: arr('Workstream slugs this topic belongs to.'),
  }, ['title', 'slug']),
  fn('topic_update', 'Update an existing topic identified by slug. Only provided fields change.', {
    slug: str('Slug of the topic to update (required).'),
    title: str('New title.'),
    body: str('New markdown body.'),
    status: str('New status: open | closed.'),
  }, ['slug']),
  fn('topic_delete', 'Soft-delete a topic by slug (recoverable). Destructive — only when clearly asked.', {
    slug: str('Slug of the topic to delete (required).'),
  }, ['slug']),
  fn('workstream_read', 'Read workstreams. With no slug, lists all live workstreams (optionally filtered by `query`).', {
    slug: str('Exact workstream slug to fetch one.'),
    query: str('Substring to search workstream titles.'),
  }),
  fn('workstream_create', 'Create a new workstream. Returns the created workstream.', {
    title: str('Workstream title (required).'),
    slug: str('Required unique slug: lowercase words separated by dashes, 3–5 words, e.g. "product-roadmap". Derive it from the title.'),
    status: str('Lifecycle status: queue | progress | backlog | closed.'),
  }, ['title', 'slug']),
  fn('workstream_update', 'Update a workstream identified by slug. Only provided fields change.', {
    slug: str('Slug of the workstream to update (required).'),
    title: str('New title.'),
    status: str('New lifecycle status: queue | progress | backlog | closed.'),
  }, ['slug']),
  fn('workstream_delete', 'Soft-delete a workstream by slug (recoverable). Destructive — only when clearly asked.', {
    slug: str('Slug of the workstream to delete (required).'),
  }, ['slug']),
  fn('alert_read', 'Read alerts (needs-attention items). With no args, lists all open alerts.', {
    query: str('Substring to search alert titles/descriptions.'),
  }),
  fn('alert_create', 'Raise an alert for a risk, blocker, or follow-up. Returns the created alert (with its id).', {
    title: str('Short alert title.'),
    description: str('What the alert is about (required).'),
    recommended_action: str('Suggested next step.'),
    topics: arr('Topic slugs this alert relates to.'),
  }, ['description']),
  fn('alert_update', 'Update an alert by id (e.g. close it). Only provided fields change.', {
    id: str('Alert id (required).'),
    status: str('New status: alert | informational | closed.'),
  }, ['id']),
];

/**
 * Build the system prompt: describes the assistant's job, the sticky context
 * scope, the available tools, and the stop condition. Constrained decoding
 * drops the native `tools` array, so the tool catalog is carried here in the
 * prompt (the JSON envelope grammar enforces the shape; the prompt supplies the
 * meaning). Threading the context slug here (and into the user turn) is what
 * makes commands default to the selected WM doc.
 */
export function buildSystemPrompt(
  contextSlug: string | null,
  contextKind?: string | null,
  tools: LlamaToolDef[] = WM_TOOLS,
): string {
  const scope = contextSlug
    ? `The user is currently focused on the ${contextKind ?? 'document'} "${contextSlug}". ` +
      `Treat that as the default scope: if a command is ambiguous about which topic/workstream it means, assume "${contextSlug}".`
    : 'There is no selected Working Memory document; ask the tools for what you need.';
  return [
    'You are the Working Memory command assistant. You translate the user\'s command into Working Memory tool calls (create, read, update, delete of topics, workstreams, and alerts).',
    scope,
    'Each turn you respond with a JSON object `{ "actions": [ … ] }` containing one OR MORE actions. Each action is either a tool call `{ "tool": <name>, "args": { … } }`, or, when finished, `{ "tool": "respond", "message": <short summary> }`.',
    'Batch INDEPENDENT actions into a single turn to save time: if two actions do not depend on each other (e.g. creating three unrelated topics, or reading two different documents), put them ALL in the `actions` array of ONE turn so they run together.',
    'SEQUENCE DEPENDENT actions across turns: if one action needs the result of another (e.g. you must read a topic to learn its slug before you can update or delete it), emit ONLY the first action, wait for its result on the next turn, then emit the dependent action. Never guess a value you have not yet read.',
    'Available tools:',
    buildToolCatalog(tools),
    'Rules:',
    '- Prefer reading (topic_read / workstream_read) to discover exact slugs BEFORE updating or deleting.',
    '- Slugs are lowercase-hyphenated. Never invent a slug for update/delete — look it up first. For create, derive a fresh slug from the title.',
    '- Batch independent tool calls in one turn; sequence dependent ones across turns.',
    '- Create or delete each object at most once per request unless the user explicitly asks for multiple; never repeat a create you have already made in this conversation.',
    '- Deletes are soft/recoverable but still destructive — only delete when the user clearly asked.',
    '- When the task is complete, STOP calling tools and emit a single `respond` action with a short plain-text summary of what you did.',
  ].join('\n');
}

/** One-line-per-tool catalog (name + required args + description) for the prompt. */
function buildToolCatalog(tools: LlamaToolDef[]): string {
  return tools
    .map((t) => {
      const params = (t.function.parameters ?? {}) as {
        properties?: Record<string, unknown>;
        required?: string[];
      };
      const names = Object.keys(params.properties ?? {});
      const req = new Set(params.required ?? []);
      const argList = names
        .map((n) => (req.has(n) ? `${n}*` : n))
        .join(', ');
      return `- ${t.function.name}(${argList}): ${t.function.description}`;
    })
    .join('\n');
}

/**
 * Run the bounded tool-calling loop. Returns the final answer plus the full
 * tool-call trail and a stop reason. Never throws for a tool-level failure (the
 * failure is fed back to the model); only a transport/model error ends the loop
 * early with `stopReason: 'error'`.
 */
export async function runToolLoop(input: ToolLoopInput): Promise<ToolLoopResult> {
  const maxIterations = input.maxIterations ?? DEFAULT_MAX_ITERATIONS;
  const trace = input.trace ?? (() => {});
  const now = input.now ?? Date.now;
  const toolCalls: ToolCallRecord[] = [];
  const corrections: Correction[] = [];
  // The last unrecovered failure per tool → the same object reference stored in
  // `corrections`, so marking it recovered updates the trail in place.
  const pendingByTool = new Map<string, Correction>();
  const tokens: TokenUsage = { promptTokens: 0, evalTokens: 0, calls: 0 };
  const timings: ToolLoopTimings = { modelMs: 0, modelCalls: 0, perCallMs: [] };
  const messages: LlamaMessage[] = [
    { role: 'system', content: buildSystemPrompt(input.contextSlug, input.contextKind) },
  ];
  // Context carryover (baseline A): replay this scope's prior turns as chat
  // history so the model sees the ongoing conversation. Oldest→newest.
  for (const turn of input.history ?? []) {
    messages.push({ role: 'user', content: turn.command });
    messages.push({ role: 'assistant', content: turn.brief });
  }
  messages.push({ role: 'user', content: buildUserTurn(input.command, input.contextSlug) });
  // Dedup within a single run: key (name + normalized args) → the prior result
  // we already executed and fed back. A repeat is NOT re-executed; instead the
  // model is shown the prior result so it stops repeating the create.
  const executed = new Map<string, ToolResult>();

  let iterations = 0;
  while (iterations < maxIterations) {
    iterations += 1;
    let message: LlamaMessage;
    try {
      const callStart = now();
      const res = await input.chat(messages, WM_TOOLS);
      const perCallMs = now() - callStart;
      timings.modelMs += perCallMs;
      timings.modelCalls += 1;
      timings.perCallMs.push(perCallMs);
      message = res.message;
      tokens.promptTokens += res.promptEvalCount ?? 0;
      tokens.evalTokens += res.evalCount ?? 0;
      tokens.calls += 1;
      trace({
        type: 'turn',
        iteration: iterations,
        toolCallCount: (message.tool_calls ?? []).length,
        toolCalls: (message.tool_calls ?? []).map((c) => ({
          name: c.function.name,
          args: c.function.arguments ?? {},
        })),
        promptTokens: res.promptEvalCount,
        evalTokens: res.evalCount,
        perCallMs,
      });
    } catch (err) {
      return {
        finalText: '',
        toolCalls,
        corrections,
        tokens,
        timings,
        iterations,
        stopReason: 'error',
        error: err instanceof Error ? err.message : String(err),
      };
    }

    // Record the assistant turn so the model sees its own tool-call history.
    messages.push(message);

    const calls = message.tool_calls ?? [];
    if (calls.length === 0) {
      // No tool calls → this is the final answer.
      return {
        finalText: message.content ?? '',
        toolCalls,
        corrections,
        tokens,
        timings,
        iterations,
        stopReason: 'final',
      };
    }

    // Execute each requested tool call and feed each result back as a `tool`
    // message so the model can react on the next turn — but skip re-running a
    // call we've already executed in this run (dedup guard).
    for (const call of calls) {
      const name = call.function.name;
      const args = call.function.arguments ?? {};
      const key = callKey(name, args);
      const prior = executed.get(key);

      if (prior) {
        // Duplicate within this run → do NOT execute again; echo the prior
        // result so the model sees the create already happened and stops.
        toolCalls.push({
          name,
          args,
          ok: prior.ok,
          error: prior.ok ? undefined : prior.error,
          destructive: false,
          deduped: true,
        });
        messages.push({
          role: 'tool',
          tool_name: name,
          content: dedupedToolContent(prior),
        });
        trace({ type: 'exec', iteration: iterations, name, outcome: 'deduped' });
        continue;
      }

      const { record, result } = await executeOne(input.executor, call);
      executed.set(key, result);
      toolCalls.push(record);

      if (result.ok) {
        // A successful call to a tool that previously failed this run = the
        // corrective retry landed. Mark the pending correction recovered.
        const pending = pendingByTool.get(name);
        if (pending) {
          pending.recovered = true;
          pending.retriedArgs = args;
          pendingByTool.delete(name);
        }
        messages.push({
          role: 'tool',
          tool_name: record.name,
          content: toolResultContent(record, result),
        });
        trace({ type: 'exec', iteration: iterations, name, outcome: 'ok' });
      } else {
        // Self-correction: feed back the tool's schema + a corrective hint so
        // the model can retry a CORRECTED call (rather than repeat the broken
        // one), and journal the failure so we can see where it got stuck.
        const { hint, schema } = buildCorrectiveHint(name, result.error ?? 'tool failed');
        const correction: Correction = {
          tool: name,
          failedArgs: args,
          error: result.error ?? 'tool failed',
          hint,
          recovered: false,
        };
        corrections.push(correction);
        pendingByTool.set(name, correction);
        messages.push({
          role: 'tool',
          tool_name: record.name,
          content: correctiveToolContent(result.error ?? 'tool failed', hint, schema),
        });
        trace({
          type: 'exec',
          iteration: iterations,
          name,
          outcome: 'error',
          error: result.error,
        });
      }
    }
  }

  // Ran out of iterations while still calling tools — the classic small-model
  // "never knows when to stop" failure. Surface it as the POC signal.
  return {
    finalText: '',
    toolCalls,
    corrections,
    tokens,
    timings,
    iterations,
    stopReason: 'max-iterations',
  };
}

async function executeOne(
  executor: ToolExecutor,
  call: LlamaToolCall,
): Promise<{ record: ToolCallRecord; result: ToolResult }> {
  const name = call.function.name;
  const args = call.function.arguments ?? {};
  try {
    const res = await executor.execute(name, args);
    return {
      record: {
        name,
        args,
        ok: res.ok,
        error: res.ok ? undefined : res.error,
        destructive: res.destructive === true,
      },
      result: res,
    };
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    return {
      record: { name, args, ok: false, error, destructive: false },
      result: { ok: false, error },
    };
  }
}

/**
 * Serialize a tool result into the `content` string fed back to the model. On
 * success we include the actual payload (trimmed) so the model can, e.g., learn
 * the slug of a topic it just read and then update it.
 */
function toolResultContent(record: ToolCallRecord, result: ToolResult): string {
  if (!result.ok) {
    return JSON.stringify({ ok: false, error: result.error ?? 'tool failed' });
  }
  return JSON.stringify({ ok: true, result: trimForModel(result.result) }).slice(0, 4000);
}

/**
 * The `content` fed back for a DEDUPED call: tell the model this exact call
 * already ran (and echo its prior result) so it stops repeating the same create.
 */
function dedupedToolContent(prior: ToolResult): string {
  return JSON.stringify({
    ok: prior.ok,
    deduped: true,
    note:
      'This exact tool call was already executed earlier in this request. It was NOT run again. ' +
      'Do not repeat it — use the prior result below.',
    result: prior.ok ? trimForModel(prior.result) : undefined,
    error: prior.ok ? undefined : prior.error,
  }).slice(0, 4000);
}

/**
 * Build the self-correction hint + schema for a FAILED tool call: look up the
 * tool's parameter schema from {@link WM_TOOLS} and pair it with a terse
 * corrective instruction, so the model can retry a CORRECTED call within the
 * run instead of blindly repeating the broken one. Returns the human hint plus
 * the raw JSON-schema (fed back verbatim to the model).
 */
export function buildCorrectiveHint(
  name: string,
  error: string,
  tools: LlamaToolDef[] = WM_TOOLS,
): { hint: string; schema?: Record<string, unknown> } {
  const tool = tools.find((t) => t.function.name === name);
  const schema = tool?.function.parameters as
    | { properties?: Record<string, unknown>; required?: string[] }
    | undefined;
  const required = schema?.required ?? [];
  const requiredNote =
    required.length > 0 ? `Required argument(s): ${required.join(', ')}. ` : '';
  const hint =
    `Your call to \`${name}\` failed: ${error}. ${requiredNote}` +
    `Consult the tool's parameter schema below, fix the arguments, and call \`${name}\` ` +
    `again with corrected args. Do not repeat the same invalid call.`;
  return { hint, schema: schema as Record<string, unknown> | undefined };
}

/**
 * The `content` fed back for a FAILED call: the error plus the corrective hint
 * and the tool's parameter schema (self-correction). Bounded to keep a small
 * model's context window in check.
 */
function correctiveToolContent(
  error: string,
  hint: string,
  schema: Record<string, unknown> | undefined,
): string {
  return JSON.stringify({ ok: false, error, hint, schema }).slice(0, 4000);
}

/** Stable dedup key: tool name + a deterministic stringify of normalized args. */
function callKey(name: string, args: Record<string, unknown>): string {
  return `${name}::${stableStringify(normalizeArgs(args))}`;
}

/**
 * Normalize args for dedup comparison: trim strings and drop empty / nullish
 * values so `{ title: 'Foo' }` and `{ title: ' Foo ', body: '' }` compare equal.
 */
function normalizeArgs(args: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(args)) {
    if (v === undefined || v === null) {
      continue;
    }
    if (typeof v === 'string') {
      const t = v.trim();
      if (t.length === 0) {
        continue;
      }
      out[k] = t;
    } else {
      out[k] = v;
    }
  }
  return out;
}

/** Deterministic JSON stringify with recursively sorted object keys. */
function stableStringify(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(stableStringify).join(',')}]`;
  }
  if (value && typeof value === 'object') {
    const obj = value as Record<string, unknown>;
    const keys = Object.keys(obj).sort();
    return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify(obj[k])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

/**
 * Shrink a tool payload before feeding it back to a small local model: keep the
 * fields that matter for chaining (slug, id, title, status) and drop verbose
 * bodies so the context window doesn't blow up mid-loop.
 */
function trimForModel(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.slice(0, 25).map(trimForModel);
  }
  if (value && typeof value === 'object') {
    const obj = value as Record<string, unknown>;
    const keep = ['slug', 'id', 'title', 'status', 'topicType', 'workstreams', 'ok'];
    const out: Record<string, unknown> = {};
    for (const k of keep) {
      if (obj[k] !== undefined) {
        out[k] = obj[k];
      }
    }
    // If none of the known keys matched, fall back to the raw object.
    return Object.keys(out).length > 0 ? out : obj;
  }
  return value;
}

function buildUserTurn(command: string, contextSlug: string | null): string {
  if (contextSlug) {
    return `${command}\n\n[context: ${contextSlug}]`;
  }
  return command;
}

// ---- tiny JSON-schema helpers (keep the tool table readable) ---------------

function fn(
  name: string,
  description: string,
  props: Record<string, unknown>,
  required: string[] = [],
): LlamaToolDef {
  return {
    type: 'function',
    function: {
      name,
      description,
      parameters: {
        type: 'object',
        properties: props,
        required,
        additionalProperties: false,
      },
    },
  };
}

function str(description: string): Record<string, unknown> {
  return { type: 'string', description };
}

function arr(description: string): Record<string, unknown> {
  return { type: 'array', items: { type: 'string' }, description };
}
