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
 * Empirically discovered on Michael's Mac: Ollama at `http://localhost:11434`
 * serving `qwen2.5:14b`, whose `capabilities` include `tools` — i.e. it speaks
 * the OpenAI-style function/tool-calling API natively (`/api/chat` accepts a
 * `tools` array and returns `message.tool_calls`). So we use native tool-calling
 * rather than a hand-rolled JSON harness.
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
   * Send one chat turn. `tools` exposes the available functions; the returned
   * `message` either carries `tool_calls` (the model wants to act) or plain
   * `content` (its final answer). Throws on transport / non-2xx / parse errors
   * so the loop can surface a clear failure.
   */
  async chat(
    messages: LlamaMessage[],
    tools: LlamaToolDef[],
  ): Promise<LlamaChatResult> {
    const url = `${this.baseUrl}/api/chat`;
    const body = JSON.stringify({
      model: this.model,
      messages,
      tools,
      stream: false,
      options: { temperature: this.temperature },
    });

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    let raw: string;
    try {
      const res = await this.fetchImpl(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body,
        signal: controller.signal,
      });
      raw = await res.text();
      if (!res.ok) {
        throw new Error(
          `Local model HTTP ${res.status} ${res.statusText}: ${raw.slice(0, 500)}`,
        );
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      throw new Error(`Local model request to ${url} failed: ${msg}`);
    } finally {
      clearTimeout(timer);
    }

    return parseChatResponse(raw);
  }
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
