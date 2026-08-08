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

/** The `chat` seam — one model turn (mirrors `LlamaClient.chat`). */
export type ChatFn = (
  messages: LlamaMessage[],
  tools: LlamaToolDef[],
) => Promise<{ message: LlamaMessage }>;

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
  /** Hard cap on model turns before we give up (default 8). */
  maxIterations?: number;
  /** Optional trace sink for per-turn diagnostics (kept VS Code-free). */
  trace?: (event: TraceEvent) => void;
}

export interface ToolLoopResult {
  /** The model's final plain-text answer (empty if it never produced one). */
  finalText: string;
  /** The ordered tool-call trail. */
  toolCalls: ToolCallRecord[];
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
    body: str('Markdown body describing the topic.'),
    topicType: str('Topic type slug, e.g. feature | bug | task | user-story.'),
    workstreams: arr('Workstream slugs this topic belongs to.'),
  }, ['title']),
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
    status: str('Lifecycle status: queue | progress | backlog | closed.'),
  }, ['title']),
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
 * scope, and the stop condition. Threading the context slug here (and into the
 * user turn) is what makes commands default to the selected WM doc.
 */
export function buildSystemPrompt(contextSlug: string | null, contextKind?: string | null): string {
  const scope = contextSlug
    ? `The user is currently focused on the ${contextKind ?? 'document'} "${contextSlug}". ` +
      `Treat that as the default scope: if a command is ambiguous about which topic/workstream it means, assume "${contextSlug}".`
    : 'There is no selected Working Memory document; ask the tools for what you need.';
  return [
    'You are the Working Memory command assistant. You translate the user\'s command into Working Memory tool calls (create, read, update, delete of topics, workstreams, and alerts).',
    scope,
    'Rules:',
    '- Prefer reading (topic_read / workstream_read) to discover exact slugs BEFORE updating or deleting.',
    '- Slugs are lowercase-hyphenated. Never invent a slug for update/delete — look it up first.',
    '- Make as many tool calls as needed, one logical step at a time.',
    '- Create or delete each object at most once per request unless the user explicitly asks for multiple; never repeat a create you have already made in this conversation.',
    '- Deletes are soft/recoverable but still destructive — only delete when the user clearly asked.',
    '- When the task is complete, STOP calling tools and reply with a short plain-text summary of what you did. Do not call any tool in that final message.',
  ].join('\n');
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
  const toolCalls: ToolCallRecord[] = [];
  const messages: LlamaMessage[] = [
    { role: 'system', content: buildSystemPrompt(input.contextSlug, input.contextKind) },
    { role: 'user', content: buildUserTurn(input.command, input.contextSlug) },
  ];
  // Dedup within a single run: key (name + normalized args) → the prior result
  // we already executed and fed back. A repeat is NOT re-executed; instead the
  // model is shown the prior result so it stops repeating the create.
  const executed = new Map<string, ToolResult>();

  let iterations = 0;
  while (iterations < maxIterations) {
    iterations += 1;
    let message: LlamaMessage;
    try {
      const res = await input.chat(messages, WM_TOOLS);
      message = res.message;
    } catch (err) {
      return {
        finalText: '',
        toolCalls,
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
        iterations,
        stopReason: 'final',
      };
    }

    trace({
      type: 'turn',
      iteration: iterations,
      toolCallCount: calls.length,
      toolCalls: calls.map((c) => ({ name: c.function.name, args: c.function.arguments ?? {} })),
    });

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
      messages.push({
        role: 'tool',
        tool_name: record.name,
        content: toolResultContent(record, result),
      });
      trace({
        type: 'exec',
        iteration: iterations,
        name,
        outcome: result.ok ? 'ok' : 'error',
        error: result.ok ? undefined : result.error,
      });
    }
  }

  // Ran out of iterations while still calling tools — the classic small-model
  // "never knows when to stop" failure. Surface it as the POC signal.
  return {
    finalText: '',
    toolCalls,
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
