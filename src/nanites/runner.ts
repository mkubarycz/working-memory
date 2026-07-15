/**
 * The nanite run engine. Pure control flow: it drives an agentic tool-calling
 * loop but delegates every editor-specific concern (model selection, message
 * construction, streaming, tool dispatch) to an injectable {@link NaniteLmBridge}.
 *
 * That seam is deliberate. The real bridge (see `vscodeBridge.ts`) is built on
 * `vscode.lm.selectChatModels` / `model.sendRequest` / `vscode.lm.invokeTool`
 * and can only run inside the extension host. Tests inject a scripted fake
 * bridge and exercise the exact same loop deterministically.
 */

import type { NanitesStore } from './store';

/** Minimal cancellation surface (compatible with vscode.CancellationToken). */
export interface RunnerToken {
  isCancellationRequested: boolean;
}

export interface NaniteToolCall {
  callId: string;
  name: string;
  input: unknown;
}

export interface NaniteModelTurn {
  /** Assistant free-text emitted this turn (may be empty on a tool-only turn). */
  text: string;
  /** Tool calls the model requested this turn (empty ⇒ the turn is final). */
  toolCalls: NaniteToolCall[];
}

/**
 * Approximate token usage. The VS Code stable LM API does not expose real
 * billed token counts, so the bridge derives these from `model.countTokens`.
 * Treat them as estimates, not billing truth.
 */
export interface NaniteTokenUsage {
  input_tokens: number;
  output_tokens: number;
  total_tokens: number;
}

/** A live conversation the bridge maintains for the duration of one run. */
export interface NaniteConversation {
  /** The id of the model backing this conversation (e.g. `gpt-4o`). */
  readonly modelId: string;
  /** Send the accumulated messages, append the assistant reply, return it. */
  next(token: RunnerToken): Promise<NaniteModelTurn>;
  /** Record a tool result so it is fed into the next turn. */
  addToolResult(callId: string, name: string, resultText: string): void;
  /** Approximate cumulative token usage across every turn so far. */
  usage(): NaniteTokenUsage;
}

export interface NaniteConversationSeed {
  instructions: string;
  prompt: string;
  allowlist: string[];
  model: string | null;
}

/**
 * A request to (a) restate what the run was asked to do, (b) summarize what it
 * produced, and (c) score that output against its acceptance criteria — all in
 * a single LM call.
 */
export interface NaniteJudgeRequest {
  criteria: string;
  /** The prompt the run actually executed with. */
  prompt: string;
  output: string;
  /**
   * The tool-call trail the run accumulated (name + ok + optional error), in
   * execution order. Fed to the judge so its response summary can describe the
   * concrete actions the automation took — not just the shape of the output.
   */
  toolCalls: ToolCallOutcome[];
  /** Same model family the nanite ran with (null ⇒ bridge default). */
  model: string | null;
}

/** The judge's verdict, plus the approximate tokens its own call consumed. */
export interface NaniteJudgeResult {
  /** A <paragraph plain-language restatement of what the nanite was asked to do. */
  request_summary: string;
  /** A <paragraph plain-language summary of what the run actually produced. */
  response_summary: string;
  /** Integer 0-100 confidence that the output meets the criteria. */
  confidence: number;
  /** The acceptance judgement (why it passed/failed). */
  rationale: string;
  /** Id of the model that produced the verdict. */
  model: string;
  tokens: NaniteTokenUsage;
}

/** The editor-specific surface the runner depends on. */
export interface NaniteLmBridge {
  /** Seed a conversation with instructions + prompt + the allow-listed tools. */
  start(seed: NaniteConversationSeed): Promise<NaniteConversation>;
  /** Dispatch an allow-listed tool call; returns the tool's text result. */
  invokeTool(name: string, input: unknown, token: RunnerToken): Promise<string>;
  /** Score a run's output against its acceptance criteria (one LM call). */
  judge(request: NaniteJudgeRequest, token: RunnerToken): Promise<NaniteJudgeResult>;
}

export interface RunNaniteOptions {
  slug: string;
  /** Extra user input. Defaults to the nanite's `trigger_phrase`. */
  prompt?: string;
  /** Safety cap on model turns. Defaults to 12. */
  maxIterations?: number;
  token?: RunnerToken;
}

export interface ToolCallOutcome {
  name: string;
  ok: boolean;
  error?: string;
}

/**
 * A short structured summary of what the run was asked to do, plus the exact
 * prompt the nanite executed with. `prompt` is verbatim; `summary` is the
 * judge's plain-language restatement.
 */
export interface NaniteRequestSummary {
  prompt: string;
  summary: string;
}

/**
 * A short structured summary of what the run actually produced. `summary` is
 * the judge's plain-language summary; `output` is the nanite's verbatim final
 * text.
 */
export interface NaniteResponseSummary {
  summary: string;
  output: string;
}

/** The acceptance-judge verdict, surfaced on the run result. */
export interface NaniteAcceptanceResult {
  /** Plain-language rationale for the pass/fail judgement. */
  summary: string;
  confidence: number;
  threshold: number;
  passed: boolean;
}

export interface RunNaniteResult {
  ok: boolean;
  nanite_slug: string;
  run_id: number;
  status: 'succeeded' | 'failed';
  iterations: number;
  hit_iteration_cap: boolean;
  tool_calls: ToolCallOutcome[];
  /** Structured restatement of what the run was asked to do (carries the raw prompt). */
  request?: NaniteRequestSummary;
  /** Structured summary of what the run produced. */
  response?: NaniteResponseSummary;
  /** Id of the model that ran the loop (absent on infra failure). */
  model?: string;
  /** Approximate input tokens (loop + judge). */
  input_tokens?: number;
  /** Approximate output tokens (loop + judge). */
  output_tokens?: number;
  /** Approximate total tokens (loop + judge). */
  total_tokens?: number;
  /** The acceptance-judge verdict (absent on infra failure before judging). */
  acceptance?: NaniteAcceptanceResult;
  error?: string;
}

const NEVER_CANCELLED: RunnerToken = { isCancellationRequested: false };

/**
 * Execute a nanite headlessly. Records a `nanite_runs` row (running →
 * succeeded/failed) and returns a structured summary. Never throws for
 * expected failure modes (unknown/disabled nanite, model/tool errors); those
 * are captured on the run row and reflected in the returned result.
 */
export async function runNanite(
  store: NanitesStore,
  bridge: NaniteLmBridge,
  options: RunNaniteOptions,
): Promise<RunNaniteResult> {
  const slug = options.slug;
  const nanite = store.getNaniteBySlug(slug);
  if (!nanite) {
    throw new Error(`nanite not found: ${slug}`);
  }
  if (!nanite.enabled) {
    throw new Error(`nanite is disabled: ${slug}`);
  }

  const token = options.token ?? NEVER_CANCELLED;
  const maxIterations = Math.max(1, options.maxIterations ?? 12);
  const prompt = (options.prompt?.trim() || nanite.trigger_phrase || '').trim();
  const allowlist = nanite.tool_allowlist;

  const runId = store.startRun(nanite.id);
  const toolCalls: ToolCallOutcome[] = [];
  let iterations = 0;
  let hitCap = false;
  let finalText = '';

  try {
    const convo = await bridge.start({
      instructions: nanite.instructions,
      prompt,
      allowlist,
      model: nanite.model,
    });

    for (let i = 0; i < maxIterations; i++) {
      if (token.isCancellationRequested) {
        throw new Error('run cancelled');
      }
      iterations++;
      const turn = await convo.next(token);

      if (!turn.toolCalls.length) {
        finalText = turn.text;
        break;
      }

      // Capture assistant narration even on tool-only turns.
      if (turn.text.trim()) {
        finalText = turn.text;
      }

      for (const call of turn.toolCalls) {
        if (!allowlist.includes(call.name)) {
          const err = `tool '${call.name}' is not in this nanite's allow-list`;
          toolCalls.push({ name: call.name, ok: false, error: err });
          convo.addToolResult(
            call.callId,
            call.name,
            JSON.stringify({ ok: false, error: err }),
          );
          continue;
        }
        try {
          const resultText = await bridge.invokeTool(
            call.name,
            call.input,
            token,
          );
          toolCalls.push({ name: call.name, ok: true });
          convo.addToolResult(call.callId, call.name, resultText);
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          toolCalls.push({ name: call.name, ok: false, error: message });
          convo.addToolResult(
            call.callId,
            call.name,
            JSON.stringify({ ok: false, error: message }),
          );
        }
      }

      if (i === maxIterations - 1) {
        hitCap = true;
      }
    }

    // Approximate token usage accumulated across the tool-calling loop.
    const loopUsage = convo.usage();

    // Acceptance-criteria validation: one extra LM call (same model) that
    // restates the request, summarizes the response, and scores how well the
    // final output meets the nanite's rubric. Its tokens fold into the totals.
    const verdict = await bridge.judge(
      {
        criteria: nanite.acceptance_criteria,
        prompt,
        output: finalText,
        toolCalls,
        model: nanite.model,
      },
      token,
    );
    const passed = verdict.confidence >= nanite.acceptance_threshold;
    const request: NaniteRequestSummary = {
      prompt,
      summary: verdict.request_summary || prompt,
    };
    const response: NaniteResponseSummary = {
      summary: verdict.response_summary || finalText,
      output: finalText,
    };
    const acceptance: NaniteAcceptanceResult = {
      summary: verdict.rationale,
      confidence: verdict.confidence,
      threshold: nanite.acceptance_threshold,
      passed,
    };

    const inputTokens = loopUsage.input_tokens + verdict.tokens.input_tokens;
    const outputTokens = loopUsage.output_tokens + verdict.tokens.output_tokens;
    const totalTokens = inputTokens + outputTokens;

    const persisted = {
      iterations,
      hit_iteration_cap: hitCap,
      tool_calls: toolCalls,
      request,
      response,
      acceptance,
      model: convo.modelId,
      input_tokens: inputTokens,
      output_tokens: outputTokens,
      total_tokens: totalTokens,
    };

    const base = {
      nanite_slug: slug,
      run_id: runId,
      ...persisted,
    };

    if (!passed) {
      const error = 'Acceptance Criteria Not Matched';
      store.finishRun(runId, 'failed', persisted, error);
      return { ok: false, status: 'failed', ...base, error };
    }

    store.finishRun(runId, 'succeeded', persisted, null);
    return { ok: true, status: 'succeeded', ...base };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    store.finishRun(
      runId,
      'failed',
      {
        iterations,
        tool_calls: toolCalls,
        request: { prompt, summary: prompt },
        response: { summary: finalText, output: finalText },
      },
      message,
    );
    return {
      ok: false,
      nanite_slug: slug,
      run_id: runId,
      status: 'failed',
      iterations,
      hit_iteration_cap: hitCap,
      tool_calls: toolCalls,
      request: { prompt, summary: prompt },
      response: { summary: finalText, output: finalText },
      error: message,
    };
  }
}
