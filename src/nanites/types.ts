/**
 * Shared type shapes for the nanite run engine (`src/nanites/`).
 *
 * The whole task-runner feature lives in this one folder so it can be reasoned
 * about — and toggled — as an isolated unit. Nothing outside `src/nanites/`
 * touches `vscode.lm`, the tool-calling loop, or the acceptance judge; callers
 * only ever DISPATCH through the {@link NaniteRunner} interface.
 *
 * The runner *core* ({@link "./runner".runNanite}) is pure control flow: it
 * depends only on the injectable {@link NaniteLmBridge} seam, never on `vscode`.
 * The real bridge (`vscodeBridge.ts`) is the only file here that imports
 * `vscode` for behavior and is deliberately kept off the unit-tested path.
 */

import type { Nanite } from '../controlPlaneClient';

/** Minimal cancellation surface (compatible with `vscode.CancellationToken`). */
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
  /** Clean names of the tools actually granted to (and offered) this run —
   *  the resolved allow-list ∩ available − deny-list. The runner enforces
   *  tool calls against THIS set. */
  readonly grantedTools: string[];
  /** Allow-list entries that matched no available tool at run time. */
  readonly missingTools: string[];
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
  /** Tool names the run may NEVER use (subtracted from the allow-list). */
  denylist: string[];
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
  /**
   * Whether ANY tools were available to the run (the template's allow-list was
   * non-empty). Lets the judge tell "chose not to call tools" from "had no
   * tools" — so it never demands tool-call evidence the run could not produce.
   */
  toolsAvailable: boolean;
  /** Same model family the nanite ran with (null ⇒ bridge default). */
  model: string | null;
}

/** The judge's verdict, plus the approximate tokens its own call consumed. */
export interface NaniteJudgeResult {
  /** A plain-language restatement of what the nanite was asked to do. */
  request_summary: string;
  /** A plain-language summary of what the run actually produced. */
  response_summary: string;
  /** The judge's explicit pass/fail DECISION for the run. */
  pass: boolean;
  /** Integer 0-100 — the judge's CERTAINTY in its pass/fail decision (NOT a
   *  degree of passing). */
  confidence: number;
  /** The acceptance judgement (why it passed/failed). */
  rationale: string;
  /** Id of the model that produced the verdict. */
  model: string;
  tokens: NaniteTokenUsage;
}

/** The editor-specific surface the runner core depends on. */
export interface NaniteLmBridge {
  /** Seed a conversation with instructions + prompt + the allow-listed tools. */
  start(seed: NaniteConversationSeed): Promise<NaniteConversation>;
  /** Dispatch an allow-listed tool call; returns the tool's text result. */
  invokeTool(name: string, input: unknown, token: RunnerToken): Promise<string>;
  /** Score a run's output against its acceptance criteria (one LM call). */
  judge(request: NaniteJudgeRequest, token: RunnerToken): Promise<NaniteJudgeResult>;
}

export interface ToolCallOutcome {
  name: string;
  ok: boolean;
  error?: string;
}

/**
 * One ordered step in a run's execution trace. The trace interleaves the
 * model's own narration (`kind: 'assistant'`) with each tool call it made
 * (`kind: 'tool'`), in the exact order they happened — so a reader can follow
 * the full workflow: what the model said, which tool it reached for next, and
 * what came back. Previews (`input`/`result`) are pre-stringified and truncated
 * by the runner so the persisted trace stays bounded.
 */
export interface NaniteRunStep {
  kind: 'assistant' | 'tool';
  /** Assistant narration for this step (`kind: 'assistant'`). */
  text?: string;
  /** Tool name (`kind: 'tool'`). */
  name?: string;
  /** Whether the tool call succeeded (`kind: 'tool'`). */
  ok?: boolean;
  /** Truncated preview of the tool arguments (`kind: 'tool'`). */
  input?: string;
  /** Truncated preview of the tool's text result (`kind: 'tool'`, on success). */
  result?: string;
  /** Failure message (`kind: 'tool'`, when the call errored or was denied). */
  error?: string;
}

/** The acceptance-judge verdict, surfaced on (and persisted with) a run. */
export interface NaniteAcceptance {
  /** Plain-language rationale for the pass/fail judgement. */
  summary: string;
  confidence: number;
  threshold: number;
  passed: boolean;
}

/** Options for one pure {@link "./runner".runNanite} invocation. */
export interface RunNaniteOptions {
  /** The template's instructions (empty when the nanite has no template). */
  instructions: string;
  /** The prompt the run executes with — the input topic's body. */
  prompt: string;
  /** Allow-listed tool names the run may invoke (`*` = all available). */
  allowlist: string[];
  /** Tool names the run may NEVER use (subtracted from the allow-list). */
  denylist?: string[];
  /** Human-written rubric the output is judged against (may be empty). */
  acceptanceCriteria: string;
  /** Minimum judge confidence (0-100) for the run to pass. */
  acceptanceThreshold: number;
  /** Model family to run with (null ⇒ bridge default). */
  model?: string | null;
  /** Safety cap on model turns. Defaults to 12. */
  maxIterations?: number;
  token?: RunnerToken;
}

/**
 * The structured result of one nanite run. Returned by the pure runner core and
 * persisted onto the Nanite document (`output` + `acceptance` + optional
 * `toolCalls`/`tokens`) by whichever {@link NaniteRunner} drove it.
 */
export interface NaniteRunResult {
  status: 'succeeded' | 'failed';
  /** The nanite's verbatim final text. */
  output: string;
  /** The acceptance verdict (absent on infra failure before judging). */
  acceptance?: NaniteAcceptance;
  /** The tool-call trail (name + ok + optional error), in execution order. */
  toolCalls: ToolCallOutcome[];
  /**
   * The ordered execution trace — the model's narration interleaved with each
   * tool call, in the order they occurred. Richer than {@link toolCalls}: it
   * also carries the between-tool narration and truncated arg/result previews,
   * so the full workflow can be rendered inline with the response.
   */
  steps: NaniteRunStep[];
  /** Allow-list entries that weren't available at run time (typo / not
   *  installed / MCP server down). Empty when everything requested resolved. */
  missingTools?: string[];
  iterations: number;
  hitIterationCap: boolean;
  /** Id of the model that ran the loop (absent on infra failure). */
  model?: string;
  /** Approximate token usage (loop + judge). */
  tokens?: NaniteTokenUsage;
  /** The judge's plain-language restatement of the request. */
  requestSummary?: string;
  /** The judge's plain-language summary of the response. */
  responseSummary?: string;
  /** Failure message (present when status is 'failed'). */
  error?: string;
}

/**
 * The uniform task-runner interface. A runner is handed a {@link Nanite} and
 * manages its ENTIRE execution: read the input topic + template, invoke the
 * model/tools, judge acceptance, and persist the result. Runner dependencies
 * (the control-plane client, the model bridge) are injected at construction, so
 * every call site is just `runner.run(nanite)`.
 */
export interface NaniteRunner {
  /** The execution-provider id this runner is registered under. */
  readonly id: string;
  run(nanite: Nanite): Promise<NaniteRunResult>;
}
