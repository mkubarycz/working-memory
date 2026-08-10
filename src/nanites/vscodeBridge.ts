/**
 * The production {@link NaniteLmBridge}: a thin adapter over the VS Code
 * Language Model API. This is the only file in `src/nanites/` that imports
 * `vscode` for behavior (not just types), and it is deliberately kept out of
 * the unit-tested path — tests inject a scripted fake bridge into the runner
 * core instead.
 *
 * Loop shape (standard agentic tool-calling):
 *   selectChatModels → sendRequest → stream text + tool-call parts →
 *   invokeTool (allow-list filtered upstream by the runner) → feed
 *   LanguageModelToolResultPart back as the next user turn → repeat.
 */

import * as vscode from 'vscode';
import type {
  NaniteContainer,
  NaniteConversation,
  NaniteConversationSeed,
  NaniteJudgeRequest,
  NaniteJudgeResult,
  NaniteLmBridge,
  NaniteModelTurn,
  NaniteToolCall,
  NaniteTokenUsage,
  RunnerToken,
} from './types';
import { matchesToolName, resolveToolPlan, stripPrivilegedNaniteArgs } from './toolNames';
import {
  registerContainerTools,
  isContainerTool,
  invokeContainerTool,
} from '../tools/NaniteDevContainer';

function asCancellation(token: RunnerToken): vscode.CancellationToken {
  // `vscode.lm` needs a real CancellationToken (with an `onCancellationRequested`
  // Event); the RunnerToken is only a boolean flag, so bridge it through a source.
  const source = new vscode.CancellationTokenSource();
  if (token.isCancellationRequested) {
    source.cancel();
  }
  return source.token;
}

function flattenToolResult(result: vscode.LanguageModelToolResult): string {
  const parts: string[] = [];
  for (const part of result.content) {
    if (part instanceof vscode.LanguageModelTextPart) {
      parts.push(part.value);
    }
  }
  return parts.join('');
}

/** Best-effort token count; falls back to 0 if the model can't count. */
async function countTokens(
  model: vscode.LanguageModelChat,
  text: string,
): Promise<number> {
  if (!text) {
    return 0;
  }
  try {
    return await model.countTokens(text);
  } catch {
    return 0;
  }
}

/** Trim text to a bounded fallback summary (judge parse-failure path). */
function truncate(text: string, max = 400): string {
  const t = text.trim();
  return t.length > max ? `${t.slice(0, max)}…` : t;
}

interface ParsedJudge {
  request_summary: string;
  response_summary: string;
  /** The judge's explicit pass/fail DECISION (not a score). */
  pass: boolean;
  /** How CERTAIN the judge is in that decision (0-100) — not a degree of passing. */
  confidence: number;
  rationale: string;
}

/**
 * Pull the first well-formed JSON object out of a model reply and read the
 * judge fields. On any parse failure the verdict is confidence 0 with a
 * rationale that says so — a malformed judge reply must never pass acceptance —
 * and the request/response summaries fall back to the raw prompt / output.
 */
function parseJudgeReply(
  reply: string,
  fallbackRequest: string,
  fallbackResponse: string,
): ParsedJudge {
  const match = reply.match(/\{[\s\S]*\}/);
  if (match) {
    try {
      const parsed = JSON.parse(match[0]) as {
        request_summary?: unknown;
        response_summary?: unknown;
        pass?: unknown;
        confidence?: unknown;
        rationale?: unknown;
      };
      const raw = Number(parsed.confidence);
      if (Number.isFinite(raw)) {
        const confidence = Math.max(0, Math.min(100, Math.round(raw)));
        const pass = parsed.pass === true;
        const rationale =
          typeof parsed.rationale === 'string' ? parsed.rationale : '';
        const request_summary =
          typeof parsed.request_summary === 'string' &&
          parsed.request_summary.trim()
            ? parsed.request_summary
            : fallbackRequest;
        const response_summary =
          typeof parsed.response_summary === 'string' &&
          parsed.response_summary.trim()
            ? parsed.response_summary
            : fallbackResponse;
        return { request_summary, response_summary, pass, confidence, rationale };
      }
    } catch {
      // fall through to the parse-failure verdict
    }
  }
  return {
    request_summary: fallbackRequest,
    response_summary: fallbackResponse,
    pass: false,
    confidence: 0,
    rationale: `judge reply could not be parsed as JSON: ${reply.slice(0, 200)}`,
  };
}

class VscodeConversation implements NaniteConversation {
  private readonly messages: vscode.LanguageModelChatMessage[] = [];
  private pendingResults: vscode.LanguageModelToolResultPart[] = [];
  /** Text queued to be counted as input on the next `next()` call. */
  private pendingInputTexts: string[] = [];
  private inputTokens = 0;
  private outputTokens = 0;
  public readonly modelId: string;

  constructor(
    private readonly model: vscode.LanguageModelChat,
    private readonly tools: vscode.LanguageModelChatTool[],
    seed: NaniteConversationSeed,
    public readonly grantedTools: string[],
    public readonly missingTools: string[],
  ) {
    this.modelId = model.id;
    // The LM stable API has no system role — fold the instructions into the
    // first user turn, clearly delimited from the task prompt.
    const seedText = `${seed.instructions}\n\n---\n\nTask: ${seed.prompt}`;
    this.messages.push(vscode.LanguageModelChatMessage.User(seedText));
    this.pendingInputTexts.push(seedText);
  }

  async next(token: RunnerToken): Promise<NaniteModelTurn> {
    if (this.pendingResults.length) {
      this.messages.push(
        vscode.LanguageModelChatMessage.User(this.pendingResults),
      );
      this.pendingResults = [];
    }

    // Count everything queued as input since the last turn.
    for (const text of this.pendingInputTexts) {
      this.inputTokens += await countTokens(this.model, text);
    }
    this.pendingInputTexts = [];

    const response = await this.model.sendRequest(
      this.messages,
      {
        tools: this.tools,
        toolMode: vscode.LanguageModelChatToolMode.Auto,
        justification:
          'Working Memory nanite performing an automated background scan.',
      },
      asCancellation(token),
    );

    let text = '';
    const toolCalls: NaniteToolCall[] = [];
    const assistantParts: Array<
      vscode.LanguageModelTextPart | vscode.LanguageModelToolCallPart
    > = [];

    for await (const part of response.stream) {
      if (part instanceof vscode.LanguageModelTextPart) {
        text += part.value;
        assistantParts.push(part);
      } else if (part instanceof vscode.LanguageModelToolCallPart) {
        toolCalls.push({
          callId: part.callId,
          name: part.name,
          input: part.input,
        });
        assistantParts.push(part);
      }
    }

    this.outputTokens += await countTokens(this.model, text);

    this.messages.push(
      vscode.LanguageModelChatMessage.Assistant(assistantParts),
    );
    return { text, toolCalls };
  }

  addToolResult(callId: string, _name: string, resultText: string): void {
    this.pendingResults.push(
      new vscode.LanguageModelToolResultPart(callId, [
        new vscode.LanguageModelTextPart(resultText),
      ]),
    );
    // The result becomes a user message on the next turn — count it as input.
    this.pendingInputTexts.push(resultText);
  }

  usage(): NaniteTokenUsage {
    return {
      input_tokens: this.inputTokens,
      output_tokens: this.outputTokens,
      total_tokens: this.inputTokens + this.outputTokens,
    };
  }
}

export class VscodeLmBridge implements NaniteLmBridge {
  /**
   * The dev container attached to the CURRENT run, set at {@link start}. The
   * bridge is created PER RUN (see `runNaniteInstance` in extension.ts), so this
   * is safe — one bridge instance never straddles two concurrent runs.
   * TODO(devcontainer-terminal-commands): revisit if a warm-pool/shared-bridge
   * model is introduced, which would need per-conversation container scoping.
   */
  private activeContainer: NaniteContainer | null = null;

  async start(seed: NaniteConversationSeed): Promise<NaniteConversation> {
    const model = await this.selectModel(seed.model);
    this.activeContainer = seed.container ?? null;
    // Resolve the tool policy against the live catalog: allow ∩ available −
    // deny (with `*` = all), plus the allow-list entries that resolved to
    // nothing (missing). The model is offered granted tools under their clean
    // names; the runner enforces + reports against the same set.
    const plan = resolveToolPlan(
      vscode.lm.tools.map((t) => t.name),
      seed.allowlist,
      seed.denylist,
    );
    const byRegistered = new Map(vscode.lm.tools.map((t) => [t.name, t]));
    const tools: vscode.LanguageModelChatTool[] = [];
    for (const g of plan.granted) {
      const info = byRegistered.get(g.registered);
      if (info) {
        tools.push({ name: g.offer, description: info.description, inputSchema: info.inputSchema });
      }
    }
    const granted = plan.granted.map((g) => g.offer);
    // Offer the per-run container tools (`run_command`, and `expose_port` when
    // the container supports it) ONLY when this run has a container.
    if (this.activeContainer) {
      for (const tool of registerContainerTools(this.activeContainer)) {
        tools.push(tool);
        granted.push(tool.name);
      }
    }
    return new VscodeConversation(
      model,
      tools,
      seed,
      granted,
      plan.missing,
    );
  }

  async invokeTool(
    name: string,
    input: unknown,
    token: RunnerToken,
  ): Promise<string> {
    // The per-run container tools are not `vscode.lm` tools — route them to
    // this run's dev container instead of the LM tool registry.
    if (isContainerTool(name)) {
      if (!this.activeContainer) {
        throw new Error(`${name} was called but no dev container is attached to this run`);
      }
      return invokeContainerTool(this.activeContainer, name, input, token);
    }
    const result = await vscode.lm.invokeTool(
      this.resolveRegisteredToolName(name),
      {
        // A nanite must not self-approve or force-start work: strip the
        // extension-host-owned `approved`/`begin` trust signals.
        input: (stripPrivilegedNaniteArgs(name, input ?? {}) ?? {}) as object,
        toolInvocationToken: undefined,
      } as vscode.LanguageModelToolInvocationOptions<object>,
      asCancellation(token),
    );
    return flattenToolResult(result);
  }

  /**
   * Resolve a clean allow-list tool name (the name the model was offered) to
   * the actual registered `vscode.lm` name (possibly MCP-prefixed) to invoke.
   */
  private resolveRegisteredToolName(name: string): string {
    const match = vscode.lm.tools.find((t) => matchesToolName(t.name, name));
    return match ? match.name : name;
  }

  async judge(
    request: NaniteJudgeRequest,
    token: RunnerToken,
  ): Promise<NaniteJudgeResult> {
    const model = await this.selectModel(request.model);
    const actionsBlock = request.toolCalls.length
      ? request.toolCalls
          .map((c) =>
            c.ok
              ? `- ${c.name} (ok)`
              : `- ${c.name} (error: ${c.error ?? 'unknown'})`,
          )
          .join('\n')
      : request.toolsAvailable
        ? '(tools were available but none were called)'
        : '(no tools were available to this run — it could only reason over the PROMPT-provided input)';
    const prompt = [
      'You are a strict acceptance judge. You are given the PROMPT the',
      'automation ran with, the acceptance CRITERIA it must satisfy, the',
      'ACTIONS it took (its tool-call trail), and its final OUTPUT. Evaluate the',
      "automation's work against the CRITERIA — summarize what it did, decide",
      'whether it PASSES, and state how CERTAIN you are in that decision, using',
      'ACTIONS and OUTPUT as evidence of what was actually checked or done. Do',
      'four things in one reply:',
      '  1. Restate, in plain language, what the automation was asked to do',
      '     (from the PROMPT + CRITERIA).',
      '  2. Summarize, in plain language, what the automation actually DID — the',
      '     concrete actions it took (from ACTIONS) and their result (from',
      '     OUTPUT) — as a short sentence describing the work performed. Do NOT',
      '     describe the format or shape of the OUTPUT; describe the actions.',
      '     E.g. "Closed alert-35 because its only linked topic was closed."',
      '  3. DECIDE pass or fail: does the OUTPUT (with ACTIONS as evidence)',
      '     satisfy the CRITERIA? Set "pass" true ONLY if it clearly does, false',
      '     otherwise. Judge ONLY against what the CRITERIA actually require — do',
      '     NOT invent unstated requirements. In particular, do NOT require',
      '     tool-call evidence unless the CRITERIA explicitly call for it: if the',
      '     input the criteria concern is already present in the PROMPT, or no',
      '     tools were available to this run, then reasoning over the PROMPT and',
      '     reporting a conclusion in the OUTPUT can fully satisfy a "check X"',
      '     criterion — the absence of tool calls is NOT a deficiency. When the',
      '     ACTIONS trail IS present, treat it as concrete evidence those steps',
      '     were performed. If the OUTPUT admits it could not do what the CRITERIA',
      '     require (missing/guessed/fabricated data, a required step not run),',
      '     that is a FAIL.',
      '  4. Set "confidence" to how CERTAIN you are IN YOUR pass/fail DECISION',
      '     (integer 0-100) — this is your certainty, NOT how well it passed. A',
      '     clear-cut FAIL is HIGH confidence with "pass": false; do not report',
      '     high confidence with "pass": true when your rationale says it fails.',
      '',
      'Keep each summary to less than a paragraph. Reply with STRICT JSON and',
      'nothing else, in exactly this shape:',
      '{"request_summary": "<what it was asked to do>", "response_summary": "<what it did>", "pass": <true|false>, "confidence": <integer 0-100>, "rationale": "<one short sentence on why it passed or failed>"}',
      '',
      '--- PROMPT ---',
      request.prompt,
      '',
      '--- CRITERIA ---',
      request.criteria,
      '',
      '--- ACTIONS ---',
      actionsBlock,
      '',
      '--- OUTPUT ---',
      request.output,
    ].join('\n');

    const messages = [vscode.LanguageModelChatMessage.User(prompt)];
    const inputTokens = await countTokens(model, prompt);
    const response = await model.sendRequest(
      messages,
      {
        justification:
          'Working Memory nanite judging its output against acceptance criteria.',
      },
      asCancellation(token),
    );

    let reply = '';
    for await (const part of response.stream) {
      if (part instanceof vscode.LanguageModelTextPart) {
        reply += part.value;
      }
    }
    const outputTokens = await countTokens(model, reply);
    const { request_summary, response_summary, pass, confidence, rationale } =
      parseJudgeReply(reply, truncate(request.prompt), truncate(request.output));

    return {
      request_summary,
      response_summary,
      pass,
      confidence,
      rationale,
      model: model.id,
      tokens: {
        input_tokens: inputTokens,
        output_tokens: outputTokens,
        total_tokens: inputTokens + outputTokens,
      },
    };
  }

  /** Select a Copilot model by family, falling back progressively. */
  private async selectModel(
    family: string | null,
  ): Promise<vscode.LanguageModelChat> {
    const selector: vscode.LanguageModelChatSelector = family
      ? { vendor: 'copilot', family }
      : { vendor: 'copilot' };
    let models = await vscode.lm.selectChatModels(selector);
    if (!models.length && family) {
      // Fall back to any Copilot model if the requested family is unavailable.
      models = await vscode.lm.selectChatModels({ vendor: 'copilot' });
    }
    if (!models.length) {
      models = await vscode.lm.selectChatModels();
    }
    const model = models[0];
    if (!model) {
      throw new Error(
        'no language model available (vscode.lm.selectChatModels returned none)',
      );
    }
    return model;
  }
}
