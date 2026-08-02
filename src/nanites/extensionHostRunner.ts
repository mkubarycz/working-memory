/**
 * The extension-host {@link NaniteRunner} — execution provider #1.
 *
 * This is where the pure {@link runNanite} core meets the real world: it reads
 * the input topic + Nanite Template through the injected control-plane client,
 * runs the tool-calling loop via the injected {@link NaniteLmBridge} (the
 * `vscode.lm`-backed one in production), and persists the lifecycle + result
 * back onto the Nanite document.
 *
 * It runs in the EXTENSION HOST because the model call (`vscode.lm`) lives here
 * — the control-plane daemon is pure Node and cannot reach the LM API. Later
 * providers (Copilot CLI, local, Foundry) implement the same interface behind
 * the registry and are out of scope for now.
 */

import type {
  Nanite,
  NaniteRunInput,
  NaniteTemplate,
  Topic,
  Workstream,
} from '../controlPlaneClient';
import { runNanite } from './runner';
import type {
  NaniteLmBridge,
  NaniteRunResult,
  NaniteRunner,
  RunnerToken,
} from './types';

/** The provider id the extension-host runner registers under. */
export const EXTENSION_HOST_RUNNER_ID = 'extension-host';

/**
 * The slice of the control-plane client the runner needs. Kept structural so
 * the runner is unit-testable with a lightweight fake — the real
 * `ControlPlaneClient` satisfies it.
 */
export interface NaniteRunnerClient {
  naniteTemplateRead(input: { slug?: string; id?: string }): Promise<NaniteTemplate[]>;
  topicRead(input: { slug?: string; workstream?: string }): Promise<Topic[]>;
  wsRead(input: { slug?: string }): Promise<Workstream[]>;
  naniteRun(input: NaniteRunInput): Promise<Nanite>;
}

export interface ExtensionHostRunnerDeps {
  client: NaniteRunnerClient;
  bridge: NaniteLmBridge;
  /** Safety cap on model turns (forwarded to the core). */
  maxIterations?: number;
  /** Wall-clock cap for a run before it's forced to Failed. Default 120s. */
  timeoutMs?: number;
  /** Cap for each control-plane READ during input resolution. Default 20s. */
  readTimeoutMs?: number;
  /** Cap for each control-plane WRITE (lifecycle persist). Default 15s. */
  persistTimeoutMs?: number;
  /** Clock for the run prompt's Context section (injectable for tests). */
  now?: () => Date;
  token?: RunnerToken;
}

/** Default wall-clock cap so a hung model call can't strand a nanite in Running. */
const DEFAULT_RUN_TIMEOUT_MS = 120_000;
/** Default cap on each input-resolution read so a hung daemon can't stall a run. */
const DEFAULT_READ_TIMEOUT_MS = 20_000;
/** Default cap on each lifecycle persist so a hung write can't strand a nanite. */
const DEFAULT_PERSIST_TIMEOUT_MS = 15_000;

/**
 * Appended to every run's system instructions: the model must not fake success
 * when it lacks a capability — it reports the gap (a soft request surfaced to
 * the author) instead of reaching for tools it wasn't granted.
 */
const SELF_REPORT_DIRECTIVE =
  'If you lack a tool or capability needed to complete the task, do NOT claim ' +
  'success — state plainly what you could not do and name the tool or ' +
  'capability you would need. Only report work you actually performed; if a ' +
  'tool call failed or returned an error, treat the step as NOT done.';

/** Reject `promise` with a labelled error if it doesn't settle within `ms`. */
function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`${label} timed out after ${Math.round(ms / 1000)}s`)),
      ms,
    );
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (err) => {
        clearTimeout(timer);
        reject(err);
      },
    );
  });
}

/** A terminal Failed result carrying `message`, with no partial output. */
function failedResult(message: string): NaniteRunResult {
  return {
    status: 'failed',
    output: '',
    toolCalls: [],
    steps: [],
    iterations: 0,
    hitIterationCap: false,
    error: message,
  };
}

/**
 * Assemble the run prompt handed to the model: the owning **workstream**, the
 * **input topic** (title + body) OR — for a workstream-wide Nanite with no
 * single topic — the workstream's topics (an **index** the model can fetch via
 * `ws-topic-read` when that tool is granted, else the topics' full content
 * inlined), and the **task** (the nanite's request, or the template's trigger
 * phrase). The template `instructions` are the system prompt (folded into the
 * seed by the bridge) and are NOT repeated here.
 */
function buildRunPrompt(ctx: {
  workstream: Workstream | undefined;
  topic: Topic | undefined;
  workstreamTopics?: Topic[];
  request: string;
  template: NaniteTemplate | null;
  now: Date;
}): string {
  // Ambient context every run gets for free (no tool call needed). Starts with
  // the current time so a nanite can reason about "due today" etc. Extend later.
  const parts: string[] = [
    `# Context\nCurrent time: ${ctx.now.toISOString()} (local: ${ctx.now.toString()})`,
  ];
  if (ctx.workstream) {
    parts.push(
      `# Workstream\n${ctx.workstream.title} (${ctx.workstream.slug ?? '—'}) — status: ${ctx.workstream.status}`,
    );
  }
  if (ctx.topic) {
    parts.push(
      `# Input topic\n${ctx.topic.title} (${ctx.topic.slug ?? '—'})\n\n${ctx.topic.body ?? ''}`.trim(),
    );
  } else if (ctx.workstreamTopics && ctx.workstreamTopics.length > 0) {
    // Only promise the tool-call path if the template's POLICY grants a
    // topic-read tool (allow-list has it, or `*`, and the deny-list doesn't
    // block it); otherwise inline each topic's full content so the run has
    // everything it needs without any tools.
    const allow = ctx.template?.toolAllowlist ?? [];
    const deny = ctx.template?.toolDenylist ?? [];
    const isTopicRead = (t: string): boolean => t === 'ws-topic-read' || t.endsWith('topic-read');
    const grantsTopicRead =
      !deny.some(isTopicRead) && (allow.includes('*') || allow.some(isTopicRead));
    if (grantsTopicRead) {
      const index = ctx.workstreamTopics
        .map((t) => `- ${t.title} (${t.slug ?? '—'}) — ${t.status}`)
        .join('\n');
      parts.push(
        `# Topics in this workstream\nThis Nanite runs workstream-wide (no single input ` +
          `topic). The workstream's topics are listed below — fetch any topic's full ` +
          `content with a ws-topic-read tool call when you need it.\n\n${index}`,
      );
    } else {
      const full = ctx.workstreamTopics
        .map((t) =>
          `## ${t.title} (${t.slug ?? '—'}) — ${t.status}\n\n${t.body ?? ''}`.trim(),
        )
        .join('\n\n');
      parts.push(
        `# Topics in this workstream\nThis Nanite runs workstream-wide (no single input ` +
          `topic); each topic's full content is included below.\n\n${full}`,
      );
    }
  }
  const task = (ctx.request.trim() || ctx.template?.triggerPhrase || '').trim();
  if (task) {
    parts.push(`# Task\n${task}`);
  }
  return parts.join('\n\n');
}

/** Read `executionSettings.model` defensively (absent / foreign shape → null). */
function modelFromSettings(settings: Record<string, unknown> | undefined): string | null {
  const model = settings?.model;
  return typeof model === 'string' && model.trim() ? model : null;
}

/**
 * Load a Nanite Template by its `templateId`, which may be a slug OR a document
 * id — try slug first, then fall back to id. Returns null when the nanite has
 * no template or none is found.
 */
async function loadTemplate(
  client: NaniteRunnerClient,
  templateId: string | null,
): Promise<NaniteTemplate | null> {
  if (!templateId) {
    return null;
  }
  const bySlug = await client.naniteTemplateRead({ slug: templateId });
  if (bySlug[0]) {
    return bySlug[0];
  }
  const byId = await client.naniteTemplateRead({ id: templateId });
  return byId[0] ?? null;
}

export class ExtensionHostNaniteRunner implements NaniteRunner {
  readonly id = EXTENSION_HOST_RUNNER_ID;

  constructor(private readonly deps: ExtensionHostRunnerDeps) {}

  async run(nanite: Nanite): Promise<NaniteRunResult> {
    const { client, bridge } = this.deps;
    const readTimeoutMs = this.deps.readTimeoutMs ?? DEFAULT_READ_TIMEOUT_MS;
    const persistTimeoutMs = this.deps.persistTimeoutMs ?? DEFAULT_PERSIST_TIMEOUT_MS;

    // Phase 1 — resolve inputs, each read time-boxed so a hung control-plane
    // call can't stall the run. This runs BEFORE the lifecycle flips, so ANY
    // failure here leaves the nanite Pending (safe to retry) — we surface the
    // reason rather than hanging.
    let template: NaniteTemplate | null;
    let workstream: Workstream | undefined;
    let topic: Topic | undefined;
    let workstreamTopics: Topic[];
    try {
      template = await withTimeout(
        loadTemplate(client, nanite.templateId),
        readTimeoutMs,
        'load template',
      );
      [workstream] = await withTimeout(
        client.wsRead({ slug: nanite.workstream }),
        readTimeoutMs,
        'read workstream',
      );
      const hasTopic = nanite.inputTopic.trim() !== '';
      // With an input topic, load it; workstream-wide (no topic) → load the
      // topic index so the model knows what's there and can tool-call for it.
      topic = hasTopic
        ? (
            await withTimeout(
              client.topicRead({ slug: nanite.inputTopic }),
              readTimeoutMs,
              'read input topic',
            )
          )[0]
        : undefined;
      workstreamTopics = hasTopic
        ? []
        : await withTimeout(
            client.topicRead({ workstream: nanite.workstream }),
            readTimeoutMs,
            'read workstream topics',
          );
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return failedResult(`could not resolve nanite inputs: ${message}`);
    }

    const prompt = buildRunPrompt({
      workstream,
      topic,
      workstreamTopics,
      request: nanite.request,
      template,
      now: this.deps.now?.() ?? new Date(),
    });
    // The verbatim request the model receives = system instructions + the
    // composed context prompt. Persist it so the run is auditable end-to-end.
    const baseInstructions = template?.instructions ?? '';
    const seededInstructions = [baseInstructions, SELF_REPORT_DIRECTIVE]
      .filter((s) => s.trim())
      .join('\n\n');
    const fullRequest = seededInstructions
      ? `${seededInstructions}\n\n---\n\n${prompt}`
      : prompt;

    // Phase 2 — flip to Running (time-boxed). If this write fails the nanite is
    // still Pending, so a retry is safe; don't proceed to the model call.
    try {
      await withTimeout(
        client.naniteRun({ id: nanite.id, begin: true }),
        persistTimeoutMs,
        'persist Running',
      );
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return failedResult(`could not start nanite: ${message}`);
    }

    // Phase 3 — execute. Once Running, ANY outcome (success, failure, hung
    // model call, or a hung terminal write) MUST land a terminal phase, or the
    // nanite strands in Running forever. Race the pure run against a wall-clock
    // timeout (which also cancels the loop), then persist the outcome.
    const timeoutMs = this.deps.timeoutMs ?? DEFAULT_RUN_TIMEOUT_MS;
    const cancel: RunnerToken & { isCancellationRequested: boolean } = {
      isCancellationRequested: this.deps.token?.isCancellationRequested ?? false,
    };
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const result = await new Promise<NaniteRunResult>((resolve, reject) => {
        timer = setTimeout(() => {
          cancel.isCancellationRequested = true;
          reject(
            new Error(`nanite run timed out after ${Math.round(timeoutMs / 1000)}s`),
          );
        }, timeoutMs);
        runNanite(bridge, {
          instructions: seededInstructions,
          prompt,
          allowlist: template?.toolAllowlist ?? [],
          denylist: template?.toolDenylist ?? [],
          acceptanceCriteria: template?.acceptanceCriteria ?? '',
          acceptanceThreshold: template?.acceptanceThreshold ?? 60,
          model: modelFromSettings(template?.executionSettings),
          maxIterations: this.deps.maxIterations,
          token: cancel,
        }).then(resolve, reject);
      });

      // Persist the terminal phase + result (Running → Succeeded | Failed).
      // Time-boxed so a hung write can't leave the nanite stuck in Running.
      try {
        await withTimeout(
          client.naniteRun({
            id: nanite.id,
            outcome: result.status,
            error: result.error,
            prompt: fullRequest,
            output: result.output,
            acceptance: result.acceptance ?? null,
            toolCalls: result.toolCalls,
            steps: result.steps,
            missingTools: result.missingTools ?? [],
            tokens: result.tokens ?? null,
          }),
          persistTimeoutMs,
          'persist result',
        );
      } catch (persistErr) {
        const message = persistErr instanceof Error ? persistErr.message : String(persistErr);
        return failedResult(`nanite finished but its result could not be saved: ${message}`);
      }
      return result;
    } catch (err) {
      // Timeout or an unexpected throw: force the nanite to Failed so it is
      // never stranded in Running. Best-effort, time-boxed persist.
      const message = err instanceof Error ? err.message : String(err);
      try {
        await withTimeout(
          client.naniteRun({ id: nanite.id, outcome: 'failed', error: message, prompt: fullRequest }),
          persistTimeoutMs,
          'persist failure',
        );
      } catch {
        // ignore — the run already failed; surfacing the original error matters most.
      }
      return failedResult(message);
    } finally {
      if (timer) {
        clearTimeout(timer);
      }
    }
  }
}
