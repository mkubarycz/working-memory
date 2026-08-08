/**
 * Direct-HTTP client for a locally-hosted Llama server (WM 14.2.1
 * "poc-right-rail-command-widget").
 *
 * The right-rail command widget drives Working Memory by asking a LOCAL model
 * to translate a natural-language command into Working Memory tool calls. Per
 * the topic's locked decisions this is a DIRECT HTTP call to the local server
 * (Ollama's `/api/chat`), NOT a `vscode.lm` provider — so a small local model's
 * tool-calling behavior is exercised end-to-end and its failure modes surface
 * for the Nanite roadmap.
 *
 * CONSTRAINED DECODING (WM 14.2.1 "constrained-decoding-tool-calls"): native
 * `tools` + `format` don't compose reliably on Ollama, and unconstrained native
 * tool-calling on small local models leaks `<tool_call>` scaffolding / garbled
 * (Cyrillic) tokens into `message.content` and drops required args (the missing
 * `slug` bug). So `chatConstrained()` drives a SINGLE grammar-constrained JSON
 * envelope instead: it passes `format` = a JSON schema that is an `anyOf` over
 * one branch per tool (each carrying that tool's own `parameters` schema, so
 * required args like `slug` are forced) plus a `respond` branch for the final
 * answer. Ollama compiles that schema to a llama.cpp grammar, so the model's
 * output is guaranteed schema-valid — no scaffolding, no missing required args.
 * We then map the envelope back onto the same {@link LlamaChatResult} shape
 * (synthesizing `tool_calls`) so `wmToolLoop.ts` needs no change. The legacy
 * native path (`chat()` + {@link parseChatResponse}) is retained for reference.
 *
 * This module is intentionally VS Code-free and takes an injectable `fetch` so
 * it can be unit-tested against a fake server without a live daemon.
 */

/** A tool/function definition in the OpenAI-style schema Ollama accepts. */
export interface LlamaToolDef {
  type: 'function';
  function: {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
  };
}

/** One tool call requested by the model in an assistant turn. */
export interface LlamaToolCall {
  id?: string;
  function: {
    name: string;
    /** Ollama returns already-parsed args (an object), not a JSON string. */
    arguments: Record<string, unknown>;
  };
}

/** A chat message in the Ollama `/api/chat` wire format. */
export interface LlamaMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string;
  /** Present on assistant turns that request tool calls. */
  tool_calls?: LlamaToolCall[];
  /** Set on `tool` messages so the model can correlate the result. */
  tool_name?: string;
}

export interface LlamaChatResult {
  message: LlamaMessage;
  /** Ollama's stop reason (`stop`, `length`, …) when provided. */
  doneReason?: string;
  promptEvalCount?: number;
  evalCount?: number;
}

/** Minimal structural subset of the global `fetch` we depend on. */
export type FetchLike = (
  input: string,
  init?: {
    method?: string;
    headers?: Record<string, string>;
    body?: string;
    signal?: AbortSignal;
  },
) => Promise<{
  ok: boolean;
  status: number;
  statusText: string;
  text(): Promise<string>;
}>;

export interface LlamaClientOptions {
  baseUrl: string;
  model: string;
  /** Sampling temperature; low by default for deterministic tool selection. */
  temperature?: number;
  /** Injectable fetch (defaults to the global). Tests pass a fake. */
  fetchImpl?: FetchLike;
  /** Per-request timeout in ms (default 120s — local models can be slow). */
  timeoutMs?: number;
}

/**
 * Thin client over Ollama's `/api/chat` (non-streaming). One `chat()` call is
 * one model turn; the agentic loop lives in `wmToolLoop.ts`.
 */
export class LlamaClient {
  private readonly baseUrl: string;
  private readonly model: string;
  private readonly temperature: number;
  private readonly fetchImpl: FetchLike;
  private readonly timeoutMs: number;

  constructor(options: LlamaClientOptions) {
    // Trim a trailing slash so `${baseUrl}/api/chat` never doubles up.
    this.baseUrl = options.baseUrl.replace(/\/+$/, '');
    this.model = options.model;
    this.temperature = options.temperature ?? 0;
    this.fetchImpl = options.fetchImpl ?? (globalThis.fetch as unknown as FetchLike);
    this.timeoutMs = options.timeoutMs ?? 120_000;
  }

  /**
   * Send one chat turn via NATIVE tool-calling (legacy path). `tools` exposes
   * the available functions; the returned `message` either carries `tool_calls`
   * or plain `content`. Retained for reference/tests — the widget now uses
   * {@link chatConstrained}. Throws on transport / non-2xx / parse errors.
   */
  async chat(
    messages: LlamaMessage[],
    tools: LlamaToolDef[],
  ): Promise<LlamaChatResult> {
    const raw = await this.post({
      model: this.model,
      messages,
      tools,
      stream: false,
      options: { temperature: this.temperature },
    });
    return parseChatResponse(raw);
  }

  /**
   * Send one chat turn with CONSTRAINED DECODING: instead of native `tools`, we
   * pass `format` = the {@link buildToolEnvelopeSchema} JSON schema so Ollama
   * grammar-constrains the output to a valid tool-call (or `respond`) envelope.
   * The envelope is mapped back onto {@link LlamaChatResult} (with synthesized
   * `tool_calls`) so the loop consumes it identically to the native path.
   */
  async chatConstrained(
    messages: LlamaMessage[],
    tools: LlamaToolDef[],
  ): Promise<LlamaChatResult> {
    const raw = await this.post({
      model: this.model,
      messages,
      format: buildToolEnvelopeSchema(tools),
      stream: false,
      options: { temperature: this.temperature },
    });
    return parseEnvelopeResponse(raw);
  }

  /** POST a JSON body to `/api/chat` (non-streaming) and return the raw text. */
  private async post(payload: Record<string, unknown>): Promise<string> {
    const url = `${this.baseUrl}/api/chat`;
    const body = JSON.stringify(payload);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const res = await this.fetchImpl(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body,
        signal: controller.signal,
      });
      const raw = await res.text();
      if (!res.ok) {
        throw new Error(
          `Local model HTTP ${res.status} ${res.statusText}: ${raw.slice(0, 500)}`,
        );
      }
      return raw;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      throw new Error(`Local model request to ${url} failed: ${msg}`);
    } finally {
      clearTimeout(timer);
    }
  }
}

/**
 * Build the JSON schema passed as Ollama's `format` for constrained decoding: a
 * single top-level object `{ action: <anyOf> }` where each `anyOf` branch is
 * one tool (a `const` discriminator `tool` + that tool's own `parameters`
 * schema as `args`, so required args like `slug` are grammar-forced) plus a
 * `respond` branch `{ tool: "respond", message }` for the final answer.
 * Exported for unit tests.
 */
export function buildToolEnvelopeSchema(tools: LlamaToolDef[]): Record<string, unknown> {
  const branches: unknown[] = tools.map((t) => ({
    type: 'object',
    properties: {
      tool: { const: t.function.name },
      args: t.function.parameters,
    },
    required: ['tool', 'args'],
    additionalProperties: false,
  }));
  branches.push({
    type: 'object',
    properties: {
      tool: { const: 'respond' },
      message: { type: 'string', description: 'Final plain-text answer to the user.' },
    },
    required: ['tool', 'message'],
    additionalProperties: false,
  });
  return {
    type: 'object',
    properties: { action: { anyOf: branches } },
    required: ['action'],
    additionalProperties: false,
  };
}

/** The decoded envelope: either a tool call or a final `respond` message. */
interface ToolEnvelope {
  tool: string;
  args?: Record<string, unknown>;
  message?: string;
}

/**
 * Pull the `{ action: {...} }` envelope out of a constrained response's
 * `content`. Tolerant of the model emitting the action at the top level. Returns
 * `null` when the content is not a recognizable envelope (the caller then falls
 * back to treating the raw content as final text).
 */
function extractEnvelope(content: string): ToolEnvelope | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch {
    return null;
  }
  const root = parsed as { action?: unknown; tool?: unknown };
  const action = (root.action ?? root) as { tool?: unknown; args?: unknown; message?: unknown };
  if (!action || typeof action.tool !== 'string') {
    return null;
  }
  const env: ToolEnvelope = { tool: action.tool };
  if (action.args && typeof action.args === 'object' && !Array.isArray(action.args)) {
    env.args = action.args as Record<string, unknown>;
  }
  if (typeof action.message === 'string') {
    env.message = action.message;
  }
  return env;
}

/**
 * Parse a constrained `/api/chat` response into a {@link LlamaChatResult}. The
 * envelope in `message.content` becomes either a synthesized `tool_calls` entry
 * (tool branch) or a plain-text `content` (the `respond` branch). If the content
 * is somehow not a valid envelope, the raw content is returned as final text
 * (the brief sanitizer strips any residual scaffolding downstream). Exported for
 * unit tests.
 */
export function parseEnvelopeResponse(raw: string): LlamaChatResult {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error(`Local model returned non-JSON response: ${raw.slice(0, 300)}`);
  }
  const obj = parsed as {
    message?: { role?: string; content?: unknown };
    done_reason?: unknown;
    prompt_eval_count?: unknown;
    eval_count?: unknown;
    error?: unknown;
  };
  if (typeof obj.error === 'string') {
    throw new Error(`Local model error: ${obj.error}`);
  }
  if (!obj.message || typeof obj.message !== 'object') {
    throw new Error('Local model response missing `message`');
  }
  const content = typeof obj.message.content === 'string' ? obj.message.content : '';
  const doneReason = typeof obj.done_reason === 'string' ? obj.done_reason : undefined;
  const promptEvalCount =
    typeof obj.prompt_eval_count === 'number' ? obj.prompt_eval_count : undefined;
  const evalCount = typeof obj.eval_count === 'number' ? obj.eval_count : undefined;

  const envelope = extractEnvelope(content);
  if (envelope && envelope.tool !== 'respond') {
    const message: LlamaMessage = {
      role: 'assistant',
      content: '',
      tool_calls: [
        { function: { name: envelope.tool, arguments: envelope.args ?? {} } },
      ],
    };
    return { message, doneReason, promptEvalCount, evalCount };
  }

  const finalText =
    envelope && envelope.tool === 'respond' && typeof envelope.message === 'string'
      ? envelope.message
      : content;
  return {
    message: { role: 'assistant', content: finalText },
    doneReason,
    promptEvalCount,
    evalCount,
  };
}

/**
 * Parse an Ollama `/api/chat` (non-streaming) JSON response into a
 * {@link LlamaChatResult}, normalizing `tool_calls` (whose `arguments` Ollama
 * returns as an already-parsed object, but some servers send a JSON string).
 * Exported for unit tests.
 */
export function parseChatResponse(raw: string): LlamaChatResult {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error(`Local model returned non-JSON response: ${raw.slice(0, 300)}`);
  }
  const obj = parsed as {
    message?: {
      role?: string;
      content?: unknown;
      tool_calls?: unknown;
    };
    done_reason?: unknown;
    prompt_eval_count?: unknown;
    eval_count?: unknown;
    error?: unknown;
  };
  if (typeof obj.error === 'string') {
    throw new Error(`Local model error: ${obj.error}`);
  }
  if (!obj.message || typeof obj.message !== 'object') {
    throw new Error('Local model response missing `message`');
  }
  const role =
    obj.message.role === 'assistant' ? 'assistant' : (obj.message.role as LlamaMessage['role']) ?? 'assistant';
  const content = typeof obj.message.content === 'string' ? obj.message.content : '';
  const toolCalls = normalizeToolCalls(obj.message.tool_calls);
  const message: LlamaMessage = { role: role ?? 'assistant', content };
  if (toolCalls.length > 0) {
    message.tool_calls = toolCalls;
  }
  return {
    message,
    doneReason: typeof obj.done_reason === 'string' ? obj.done_reason : undefined,
    promptEvalCount:
      typeof obj.prompt_eval_count === 'number' ? obj.prompt_eval_count : undefined,
    evalCount: typeof obj.eval_count === 'number' ? obj.eval_count : undefined,
  };
}

function normalizeToolCalls(raw: unknown): LlamaToolCall[] {
  if (!Array.isArray(raw)) {
    return [];
  }
  const out: LlamaToolCall[] = [];
  for (const entry of raw) {
    const fn = (entry as { function?: { name?: unknown; arguments?: unknown } }).function;
    if (!fn || typeof fn.name !== 'string') {
      continue;
    }
    let args: Record<string, unknown> = {};
    if (fn.arguments && typeof fn.arguments === 'object') {
      args = fn.arguments as Record<string, unknown>;
    } else if (typeof fn.arguments === 'string') {
      try {
        const p = JSON.parse(fn.arguments);
        if (p && typeof p === 'object') {
          args = p as Record<string, unknown>;
        }
      } catch {
        // Leave args empty; the loop reports the tool as failed-args.
      }
    }
    const id = (entry as { id?: unknown }).id;
    out.push({
      id: typeof id === 'string' ? id : undefined,
      function: { name: fn.name, arguments: args },
    });
  }
  return out;
}
