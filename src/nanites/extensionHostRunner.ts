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
  topicRead(input: { slug?: string }): Promise<Topic[]>;
  naniteRun(input: NaniteRunInput): Promise<Nanite>;
}

export interface ExtensionHostRunnerDeps {
  client: NaniteRunnerClient;
  bridge: NaniteLmBridge;
  /** Safety cap on model turns (forwarded to the core). */
  maxIterations?: number;
  token?: RunnerToken;
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

    // Resolve inputs BEFORE flipping the lifecycle, so a bad read leaves the
    // nanite Pending rather than stranded in Running.
    const template = await loadTemplate(client, nanite.templateId);
    const [topic] = await client.topicRead({ slug: nanite.inputTopic });
    const prompt = (topic?.body || nanite.request || template?.triggerPhrase || '').trim();

    // Persist the visible Running transition (Pending → Running).
    await client.naniteRun({ id: nanite.id });

    const result = await runNanite(bridge, {
      instructions: template?.instructions ?? '',
      prompt,
      allowlist: template?.toolAllowlist ?? [],
      acceptanceCriteria: template?.acceptanceCriteria ?? '',
      acceptanceThreshold: template?.acceptanceThreshold ?? 60,
      model: modelFromSettings(template?.executionSettings),
      maxIterations: this.deps.maxIterations,
      token: this.deps.token,
    });

    // Persist the terminal phase + result (Running → Succeeded | Failed).
    await client.naniteRun({
      id: nanite.id,
      outcome: result.status,
      error: result.error,
      output: result.output,
      acceptance: result.acceptance ?? null,
      toolCalls: result.toolCalls,
      tokens: result.tokens ?? null,
    });

    return result;
  }
}
