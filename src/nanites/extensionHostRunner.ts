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
  Config,
  Nanite,
  NaniteJournal,
  NaniteJournalCreateInput,
  NaniteRunInput,
  NaniteTemplate,
  Topic,
  WriteDocumentResult,
  Workstream,
} from '../controlPlaneClient';
import type { CommandJournalSpec } from '../commandJournal';
import { buildNaniteCompletionSpecs } from './completionMessage';
import { redactRunResult, redactSecrets } from './redact';
import { runNanite } from './runner';
import type {
  NaniteContainer,
  NaniteContainerIdentity,
  NaniteLmBridge,
  NaniteRunResult,
  NaniteRunner,
  RunnerToken,
} from './types';
import { RUN_COMMAND_TOOL } from '../tools/NaniteDevContainer';

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
  /**
   * Append the run's immutable {@link NaniteJournal} record (create-only). The
   * runner writes the run RESULT here, then stamps only a light
   * `latestJournalId` pointer on the nanite via {@link naniteRun}. Optional so
   * lightweight test fakes can omit it — absent ⇒ no journal is written and the
   * finishing call carries no pointer (the run result still never lands on the
   * nanite spec). The real `ControlPlaneClient` provides it.
   */
  naniteJournalCreate?(input: NaniteJournalCreateInput): Promise<NaniteJournal>;
  /**
   * Read a configmap by slug or id (for env injection). Optional so lightweight
   * test fakes can omit it — absent ⇒ the nanite's `configs` resolve to an empty
   * env. The real `ControlPlaneClient` provides it.
   */
  configRead?(input: { slug?: string; id?: string }): Promise<Config[]>;
  /**
   * Post a turn to the command-widget chat (the `CommandJournal` kind). Optional
   * so lightweight test fakes can omit it — absent ⇒ the completion turn is
   * simply skipped. In production the real `ControlPlaneClient` provides it.
   */
  commandJournalCreate?(spec: CommandJournalSpec): Promise<WriteDocumentResult>;
}

export interface ExtensionHostRunnerDeps {
  client: NaniteRunnerClient;
  bridge: NaniteLmBridge;
  /**
   * Factory for the run's execution container, invoked ONLY when the template
   * grants the `run_command` tool. Injected so tests (and hosts without Docker)
   * can opt out entirely — absent ⇒ no container is ever provisioned. In
   * production this builds a {@link DevContainer} rooted in global storage. The
   * `env` argument is the nanite's merged configmap data, injected into the
   * container as `--remote-env` variables.
   */
  containerFactory?: (nanite: Nanite, env: Record<string, string>) => NaniteContainer;
  /**
   * The GitHub token injected into the run's container (from SecretStorage), if
   * any. Used ONLY to redact the token value from the persisted run record —
   * the runner never transports it; the container factory owns injection. Absent
   * ⇒ redaction still scrubs the `GH_TOKEN=…` / `x-access-token@` patterns.
   */
  githubToken?: string | null;
  /**
   * Safety cap on model turns (forwarded to the core). When set, OVERRIDES the
   * per-run cap resolved from the template's `executionSettings` /
   * {@link resolveRunLimits} defaults. Nanites leave this unset.
   */
  maxIterations?: number;
  /**
   * Wall-clock cap for a run before it's forced to Failed. When set, OVERRIDES
   * the per-run timeout resolved from the template's `executionSettings` /
   * {@link resolveRunLimits} defaults. Nanites leave this unset.
   */
  timeoutMs?: number;
  /** Cap for each control-plane READ during input resolution. Default 20s. */
  readTimeoutMs?: number;
  /** Cap for each control-plane WRITE (lifecycle persist). Default 15s. */
  persistTimeoutMs?: number;
  /**
   * Whether the runner posts its own completion turn to the command-widget
   * chat (the `nanite-completion-message-to-chat` write-back). Defaults to
   * `true` — the dispatcher path relies on it to land the result on the input
   * topic / workstream. The chat-directed AGENT path sets this `false` because
   * the command widget owns journaling under the agent's own scope, so the
   * runner must not also post (which would land on the wrong scope).
   */
  postCompletion?: boolean;
  /** Clock for the run prompt's Context section (injectable for tests). */
  now?: () => Date;
  /**
   * Sink for non-fatal warnings (e.g. a referenced configmap that couldn't be
   * read). Injectable so tests can capture it; defaults to `console.warn`.
   */
  log?: (message: string) => void;
  token?: RunnerToken;
}

/** Default wall-clock cap so a hung model call can't strand a nanite in Running. */
const DEFAULT_RUN_TIMEOUT_MS = 120_000;
/** Default cap on each input-resolution read so a hung daemon can't stall a run. */
const DEFAULT_READ_TIMEOUT_MS = 20_000;
/** Default cap on each lifecycle persist so a hung write can't strand a nanite. */
const DEFAULT_PERSIST_TIMEOUT_MS = 15_000;
/** Cap on the best-effort completion-turn post so a hung chat write can't block. */
const COMPLETION_POST_TIMEOUT_MS = 10_000;

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

/**
 * Wrap a document-sourced block in ignorable `// START BLOCK … // END BLOCK`
 * markers so the journal Prompt view can render a compact link-out to its
 * source instead of repeating the inlined text. `route` is a working-memory
 * route (`/document/<id>.working-memory` or `/topic/<slug>.working-memory`);
 * `field` names the source field (e.g. `instructions`, `body`) and `version`
 * is the source document's `resourceVersion` at assembly time. A null route (no
 * stable identifier) returns the raw content UNWRAPPED so the prompt stays
 * valid. The marker lines are kept terse + stable so a simple regex parses them.
 */
export function wrapSourcedBlock(
  route: string | null,
  field: string,
  version: number | undefined,
  content: string,
): string {
  if (!route) {
    return content;
  }
  return `// START BLOCK ${route}#${field}?v${version ?? 0}\n${content}\n// END BLOCK`;
}

/** working-memory route for a topic block: by slug, else by id, else null. */
function topicBlockRoute(topic: Topic): string | null {
  if (topic.slug && topic.slug.trim()) {
    return `/topic/${topic.slug}.working-memory`;
  }
  if (topic.id && topic.id.trim()) {
    return `/document/${topic.id}.working-memory`;
  }
  return null;
}

/**
 * Build a document-sourced prompt SECTION: a human `header` line kept OUTSIDE
 * the block (readable, not repeated by the link-out), followed by the
 * `content` wrapped in a {@link wrapSourcedBlock} marker so the journal Prompt
 * view can link out to its source. Empty content ⇒ just the header (no empty
 * block); a null route (no stable identifier) ⇒ header + raw unwrapped content.
 * This is the single funnel every wrapped section (currently the input topic)
 * routes through, alongside the raw marker emitter
 * {@link wrapSourcedBlock} the instructions seed uses directly.
 */
export function sourcedSection(
  header: string,
  route: string | null,
  field: string,
  version: number | undefined,
  content: string,
): string {
  const trimmed = (content ?? '').trim();
  if (!trimmed) {
    return header;
  }
  const block = wrapSourcedBlock(route, field, version, trimmed);
  return `${header}\n\n${block}`;
}

/**
 * Build the run's system instructions: the template's `instructions` wrapped in
 * a document-sourced block (so the journal view links out to the template
 * instead of repeating them inline), followed by the UNWRAPPED
 * {@link SELF_REPORT_DIRECTIVE} — which is NOT document-sourced. An absent /
 * empty template, or a template with no id, yields valid output (the directive
 * alone, or the raw instructions unwrapped).
 */
export function seedInstructions(template: NaniteTemplate | null): string {
  const raw = (template?.instructions ?? '').trim();
  const wrapped = raw
    ? wrapSourcedBlock(
        template?.id ? `/document/${template.id}.working-memory` : null,
        'instructions',
        template?.resourceVersion,
        raw,
      )
    : '';
  return [wrapped, SELF_REPORT_DIRECTIVE].filter((s) => s.trim()).join('\n\n');
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
 * Assemble the run prompt handed to the model: the ambient **context**, the
 * **input topic** (title + body) for a topic-scoped run — or, for a
 * workstream-wide Nanite with no single topic, a terse pointer telling the
 * model to discover topics via the `ws-workstream-read` / `ws-topic-read`
 * tools — and the **task** (the nanite's request, or the template's trigger
 * phrase). The template `instructions` are the system prompt (folded into the
 * seed by the bridge) and are NOT repeated here.
 */
export function buildRunPrompt(ctx: {
  workstream: Workstream | undefined;
  topic: Topic | undefined;
  request: string;
  template: NaniteTemplate | null;
  now: Date;
}): string {
  // Ambient context every run gets for free (no tool call needed). Starts with
  // the current time so a nanite can reason about "due today" etc. Extend later.
  // The Context + Task sections are NOT document-sourced, so they are left
  // unwrapped (no block markers).
  const parts: string[] = [
    `# Context\nCurrent time: ${ctx.now.toISOString()} (local: ${ctx.now.toString()})`,
  ];
  if (ctx.topic) {
    // Keep the human title line readable/outside the block; wrap only the
    // document-sourced body so the journal view can link out to the topic.
    const header = `# Input topic\n${ctx.topic.title} (${ctx.topic.slug ?? '—'})`;
    parts.push(
      sourcedSection(header, topicBlockRoute(ctx.topic), 'body', ctx.topic.resourceVersion, ctx.topic.body ?? ''),
    );
  } else {
    // Workstream-wide run: no single input topic and no inline topic data.
    // Point the model at the tools so it discovers and reads what it needs.
    parts.push(
      `# Input topics\nThis Nanite runs workstream-wide (no single input topic). Use the ` +
        `ws-workstream-read and ws-topic-read tools to discover and read the topics in this workstream.`,
    );
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

/** Sane bounds for the per-run round cap (`executionSettings.maxIterations`). */
const MIN_ITERATIONS = 1;
const MAX_ITERATIONS = 200;
/** Sane bounds (seconds) for the per-run wall-clock (`executionSettings.runTimeoutSeconds`). */
const MIN_RUN_TIMEOUT_SECONDS = 30;
const MAX_RUN_TIMEOUT_SECONDS = 3600;

/** Roomier defaults for a container-backed (coding) run — see {@link resolveRunLimits}. */
const CONTAINER_DEFAULT_ITERATIONS = 40;
const CONTAINER_DEFAULT_TIMEOUT_MS = 900_000; // 15 min
/** Defaults for a tool-only run (unchanged from the historical hardcoded caps). */
const TOOL_DEFAULT_ITERATIONS = 12;
const TOOL_DEFAULT_TIMEOUT_MS = DEFAULT_RUN_TIMEOUT_MS; // 120s

/**
 * Read a finite number from `executionSettings[key]` defensively — absent,
 * non-number, `NaN`, or `±Infinity` all yield null (mirrors
 * {@link modelFromSettings}). Range validation is the caller's job (clamp).
 */
function numberFromSettings(
  settings: Record<string, unknown> | undefined,
  key: string,
): number | null {
  const value = settings?.[key];
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

/** Clamp `value` into the inclusive `[min, max]` range, rounded to an integer. */
function clampInt(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, Math.round(value)));
}

/** The resolved per-run caps: model turns and wall-clock (ms). */
export interface ResolvedRunLimits {
  maxIterations: number;
  timeoutMs: number;
}

/**
 * Whether the template opts this run into the per-run `run_command` tool — the
 * gate for provisioning a dev container. A container is expensive (and needs
 * Docker), so it is spun up ONLY when the template's allow-list actually grants
 * `run_command` (explicitly or via `*`) and the deny-list doesn't block it.
 */
function templateGrantsRunCommand(template: NaniteTemplate | null): boolean {
  const allow = template?.toolAllowlist ?? [];
  const deny = template?.toolDenylist ?? [];
  if (deny.includes(RUN_COMMAND_TOOL)) {
    return false;
  }
  return allow.includes(RUN_COMMAND_TOOL) || allow.includes('*');
}

/**
 * Resolve the run's round cap + wall-clock from the template's
 * `executionSettings`, falling back to defaults keyed on run TYPE:
 * container-backed runs (template grants `run_command`) get roomier defaults
 * (40 rounds / 15 min) than tool-only runs (12 rounds / 120s), because a coding
 * run provisions a container and does real work. An explicit
 * `executionSettings.maxIterations` / `runTimeoutSeconds` OVERRIDES the default
 * and is clamped to sane bounds; absent / non-number / foreign values fall
 * through to the type default.
 */
export function resolveRunLimits(template: NaniteTemplate | null): ResolvedRunLimits {
  const container = templateGrantsRunCommand(template);
  const defaultIterations = container ? CONTAINER_DEFAULT_ITERATIONS : TOOL_DEFAULT_ITERATIONS;
  const defaultTimeoutMs = container ? CONTAINER_DEFAULT_TIMEOUT_MS : TOOL_DEFAULT_TIMEOUT_MS;

  const settings = template?.executionSettings;
  const rawIterations = numberFromSettings(settings, 'maxIterations');
  const rawTimeoutSeconds = numberFromSettings(settings, 'runTimeoutSeconds');

  return {
    maxIterations:
      rawIterations !== null
        ? clampInt(rawIterations, MIN_ITERATIONS, MAX_ITERATIONS)
        : defaultIterations,
    timeoutMs:
      rawTimeoutSeconds !== null
        ? clampInt(rawTimeoutSeconds, MIN_RUN_TIMEOUT_SECONDS, MAX_RUN_TIMEOUT_SECONDS) * 1000
        : defaultTimeoutMs,
  };
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

/**
 * Resolve a nanite's `configs` (configmap slugs/ids) into ONE merged env map.
 * Each configmap's `data` is overlaid in order, so a LATER config wins on a key
 * collision. Best-effort: a config that is missing or fails to read is skipped
 * with a logged warning (never a hard failure), and a client without
 * `configRead` yields an empty map. Each read is time-boxed.
 */
async function resolveConfigEnv(
  client: NaniteRunnerClient,
  configs: string[],
  readTimeoutMs: number,
  log: (message: string) => void,
): Promise<Record<string, string>> {
  const merged: Record<string, string> = {};
  if (!client.configRead || configs.length === 0) {
    return merged;
  }
  for (const ref of configs) {
    try {
      const bySlug = await withTimeout(
        client.configRead({ slug: ref }),
        readTimeoutMs,
        `read config ${ref}`,
      );
      const found =
        bySlug[0] ??
        (await withTimeout(client.configRead({ id: ref }), readTimeoutMs, `read config ${ref}`))[0];
      if (!found) {
        log(`nanite config "${ref}" not found — skipping its env injection`);
        continue;
      }
      Object.assign(merged, found.data);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      log(`nanite config "${ref}" could not be read — skipping: ${message}`);
    }
  }
  return merged;
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
      // With an input topic, load it; workstream-wide (no topic) → the prompt
      // points the model at the ws-topic-read tool to discover topics itself.
      topic = hasTopic
        ? (
            await withTimeout(
              client.topicRead({ slug: nanite.inputTopic }),
              readTimeoutMs,
              'read input topic',
            )
          )[0]
        : undefined;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return failedResult(`could not resolve nanite inputs: ${message}`);
    }

    const prompt = buildRunPrompt({
      workstream,
      topic,
      request: nanite.request,
      template,
      now: this.deps.now?.() ?? new Date(),
    });
    // The verbatim request the model receives = system instructions + the
    // composed context prompt. Persist it so the run is auditable end-to-end.
    // The template instructions are wrapped in document-sourced block markers
    // (the self-report directive is not — see seedInstructions).
    const seededInstructions = seedInstructions(template);
    const fullRequest = seededInstructions
      ? `${seededInstructions}\n\n---\n\n${prompt}`
      : prompt;

    // Resolve the nanite's referenced configmaps into one merged env map (later
    // configs win). Best-effort — a missing/unreadable config is skipped with a
    // warning. These VALUES are injected into the container AND scrubbed from
    // the persisted run record alongside the GitHub token. Only worth the reads
    // when the nanite actually references configs.
    const log = this.deps.log ?? ((m: string) => console.warn(m));
    const configEnv =
      nanite.configs.length > 0
        ? await resolveConfigEnv(client, nanite.configs, readTimeoutMs, log)
        : {};
    // The secret set fed to every redaction pass: the GitHub token (value +
    // patterns) plus every injected config value (keys stay visible).
    const secrets = { token: this.deps.githubToken, config: configEnv };

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
    //
    // Resolve the per-run caps from the template's executionSettings (roomier
    // defaults for container-backed coding runs). Explicit deps override the
    // resolved values so tests / hosts can still force a cap.
    const limits = resolveRunLimits(template);
    const maxIterations = this.deps.maxIterations ?? limits.maxIterations;
    const timeoutMs = this.deps.timeoutMs ?? limits.timeoutMs;
    const cancel: RunnerToken & { isCancellationRequested: boolean } = {
      isCancellationRequested: this.deps.token?.isCancellationRequested ?? false,
    };
    let timer: ReturnType<typeof setTimeout> | undefined;
    // The run's dev container, provisioned lazily inside the timed section (only
    // when the template grants `run_command`). Deliberately NOT torn down when
    // the run ends — the container persists so a served app stays reachable via
    // its OrbStack link. Cleanup is manual (`DevContainer.down()` on demand).
    let container: NaniteContainer | undefined;
    try {
      const result = await new Promise<NaniteRunResult>((resolve, reject) => {
        timer = setTimeout(() => {
          cancel.isCancellationRequested = true;
          reject(
            new Error(`nanite run timed out after ${Math.round(timeoutMs / 1000)}s`),
          );
        }, timeoutMs);
        void (async () => {
          // Bring the container up BEFORE the model loop, time-boxed by the same
          // cancellation token. Gated so ordinary nanites (no `run_command`)
          // never pay the Docker cost.
          let containerIdentity: NaniteContainerIdentity | undefined;
          if (this.deps.containerFactory && templateGrantsRunCommand(template)) {
            container = this.deps.containerFactory(nanite, configEnv);
            await container.up(cancel);
            // Capture the container's identity ONCE (a single cached name lookup,
            // never a per-step round-trip) so container-backed tool steps can
            // record WHICH container ran them. Best-effort — the run proceeds
            // even if identity can't be resolved.
            containerIdentity = await container.describe?.({ token: cancel });
          }
          return runNanite(bridge, {
            instructions: seededInstructions,
            prompt,
            allowlist: template?.toolAllowlist ?? [],
            denylist: template?.toolDenylist ?? [],
            acceptanceCriteria: template?.acceptanceCriteria ?? '',
            acceptanceThreshold: template?.acceptanceThreshold ?? 60,
            model: modelFromSettings(template?.executionSettings),
            container,
            containerIdentity,
            maxIterations,
            token: cancel,
          });
        })().then(resolve, reject);
      });

      // Redact any injected GitHub token AND every injected config value from
      // every persisted free-text field BEFORE it touches the run record or the
      // completion chat — no secret may appear in `prompt` / `output` / `steps`
      // or the brief.
      const safeResult = redactRunResult(result, secrets);
      const safePrompt = redactSecrets(fullRequest, secrets);

      // Append the run's immutable NaniteJournal record FIRST (best-effort +
      // time-boxed), then stamp only its id on the nanite as `latestJournalId`.
      // The run RESULT lives in the journal, never on the nanite spec.
      const journalId = await this.writeJournal(nanite, safeResult, safePrompt);
      safeResult.journalId = journalId;

      // Persist the terminal phase + the light journal pointer (Running →
      // Succeeded | Failed). Time-boxed so a hung write can't leave the nanite
      // stuck in Running.
      try {
        await withTimeout(
          client.naniteRun({
            id: nanite.id,
            outcome: safeResult.status,
            error: safeResult.error,
            ...(journalId !== undefined ? { latestJournalId: journalId } : {}),
          }),
          persistTimeoutMs,
          'persist result',
        );
      } catch (persistErr) {
        const message = persistErr instanceof Error ? persistErr.message : String(persistErr);
        return failedResult(`nanite finished but its result could not be saved: ${message}`);
      }
      // Best-effort: mirror the outcome into the command-widget chat, scoped to
      // the nanite's input topic (or workstream). Fully isolated — the run has
      // already persisted, so a failure here must never alter its outcome.
      // Suppressed on the chat-directed agent path (the widget journals under
      // the agent's own scope instead).
      if (this.deps.postCompletion !== false) {
        await this.postCompletionTurn(nanite, template, safeResult);
      }
      return safeResult;
    } catch (err) {
      // Timeout or an unexpected throw: force the nanite to Failed so it is
      // never stranded in Running. Best-effort, time-boxed persist. The failure
      // message can carry `devcontainer up` stderr (which echoes `--remote-env`
      // GH_TOKEN=… and any config value), so redact it — and the prompt —
      // before persisting.
      const message = redactSecrets(
        err instanceof Error ? err.message : String(err),
        secrets,
      );
      // Append a minimal failed journal (best-effort) so the run is auditable,
      // then stamp its pointer alongside the terminal Failed phase.
      const failResult: NaniteRunResult = { ...failedResult(message), error: message };
      const journalId = await this.writeJournal(
        nanite,
        failResult,
        redactSecrets(fullRequest, secrets),
      );
      try {
        await withTimeout(
          client.naniteRun({
            id: nanite.id,
            outcome: 'failed',
            error: message,
            ...(journalId !== undefined ? { latestJournalId: journalId } : {}),
          }),
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
      // The container is intentionally left running after the run (success or
      // failure) so a served app stays reachable via its OrbStack link.
      // Teardown is a manual, out-of-band action — see `DevContainer.down()`.
    }
  }

  /**
   * Append the run's immutable {@link NaniteJournal} record from the REDACTED
   * result + prompt, mapped into the kind's four sections (`status`, `prompt`,
   * `execution`, `results`). Best-effort and time-boxed: returns the new
   * journal's id, or `undefined` when the client can't journal (no
   * `naniteJournalCreate`) or the write fails — the caller then finishes the
   * nanite without a pointer rather than stranding it in Running.
   */
  private async writeJournal(
    nanite: Nanite,
    safeResult: NaniteRunResult,
    safePrompt: string,
  ): Promise<string | undefined> {
    const create = this.deps.client.naniteJournalCreate?.bind(this.deps.client);
    if (!create) {
      return undefined;
    }
    const persistTimeoutMs = this.deps.persistTimeoutMs ?? DEFAULT_PERSIST_TIMEOUT_MS;
    const endedAt = Math.floor((this.deps.now?.() ?? new Date()).getTime() / 1000);
    const input: NaniteJournalCreateInput = {
      naniteId: nanite.id,
      workstream: nanite.workstream,
      inputTopic: nanite.inputTopic,
      status: {
        phase: safeResult.status === 'failed' ? 'Failed' : 'Succeeded',
        outcome: safeResult.status,
        queuedAt: nanite.queuedAt,
        startedAt: nanite.startedAt,
        endedAt,
      },
      prompt: { request: safePrompt },
      execution: { steps: safeResult.steps, error: safeResult.error ?? '' },
      results: {
        summary: safeResult.output,
        acceptance: safeResult.acceptance ?? null,
        tokens: safeResult.tokens ?? null,
        missingTools: safeResult.missingTools ?? [],
      },
    };
    try {
      const journal = await withTimeout(create(input), persistTimeoutMs, 'write journal');
      return journal.id;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      (this.deps.log ?? ((m: string) => console.warn(m)))(
        `nanite journal write failed (ignored): ${message}`,
      );
      return undefined;
    }
  }

  /**
   * Post the run's outcome to the command-widget chat as `CommandJournal`
   * turns. ALWAYS journals under the nanite's OWN session (scope = its id,
   * `contextKind: 'nanite'`) so the run's request + summary show up in the
   * nanite's chat — the channel the widget renders for a focused nanite — and
   * ADDITIONALLY under the run's input topic (or workstream) so the ticket
   * carries the outcome too. Best-effort and fully isolated: swallows every
   * error and is time-boxed per post, because the run has already persisted its
   * terminal phase — a chat-post failure must never fail or alter the outcome.
   */
  private async postCompletionTurn(
    nanite: Nanite,
    template: NaniteTemplate | null,
    result: NaniteRunResult,
  ): Promise<void> {
    try {
      const create = this.deps.client.commandJournalCreate?.bind(this.deps.client);
      if (!create) {
        return;
      }
      const specs = buildNaniteCompletionSpecs({
        nanite,
        result,
        templateLabel: template?.title ?? template?.slug ?? null,
      });
      for (const spec of specs) {
        // Each post is independently best-effort — one failing scope must not
        // skip the others (the nanite-session turn is the mandatory one).
        try {
          await withTimeout(create(spec), COMPLETION_POST_TIMEOUT_MS, 'post completion turn');
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          console.warn(`nanite completion chat post failed (ignored): ${message}`);
        }
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.warn(`nanite completion chat post failed (ignored): ${message}`);
    }
  }
}
