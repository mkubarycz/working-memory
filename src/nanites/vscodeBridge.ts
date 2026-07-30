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
        confidence?: unknown;
        rationale?: unknown;
      };
      const raw = Number(parsed.confidence);
      if (Number.isFinite(raw)) {
        const confidence = Math.max(0, Math.min(100, Math.round(raw)));
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
        return { request_summary, response_summary, confidence, rationale };
      }
    } catch {
      // fall through to the parse-failure verdict
    }
  }
  return {
    request_summary: fallbackRequest,
    response_summary: fallbackResponse,
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
  async start(seed: NaniteConversationSeed): Promise<NaniteConversation> {
    const model = await this.selectModel(seed.model);
    return new VscodeConversation(model, this.buildTools(seed.allowlist), seed);
  }

  async invokeTool(
    name: string,
    input: unknown,
    token: RunnerToken,
  ): Promise<string> {
    const result = await vscode.lm.invokeTool(
      name,
      {
        input: (input ?? {}) as object,
        toolInvocationToken: undefined,
      } as vscode.LanguageModelToolInvocationOptions<object>,
      asCancellation(token),
    );
    return flattenToolResult(result);
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
      "automation's work against the CRITERIA — summarize what it did, then",
      'score how well that work satisfies the criteria, using ACTIONS and OUTPUT',
      'as evidence of what was actually checked or done. Do three things in one',
      'reply:',
      '  1. Restate, in plain language, what the automation was asked to do',
      '     (from the PROMPT + CRITERIA).',
      '  2. Summarize, in plain language, what the automation actually DID — the',
      '     concrete actions it took (from ACTIONS) and their result (from',
      '     OUTPUT) — as a short sentence describing the work performed. Do NOT',
      '     describe the format or shape of the OUTPUT; describe the actions.',
      '     E.g. "Closed alert-35 because its only linked topic was closed."',
      '  3. Evaluate that response summary against the CRITERIA, given the',
      '     PROMPT. Judge ONLY against what the CRITERIA actually require — do',
      '     NOT invent unstated requirements. In particular, do NOT require',
      '     tool-call evidence unless the CRITERIA explicitly call for it: if the',
      '     input the criteria concern is already present in the PROMPT, or no',
      '     tools were available to this run, then reasoning over the PROMPT and',
      '     reporting a conclusion in the OUTPUT fully satisfies a "check X"',
      '     criterion — the absence of tool calls is NOT a deficiency. When the',
      '     ACTIONS trail IS present, treat it as concrete evidence that those',
      '     steps were performed; do NOT lower confidence merely because the',
      '     OUTPUT does not exhaustively prove every step, or because only a few',
      '     tool calls were made, when the work plausibly covers the criteria.',
      '     Judge whether the work was done correctly, not whether it was',
      '     exhaustively documented. Reserve low confidence for cases where the',
      '     ACTIONS or OUTPUT actually contradict or fail the criteria; stay',
      '     conservative about genuine failures.',
      '',
      'Keep each summary to less than a paragraph. Reply with STRICT JSON and',
      'nothing else, in exactly this shape:',
      '{"request_summary": "<what it was asked to do>", "response_summary": "<what it did>", "confidence": <integer 0-100>, "rationale": "<one short sentence on why it passed/failed>"}',
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
    const { request_summary, response_summary, confidence, rationale } =
      parseJudgeReply(reply, truncate(request.prompt), truncate(request.output));

    return {
      request_summary,
      response_summary,
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

  /** Map allow-listed tool names to LM tool descriptors (skip unknown ones). */
  private buildTools(allowlist: string[]): vscode.LanguageModelChatTool[] {
    const registered = new Map(vscode.lm.tools.map((t) => [t.name, t]));
    const tools: vscode.LanguageModelChatTool[] = [];
    for (const name of allowlist) {
      const info = registered.get(name);
      if (!info) {
        continue;
      }
      tools.push({
        name: info.name,
        description: info.description,
        inputSchema: info.inputSchema,
      });
    }
    return tools;
  }
}
