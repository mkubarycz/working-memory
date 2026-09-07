import * as vscode from 'vscode';
import { randomBytes } from 'node:crypto';
import type { ControlPlaneClient } from '../controlPlaneClient';
import { LlamaClient } from '../llamaClient';
import { runToolLoop } from '../wmToolLoop';
import { buildBrief, createControlPlaneToolExecutor } from '../wmToolExecutor';
import { projectCatalog, type ProjectedCatalog } from '../wmToolProjection';
import { buildNaniteCompletionBrief } from '../nanites/completionMessage';
import type { NaniteRunResult } from '../nanites/types';

const GLOBAL_SCOPE_KEY = '__global__';

function scopeKeyFor(contextSlug: string | null | undefined): string {
  const slug = (contextSlug ?? '').trim();
  return slug.length > 0 ? slug : GLOBAL_SCOPE_KEY;
}

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
  | { type: 'submitCommand'; command: string; contextSlug: string | null };

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
    this.context = context;
    this.postContext();
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
      return;
    }
    if (msg.type === 'submitCommand') {
      await this.runCommand(msg.command, msg.contextSlug);
      return;
    }
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
    // WM tool-calling loop.
    if (this.context?.kind === 'nanite') {
      await this.runAgentDirective(this.context.slug, trimmed);
      return;
    }

    const scopeKey = scopeKeyFor(contextSlug);
    const contextKind = this.context?.kind ?? null;

    this.view?.webview.postMessage({ type: 'briefRunning', scope: scopeKey });

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
      return;
    }
    const executor = createControlPlaneToolExecutor(client, catalog.localToCanonical);

    this.output.appendLine(
      `\n[${new Date().toISOString()}] command: ${JSON.stringify(trimmed)} ` +
        `(context: ${contextSlug ?? 'none'}, model: ${model})`,
    );

    // Whole-run wall clock (submit → brief ready).
    const runStart = Date.now();

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
      const totalMs = Date.now() - runStart;
      const modelMs = result.timings.modelMs;
      const modelCalls = result.timings.modelCalls;
      const toolsMs = Math.max(0, totalMs - modelMs);
      this.output.appendLine(
        `  tokens: prompt=${result.tokens.promptTokens} eval=${result.tokens.evalTokens} ` +
          `calls=${result.tokens.calls} (stop: ${result.stopReason})`,
      );
      this.output.appendLine(
        `  timing: total ${totalMs}ms | model ${modelMs}ms (${modelCalls} call${modelCalls === 1 ? '' : 's'}) | ` +
          `tools ${toolsMs}ms`,
      );
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.view?.webview.postMessage({ type: 'briefError', message, scope: scopeKey });
    }
  }

  /**
   * The AGENT path: treat the message as a directive for a long-lived agent
   * (nanite). Runs the agent through the injected extension-host runner and
   * renders the result in the ephemeral transcript.
   */
  private async runAgentDirective(agentId: string, directive: string): Promise<void> {
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

    this.output.appendLine(
      `\n[${new Date().toISOString()}] agent directive: ${JSON.stringify(directive)} ` +
        `(agent: ${agentId})`,
    );

    try {
      const result = await this.directAgent(agentId, directive);
      const markdown = buildNaniteCompletionBrief(result);
      this.view?.webview.postMessage({ type: 'brief', markdown, scope: scopeKey });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.view?.webview.postMessage({ type: 'briefError', message, scope: scopeKey });
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
