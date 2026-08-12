import * as vscode from 'vscode';
import { randomBytes } from 'node:crypto';
import type { ControlPlaneClient } from '../controlPlaneClient';
import { LlamaClient } from '../llamaClient';
import { runToolLoop } from '../wmToolLoop';
import { buildBrief, createControlPlaneToolExecutor } from '../wmToolExecutor';
import { projectCatalog, type ProjectedCatalog } from '../wmToolProjection';
import { DocumentEditorProvider } from './documentEditorProvider';
import {
  buildInitialJournalSpec,
  buildJournalSpec,
  journalsToHistory,
  journalsToTurns,
  scopeKeyFor,
  type CommandJournalSpec,
} from '../commandJournal';
import { buildNaniteCompletionBrief } from '../nanites/completionMessage';
import type { NaniteRunResult } from '../nanites/types';
import type { PriorTurn } from '../wmToolLoop';

/**
 * Max prior turns replayed into a new model call (context carryover baseline A —
 * full replay). Generous for the POC; bounded so a long chat can't hang the
 * local model on an unbounded context window.
 */
const HISTORY_TURN_CAP = 20;

/**
 * The right-rail command widget (WM 14.2.1 "poc-right-rail-command-widget").
 *
 * A `WebviewViewProvider` — the POC intent is to live in the SECONDARY side bar
 * (right rail), replacing Copilot Chat for driving Working Memory. The user
 * types a command; on submit we run a bounded agentic tool-calling loop against
 * the LOCAL Llama server (direct HTTP, `src/llamaClient.ts`) exposing the WM
 * `ws-*` CRUD operations as tools, execute each through the control-plane client
 * (never SQLite), and render a markdown brief of what was done.
 *
 * Reuses the WM 14.2 Svelte webview bundle: the SAME `media/webview-ui/main.js`
 * boots either the document editor or this widget, branching on the injected
 * `window.__WM_VIEW__` global (see `webview-ui/src/main.ts`).
 */

/** Sticky-context target mirrored from the panel-reveal signal. */
export interface WidgetContext {
  slug: string;
  kind: string;
}
type WidgetInbound =
  | { type: 'ready' }
  | { type: 'submitCommand'; command: string; contextSlug: string | null }
  | { type: 'openJournal'; id: string };

/**
 * Runs a long-lived AGENT (nanite) once with a chat directive as its request,
 * resolving to the run result so the widget can journal the exchange under the
 * agent's own scope. Injected by `extension.ts` (the runner lives in the
 * extension host). See `nanites-as-longlived-chattable-agents`.
 */
export type DirectAgentFn = (naniteId: string, directive: string) => Promise<NaniteRunResult>;

export class CommandWidgetProvider implements vscode.WebviewViewProvider {
  public static readonly viewType = 'workingMemory.commandWidget';

  private view: vscode.WebviewView | undefined;
  private context: WidgetContext | null = null;
  /** Per-turn trace log for the tool-calling loop (parallel-vs-repeat diagnostics). */
  private readonly output: vscode.OutputChannel;
  /**
   * The projected tool catalog derived from the control-plane's canonical MCP
   * registry, fetched once and cached for the session (WM 14.2.1
   * "derive-local-tools-from-canonical-registry"). Null until the first
   * successful fetch; a fetch failure leaves it null so the next command retries.
   */
  private catalog: ProjectedCatalog | null = null;

  constructor(
    private readonly extensionUri: vscode.Uri,
    private readonly getClient: () => ControlPlaneClient | null,
    /**
     * Runs a nanite agent with a chat directive (the AGENT path). Optional so
     * tests can omit it — absent ⇒ an agent-scoped message reports that agent
     * direction isn't wired.
     */
    private readonly directAgent?: DirectAgentFn,
  ) {
    this.output = vscode.window.createOutputChannel('Working Memory Command');
  }

  resolveWebviewView(webviewView: vscode.WebviewView): void {
    this.view = webviewView;
    webviewView.webview.options = {
      enableScripts: true,
      localResourceRoots: [vscode.Uri.joinPath(this.extensionUri, 'media')],
    };
    // Wire the listener BEFORE assigning html (setting html boots the script,
    // which posts `ready` immediately — mirrors the panel provider).
    webviewView.webview.onDidReceiveMessage((msg: WidgetInbound) => {
      void this.handleMessage(msg);
    });
    webviewView.webview.html = this.renderHtml(webviewView.webview);
    webviewView.onDidDispose(() => {
      if (this.view === webviewView) {
        this.view = undefined;
      }
    });
    // Replay this scope's journal once the webview boots (it posts `ready`).
  }

  /**
   * Load the current scope's journal and push it to the webview as a `hydrate`
   * message so the transcript reflects the persisted chat. Called on `ready` and
   * whenever {@link setContext} swaps the scope. Best-effort: a null client or a
   * read failure posts an empty hydrate rather than throwing.
   */
  private async loadHistory(): Promise<void> {
    const scopeKey = scopeKeyFor(this.context?.slug ?? null);
    const client = this.getClient();
    if (!client) {
      this.view?.webview.postMessage({ type: 'hydrate', turns: [] });
      return;
    }
    try {
      const docs = await client.commandJournalReadByWorkstream(scopeKey);
      this.view?.webview.postMessage({ type: 'hydrate', turns: journalsToTurns(docs) });
    } catch (err) {
      this.output.appendLine(
        `  hydrate failed: ${err instanceof Error ? err.message : String(err)}`,
      );
      this.view?.webview.postMessage({ type: 'hydrate', turns: [] });
    }
  }

  /**
   * Update the sticky context (the currently/last-selected WM doc) and push it
   * to the widget. Called from the extension's active-tab watcher, so the
   * widget's default scope follows the selected topic/workstream.
   */
  setContext(context: WidgetContext | null): void {
    // A command scope is a topic, a workstream, or a long-lived AGENT (nanite);
    // ignore anything else (e.g. topic-type / alert).
    if (
      context &&
      context.kind !== 'topic' &&
      context.kind !== 'workstream' &&
      context.kind !== 'nanite'
    ) {
      return;
    }
    const prevScope = scopeKeyFor(this.context?.slug ?? null);
    this.context = context;
    this.postContext();
    // Swapping the scope swaps the transcript — replay the new scope's journal.
    if (scopeKeyFor(this.context?.slug ?? null) !== prevScope) {
      void this.loadHistory();
    }
  }

  private postContext(): void {
    this.view?.webview.postMessage({
      type: 'context',
      slug: this.context?.slug ?? null,
      kind: this.context?.kind ?? null,
    });
  }

  private async handleMessage(msg: WidgetInbound): Promise<void> {
    if (msg.type === 'ready') {
      this.postContext();
      void this.loadHistory();
      return;
    }
    if (msg.type === 'submitCommand') {
      await this.runCommand(msg.command, msg.contextSlug);
      return;
    }
    if (msg.type === 'openJournal') {
      this.openJournalRecord(msg.id);
    }
  }

  /**
   * Open a CommandJournal record in working-memory's generic document view via
   * the same `openWith` route the rail uses for nanites / generic docs
   * (`working-memory:/document/<id>.working-memory` → the unified editor). No-op
   * on an empty id.
   */
  private openJournalRecord(id: string): void {
    if (typeof id !== 'string' || id.length === 0) {
      return;
    }
    void vscode.commands.executeCommand(
      'vscode.openWith',
      DocumentEditorProvider.uriFor('document', id),
      DocumentEditorProvider.viewType,
    );
  }

  private async runCommand(command: string, contextSlug: string | null): Promise<void> {
    const trimmed = command.trim();
    if (trimmed.length === 0) {
      return;
    }
    const client = this.getClient();
    if (!client) {
      this.view?.webview.postMessage({
        type: 'briefError',
        message: 'The Working Memory control plane is not running, so no commands can be executed.',
      });
      return;
    }

    // AGENT path: when the scope is a long-lived agent (nanite), a message is a
    // DIRECTIVE — run the agent (extension-host runner) rather than the local
    // WM tool-calling loop, and journal the exchange under the agent's scope.
    if (this.context?.kind === 'nanite') {
      await this.runAgentDirective(this.context.slug, trimmed, client);
      return;
    }

    const scopeKey = scopeKeyFor(contextSlug);
    const contextKind = this.context?.kind ?? null;

    this.view?.webview.postMessage({ type: 'briefRunning', scope: scopeKey });

    // Two-phase write, phase 1: journal the request as `running` BEFORE the
    // model call. Capturing {id, resourceVersion} lets us update-in-place when
    // the run finishes; persisting up front means a hard crash still leaves a
    // request-only `running` record instead of a zero-trace turn. The attach is
    // posted immediately so the pending bubble is right-click-openable at once
    // (this REPLACES the old end-of-run attach).
    const journal = await this.createInitialJournal(
      buildInitialJournalSpec({
        workstream: scopeKey,
        command: trimmed,
        contextSlug,
        contextKind,
      }),
      client,
    );
    if (journal) {
      this.view?.webview.postMessage({
        type: 'attachJournalId',
        id: journal.id,
        scope: scopeKey,
      });
    }

    const cfg = vscode.workspace.getConfiguration('workingMemory');
    const baseUrl = cfg.get<string>('localModel.baseUrl', 'http://localhost:11434');
    const model = cfg.get<string>('localModel.model', 'qwen3:14b');
    const maxIterations = cfg.get<number>('localModel.maxIterations', 8);
    const disableThinking = cfg.get<boolean>('localModel.disableThinking', true);

    const llama = new LlamaClient({ baseUrl, model, disableThinking });

    // Derive the local model's tool catalog from the control-plane's canonical
    // registry (single source of truth). Resolved BEFORE the first model call;
    // a failure (daemon down / fetch error) fails the run with a friendly brief
    // rather than throwing.
    const catalog = await this.ensureCatalog(client);
    if (!catalog) {
      const markdown =
        '⚠️ Could not load the Working Memory tool catalog from the control-plane ' +
        '(is the daemon running?). No command was executed.';
      this.view?.webview.postMessage({ type: 'brief', markdown, scope: scopeKey });
      await this.finalizeJournal(
        journal,
        buildJournalSpec({
          workstream: scopeKey,
          command: trimmed,
          contextSlug,
          contextKind,
          brief: markdown,
          toolCalls: [],
          corrections: [],
          stopReason: 'error',
          status: 'failed',
        }),
        client,
      );
      return;
    }
    const executor = createControlPlaneToolExecutor(client, catalog.localToCanonical);

    this.output.appendLine(
      `\n[${new Date().toISOString()}] command: ${JSON.stringify(trimmed)} ` +
        `(context: ${contextSlug ?? 'none'}, model: ${model})`,
    );

    // Whole-run wall clock (submit → brief ready). Sub-timings (model, journal
    // read/write) are carved out of this to derive tools/overhead time.
    const runStart = Date.now();
    // Replay this scope's prior turns as chat context (baseline A — full replay,
    // capped so a long chat can't blow the local model's context window).
    let history: PriorTurn[] = [];
    let journalReadMs = 0;
    try {
      const readStart = Date.now();
      const priorDocs = await client.commandJournalReadByWorkstream(scopeKey);
      journalReadMs = Date.now() - readStart;
      history = journalsToHistory(priorDocs, HISTORY_TURN_CAP);
    } catch (err) {
      this.output.appendLine(
        `  history load failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }

    try {
      const result = await runToolLoop({
        // Constrained decoding: the model's tool-call args are grammar-forced to
        // each tool's JSON schema (kills scaffolding leaks + missing `slug`).
        chat: (messages, tools) => llama.chatConstrained(messages, tools),
        executor,
        command: trimmed,
        contextSlug,
        contextKind,
        tools: catalog.tools,
        history,
        maxIterations: Math.max(1, Math.floor(maxIterations)),
        trace: (event) => {
          if (event.type === 'turn') {
            const calls = event.toolCalls
              .map((c) => `${c.name}(${JSON.stringify(c.args)})`)
              .join(', ');
            const ms = event.perCallMs !== undefined ? ` [${event.perCallMs}ms]` : '';
            this.output.appendLine(
              `  turn ${event.iteration}:${ms} ${event.toolCallCount} tool_call(s) → ${calls}`,
            );
          } else {
            const suffix = event.error ? ` — ${event.error}` : '';
            this.output.appendLine(
              `    exec ${event.name}: ${event.outcome}${suffix}`,
            );
          }
        },
      });
      const markdown = buildBrief({
        finalText: result.finalText,
        toolCalls: result.toolCalls,
        stopReason: result.stopReason,
        error: result.error,
      });
      this.view?.webview.postMessage({ type: 'brief', markdown, scope: scopeKey });
      // Whole run is done (brief ready). Carve model + journal-read time out of
      // the total to derive tools/overhead. journalWrite is measured around the
      // update call below — it happens AFTER the record is shaped, so it's logged
      // to the channel but NOT persisted inside the record it would write.
      const totalMs = Date.now() - runStart;
      const modelMs = result.timings.modelMs;
      const modelCalls = result.timings.modelCalls;
      const toolsMs = Math.max(0, totalMs - modelMs - journalReadMs);
      this.output.appendLine(
        `  tokens: prompt=${result.tokens.promptTokens} eval=${result.tokens.evalTokens} ` +
          `calls=${result.tokens.calls} (stop: ${result.stopReason})`,
      );
      // Two-phase write, phase 2: overwrite the `running` record with the full
      // response + timings, marking it `succeeded` (or `failed` when the loop
      // returned an error stop reason).
      const writeStart = Date.now();
      await this.finalizeJournal(
        journal,
        buildJournalSpec({
          workstream: scopeKey,
          command: trimmed,
          contextSlug,
          contextKind,
          brief: markdown,
          toolCalls: result.toolCalls,
          corrections: result.corrections,
          stopReason: result.stopReason,
          tokens: result.tokens,
          timings: { totalMs, modelMs, modelCalls, journalReadMs, toolsMs },
          status: result.stopReason === 'error' ? 'failed' : 'succeeded',
        }),
        client,
      );
      const journalWriteMs = Date.now() - writeStart;
      this.output.appendLine(
        `  timing: total ${totalMs}ms | model ${modelMs}ms (${modelCalls} call${modelCalls === 1 ? '' : 's'}) | ` +
          `journalRead ${journalReadMs}ms | journalWrite ${journalWriteMs}ms | tools ${toolsMs}ms`,
      );
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.view?.webview.postMessage({ type: 'briefError', message, scope: scopeKey });
      // runToolLoop normally RETURNS (errors surface as stopReason 'error'), so
      // this outer catch is the rare hard-throw path — we may have no result to
      // persist. Mark the record `failed` with the error as its brief and
      // whatever trace we have (none here) so the turn is never a zero-trace
      // mystery. Because the record was created at submit, even a crash before
      // this catch leaves a `running` record behind — that's the safety win.
      await this.finalizeJournal(
        journal,
        buildJournalSpec({
          workstream: scopeKey,
          command: trimmed,
          contextSlug,
          contextKind,
          brief: message,
          toolCalls: [],
          corrections: [],
          stopReason: 'error',
          status: 'failed',
        }),
        client,
      );
    }
  }

  /**
   * The AGENT path: treat the message as a directive for a long-lived agent
   * (nanite). Runs the agent through the injected extension-host runner and
   * journals the directive + result as one `CommandJournal` turn scoped to the
   * agent's id — the same two-phase write the local-model path uses, so the
   * turn replays like any other and is right-click-openable. The agent's own
   * completion write-back is suppressed (runner `postCompletion:false`) so the
   * result lands here, on the agent's conversation, not on a topic/workstream.
   */
  private async runAgentDirective(
    agentId: string,
    directive: string,
    client: ControlPlaneClient,
  ): Promise<void> {
    const scopeKey = scopeKeyFor(agentId);
    this.view?.webview.postMessage({ type: 'briefRunning', scope: scopeKey });

    if (!this.directAgent) {
      this.view?.webview.postMessage({
        type: 'briefError',
        message: 'Agent direction is not available in this build.',
        scope: scopeKey,
      });
      return;
    }

    // Phase 1 — journal the directive as `running` so the bubble persists + is
    // openable immediately (mirrors the local-model path).
    const journal = await this.createInitialJournal(
      buildInitialJournalSpec({
        workstream: scopeKey,
        command: directive,
        contextSlug: agentId,
        contextKind: 'nanite',
      }),
      client,
    );
    if (journal) {
      this.view?.webview.postMessage({ type: 'attachJournalId', id: journal.id, scope: scopeKey });
    }

    this.output.appendLine(
      `\n[${new Date().toISOString()}] agent directive: ${JSON.stringify(directive)} ` +
        `(agent: ${agentId})`,
    );

    try {
      const result = await this.directAgent(agentId, directive);
      const markdown = buildNaniteCompletionBrief(result);
      this.view?.webview.postMessage({ type: 'brief', markdown, scope: scopeKey });
      // Phase 2 — overwrite the `running` record with the run's outcome.
      await this.finalizeJournal(
        journal,
        buildJournalSpec({
          workstream: scopeKey,
          command: directive,
          contextSlug: agentId,
          contextKind: 'nanite',
          brief: markdown,
          toolCalls: [],
          corrections: [],
          stopReason: result.status,
          status: result.status === 'succeeded' ? 'succeeded' : 'failed',
          // Link the turn out to the run's NaniteJournal record (the full run
          // trace) when the runner wrote one, instead of this CommandJournal doc.
          naniteJournalId: result.journalId,
        }),
        client,
      );
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.view?.webview.postMessage({ type: 'briefError', message, scope: scopeKey });
      await this.finalizeJournal(
        journal,
        buildJournalSpec({
          workstream: scopeKey,
          command: directive,
          contextSlug: agentId,
          contextKind: 'nanite',
          brief: message,
          toolCalls: [],
          corrections: [],
          stopReason: 'error',
          status: 'failed',
        }),
        client,
      );
    }
  }

  /**
   * Fetch + project the control-plane's canonical tool catalog once, caching it
   * for the session (WM 14.2.1 "derive-local-tools-from-canonical-registry").
   * Returns the cached catalog on subsequent calls. Returns `null` (logged to
   * the "Working Memory Command" channel) when the daemon is down / the fetch
   * fails / the projection is empty, so the caller can fail the run gracefully.
   */
  private async ensureCatalog(
    client: ControlPlaneClient,
  ): Promise<ProjectedCatalog | null> {
    if (this.catalog) {
      return this.catalog;
    }
    try {
      const canonical = await client.listTools();
      const projected = projectCatalog(canonical);
      if (projected.tools.length === 0) {
        this.output.appendLine('  tool catalog fetch returned no usable tools');
        return null;
      }
      this.catalog = projected;
      this.output.appendLine(
        `  tool catalog: ${projected.tools.length} tool(s) derived from the control-plane`,
      );
      return projected;
    } catch (err) {
      this.output.appendLine(
        `  tool catalog fetch failed: ${err instanceof Error ? err.message : String(err)}`,
      );
      return null;
    }
  }

  /**
   * Two-phase write, phase 1: create the `running` request-only record. Returns
   * `{ id, resourceVersion }` for the in-place finalize, or `null` when the
   * write was skipped / rejected / failed. Best-effort: a failure is logged and
   * the run continues (journaling must never block a command).
   */
  private async createInitialJournal(
    spec: CommandJournalSpec,
    client: ControlPlaneClient,
  ): Promise<{ id: string; resourceVersion: number } | null> {
    try {
      const res = await client.commandJournalCreate(spec);
      if (!res.available || res.error || !res.document) {
        this.output.appendLine(
          `  journal create skipped: ${res.error ?? 'control plane unavailable'}`,
        );
        return null;
      }
      return {
        id: res.document.metadata.id,
        resourceVersion: res.document.metadata.resourceVersion,
      };
    } catch (err) {
      this.output.appendLine(
        `  journal create failed: ${err instanceof Error ? err.message : String(err)}`,
      );
      return null;
    }
  }

  /**
   * Two-phase write, phase 2: overwrite the `running` record with the final
   * spec via a versioned update. No-op (logged) when phase 1 never produced an
   * id — the turn's record is then lost, but journaling is best-effort and the
   * run itself already succeeded/failed on its own terms.
   */
  private async finalizeJournal(
    journal: { id: string; resourceVersion: number } | null,
    spec: CommandJournalSpec,
    client: ControlPlaneClient,
  ): Promise<void> {
    if (!journal) {
      this.output.appendLine('  journal finalize skipped: no record was created on submit');
      return;
    }
    try {
      const res = await client.commandJournalUpdate(journal.id, spec, journal.resourceVersion);
      if (!res.available || res.error || !res.document) {
        this.output.appendLine(
          `  journal finalize skipped: ${res.error ?? 'control plane unavailable'}`,
        );
      }
    } catch (err) {
      this.output.appendLine(
        `  journal finalize failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  private renderHtml(webview: vscode.Webview): string {
    const nonce = randomBytes(16).toString('base64');
    const base = vscode.Uri.joinPath(this.extensionUri, 'media', 'webview-ui');
    const scriptUri = webview.asWebviewUri(vscode.Uri.joinPath(base, 'main.js'));
    const styleUri = webview.asWebviewUri(vscode.Uri.joinPath(base, 'main.css'));
    const codiconUri = webview.asWebviewUri(
      vscode.Uri.joinPath(this.extensionUri, 'media', 'codicons', 'codicon.css'),
    );
    const csp = [
      `default-src 'none'`,
      `img-src ${webview.cspSource} data:`,
      `style-src ${webview.cspSource} 'unsafe-inline'`,
      `font-src ${webview.cspSource}`,
      `script-src 'nonce-${nonce}'`,
    ].join('; ');

    return `<!DOCTYPE html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta http-equiv="Content-Security-Policy" content="${csp}" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <link rel="stylesheet" href="${codiconUri}" />
    <link rel="stylesheet" href="${styleUri}" />
    <title>Working Memory Command</title>
  </head>
  <body>
    <div id="app"></div>
    <script nonce="${nonce}">window.__WM_VIEW__ = 'command';</script>
    <script type="module" nonce="${nonce}" src="${scriptUri}"></script>
  </body>
</html>`;
  }
}
