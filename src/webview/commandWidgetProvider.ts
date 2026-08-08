import * as vscode from 'vscode';
import { randomBytes } from 'node:crypto';
import type { ControlPlaneClient } from '../controlPlaneClient';
import { LlamaClient } from '../llamaClient';
import { runToolLoop } from '../wmToolLoop';
import { buildBrief, createControlPlaneToolExecutor } from '../wmToolExecutor';

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

export class CommandWidgetProvider implements vscode.WebviewViewProvider {
  public static readonly viewType = 'workingMemory.commandWidget';

  private view: vscode.WebviewView | undefined;
  private context: WidgetContext | null = null;
  /** Per-turn trace log for the tool-calling loop (parallel-vs-repeat diagnostics). */
  private readonly output: vscode.OutputChannel;

  constructor(
    private readonly extensionUri: vscode.Uri,
    private readonly getClient: () => ControlPlaneClient | null,
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
    // Only topic/workstream make sense as a command scope; ignore others.
    if (context && context.kind !== 'topic' && context.kind !== 'workstream') {
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

    this.view?.webview.postMessage({ type: 'briefRunning' });

    const cfg = vscode.workspace.getConfiguration('workingMemory');
    const baseUrl = cfg.get<string>('localModel.baseUrl', 'http://localhost:11434');
    const model = cfg.get<string>('localModel.model', 'qwen3:14b');
    const maxIterations = cfg.get<number>('localModel.maxIterations', 8);

    const llama = new LlamaClient({ baseUrl, model });
    const executor = createControlPlaneToolExecutor(client);

    this.output.appendLine(
      `\n[${new Date().toISOString()}] command: ${JSON.stringify(trimmed)} ` +
        `(context: ${contextSlug ?? 'none'}, model: ${model})`,
    );

    try {
      const result = await runToolLoop({
        // Constrained decoding: the model's tool-call args are grammar-forced to
        // each tool's JSON schema (kills scaffolding leaks + missing `slug`).
        chat: (messages, tools) => llama.chatConstrained(messages, tools),
        executor,
        command: trimmed,
        contextSlug,
        contextKind: this.context?.kind ?? null,
        maxIterations: Math.max(1, Math.floor(maxIterations)),
        trace: (event) => {
          if (event.type === 'turn') {
            const calls = event.toolCalls
              .map((c) => `${c.name}(${JSON.stringify(c.args)})`)
              .join(', ');
            this.output.appendLine(
              `  turn ${event.iteration}: ${event.toolCallCount} tool_call(s) → ${calls}`,
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
      this.view?.webview.postMessage({ type: 'brief', markdown });
    } catch (err) {
      this.view?.webview.postMessage({
        type: 'briefError',
        message: err instanceof Error ? err.message : String(err),
      });
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
