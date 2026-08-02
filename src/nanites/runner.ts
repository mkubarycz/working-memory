/**
 * The nanite run engine — pure control flow. It drives an agentic tool-calling
 * loop but delegates every editor-specific concern (model selection, message
 * construction, streaming, tool dispatch, the acceptance judge) to an
 * injectable {@link NaniteLmBridge}.
 *
 * That seam is deliberate. The real bridge (`vscodeBridge.ts`) is built on
 * `vscode.lm.selectChatModels` / `model.sendRequest` / `vscode.lm.invokeTool`
 * and can only run inside the extension host. Tests inject a scripted fake
 * bridge and exercise this exact loop deterministically — no `vscode` needed.
 *
 * Unlike the pre-control-plane engine, this core does NO persistence and NO
 * document reads: it takes fully-resolved options (instructions, prompt,
 * allow-list, acceptance rubric) and returns a structured {@link NaniteRunResult}.
 * Reading the input topic + template and persisting the result belong to the
 * {@link NaniteRunner} that wraps this core (see `extensionHostRunner.ts`).
 */

import type {
  NaniteAcceptance,
  NaniteLmBridge,
  NaniteRunResult,
  NaniteRunStep,
  RunNaniteOptions,
  RunnerToken,
  ToolCallOutcome,
} from './types';

const NEVER_CANCELLED: RunnerToken = { isCancellationRequested: false };

/** Cap on each persisted arg/result preview so the trace stays bounded. */
const MAX_STEP_PREVIEW = 800;

/** Stringify + truncate a value for a step preview (compact JSON for objects). */
function stepPreview(value: unknown): string {
  let s: string;
  if (typeof value === 'string') {
    s = value;
  } else {
    try {
      s = JSON.stringify(value);
    } catch {
      s = String(value);
    }
  }
  if (s.length > MAX_STEP_PREVIEW) {
    s = s.slice(0, MAX_STEP_PREVIEW) + '… (truncated)';
  }
  return s;
}

/**
 * Execute a nanite headlessly against an injected bridge. Never throws for
 * expected failure modes (model/tool errors); those are captured on the
 * returned result (`status: 'failed'`, `error` set).
 */
export async function runNanite(
  bridge: NaniteLmBridge,
  options: RunNaniteOptions,
): Promise<NaniteRunResult> {
  const token = options.token ?? NEVER_CANCELLED;
  const maxIterations = Math.max(1, options.maxIterations ?? 12);
  const prompt = options.prompt.trim();
  const allowlist = options.allowlist;
  const denylist = options.denylist ?? [];

  const toolCalls: ToolCallOutcome[] = [];
  const steps: NaniteRunStep[] = [];
  let iterations = 0;
  let hitCap = false;
  let finalText = '';

  try {
    const convo = await bridge.start({
      instructions: options.instructions,
      prompt,
      allowlist,
      denylist,
      model: options.model ?? null,
    });
    // The bridge resolved the policy (allow ∩ available − deny). Enforce tool
    // calls against the RESOLVED grant, not the raw allow-list, so `*` and the
    // deny-list are honored uniformly.
    const grantedTools = convo.grantedTools;

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
        // Record the between-tool narration in the execution trace so the
        // rendered workflow shows what the model was reasoning before it
        // reached for the tools below.
        steps.push({ kind: 'assistant', text: turn.text.trim() });
      }

      for (const call of turn.toolCalls) {
        if (!grantedTools.includes(call.name)) {
          const err = `tool '${call.name}' is not granted to this nanite`;
          toolCalls.push({ name: call.name, ok: false, error: err });
          steps.push({
            kind: 'tool',
            name: call.name,
            ok: false,
            input: stepPreview(call.input),
            error: err,
          });
          convo.addToolResult(
            call.callId,
            call.name,
            JSON.stringify({ ok: false, error: err }),
          );
          continue;
        }
        try {
          const resultText = await bridge.invokeTool(call.name, call.input, token);
          toolCalls.push({ name: call.name, ok: true });
          steps.push({
            kind: 'tool',
            name: call.name,
            ok: true,
            input: stepPreview(call.input),
            result: stepPreview(resultText),
          });
          convo.addToolResult(call.callId, call.name, resultText);
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          toolCalls.push({ name: call.name, ok: false, error: message });
          steps.push({
            kind: 'tool',
            name: call.name,
            ok: false,
            input: stepPreview(call.input),
            error: message,
          });
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

    // Acceptance validation: one extra LM call (same model) that restates the
    // request, summarizes the response, and scores how well the final output
    // meets the rubric. Its tokens fold into the totals.
    const verdict = await bridge.judge(
      {
        criteria: options.acceptanceCriteria,
        prompt,
        output: finalText,
        toolCalls,
        toolsAvailable: grantedTools.length > 0,
        model: options.model ?? null,
      },
      token,
    );
    // Acceptance = the judge's explicit PASS decision, AND enough certainty in
    // it (threshold). `confidence` is the judge's certainty in its verdict, not
    // a pass-score — so a confident FAIL (pass:false) must never accept.
    const passed = verdict.pass && verdict.confidence >= options.acceptanceThreshold;
    const acceptance: NaniteAcceptance = {
      summary: verdict.rationale,
      confidence: verdict.confidence,
      threshold: options.acceptanceThreshold,
      passed,
    };

    const inputTokens = loopUsage.input_tokens + verdict.tokens.input_tokens;
    const outputTokens = loopUsage.output_tokens + verdict.tokens.output_tokens;

    const result: NaniteRunResult = {
      status: passed ? 'succeeded' : 'failed',
      output: finalText,
      acceptance,
      toolCalls,
      steps,
      iterations,
      hitIterationCap: hitCap,
      model: convo.modelId,
      tokens: {
        input_tokens: inputTokens,
        output_tokens: outputTokens,
        total_tokens: inputTokens + outputTokens,
      },
      requestSummary: verdict.request_summary || prompt,
      responseSummary: verdict.response_summary || finalText,
    };
    if (convo.missingTools.length > 0) {
      result.missingTools = convo.missingTools;
    }
    if (!passed) {
      result.error = 'Acceptance Criteria Not Matched';
    }
    return result;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      status: 'failed',
      output: finalText,
      toolCalls,
      steps,
      iterations,
      hitIterationCap: hitCap,
      error: message,
    };
  }
}
