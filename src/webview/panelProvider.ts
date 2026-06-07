import * as vscode from 'vscode';
import { getAllPanelData, type PanelAction } from '../panelData';

interface InvokeMessage {
  type: 'invoke';
  command: string;
  args?: unknown[];
}

interface OpenMessage {
  type: 'open';
  uri: string;
}

interface ActionsMessage {
  type: 'actions';
  nodeId: string;
  actions: PanelAction[];
}

interface ReadyMessage {
  type: 'ready';
}

type InboundMessage =
  | InvokeMessage
  | OpenMessage
  | ActionsMessage
  | ReadyMessage;

/**
 * `WebviewViewProvider` for the single Working Memory panel. Hosts a tab
 * strip (Active / Archive) + tree-like list, replacing the two prior
 * `TreeView` blades. Data is shaped by `panelData.ts`; rendering and
 * expand/collapse state live in `media/panel/panel.js`.
 */
export class WorkstreamPanelProvider implements vscode.WebviewViewProvider {
  public static readonly viewType = 'workingMemory.workstreams';

  private view: vscode.WebviewView | undefined;

  constructor(private readonly extensionUri: vscode.Uri) {}

  resolveWebviewView(
    webviewView: vscode.WebviewView,
    _context: vscode.WebviewViewResolveContext,
    _token: vscode.CancellationToken,
  ): void {
    this.view = webviewView;
    webviewView.webview.options = {
      enableScripts: true,
      localResourceRoots: [vscode.Uri.joinPath(this.extensionUri, 'media')],
    };
    webviewView.webview.html = this.renderHtml(webviewView.webview);
    webviewView.webview.onDidReceiveMessage((msg: InboundMessage) =>
      this.handleMessage(msg),
    );
    webviewView.onDidDispose(() => {
      if (this.view === webviewView) {
        this.view = undefined;
      }
    });
  }

  /** Push fresh data to the webview. Safe to call when the view is hidden. */
  refresh(): void {
    if (!this.view) {
      return;
    }
    this.view.webview.postMessage({ type: 'data', data: getAllPanelData() });
  }

  private handleMessage(msg: InboundMessage): void {
    if (!msg || typeof msg !== 'object') {
      return;
    }
    switch (msg.type) {
      case 'ready':
        this.refresh();
        return;
      case 'open':
        if (typeof msg.uri === 'string') {
          vscode.commands.executeCommand(
            'vscode.open',
            vscode.Uri.parse(msg.uri),
          );
        }
        return;
      case 'invoke':
        if (typeof msg.command === 'string') {
          const args = Array.isArray(msg.args) ? msg.args : [];
          vscode.commands.executeCommand(msg.command, ...args);
        }
        return;
      case 'actions':
        void this.showActionsQuickPick(msg.actions);
        return;
    }
  }

  private async showActionsQuickPick(actions: PanelAction[]): Promise<void> {
    if (!Array.isArray(actions) || actions.length === 0) {
      return;
    }
    const items = actions.map((a) => ({ label: a.title, action: a }));
    const pick = await vscode.window.showQuickPick(items, {
      placeHolder: 'Choose an action',
    });
    if (!pick) {
      return;
    }
    const args = Array.isArray(pick.action.args) ? pick.action.args : [];
    await vscode.commands.executeCommand(pick.action.command, ...args);
  }

  private renderHtml(webview: vscode.Webview): string {
    const nonce = makeNonce();
    const base = vscode.Uri.joinPath(this.extensionUri, 'media', 'panel');
    const scriptUri = webview.asWebviewUri(
      vscode.Uri.joinPath(base, 'panel.js'),
    );
    const styleUri = webview.asWebviewUri(
      vscode.Uri.joinPath(base, 'panel.css'),
    );
    const csp = [
      `default-src 'none'`,
      `img-src ${webview.cspSource} data:`,
      `style-src ${webview.cspSource}`,
      `font-src ${webview.cspSource}`,
      `script-src 'nonce-${nonce}'`,
    ].join('; ');

    return `<!DOCTYPE html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta http-equiv="Content-Security-Policy" content="${csp}" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <link rel="stylesheet" href="${styleUri}" />
    <title>Working Memory</title>
  </head>
  <body>
    <div id="root">
      <div class="tabs" role="tablist">
        <button
          class="tab"
          role="tab"
          data-tab="active"
          aria-selected="true"
        >Active</button>
        <button
          class="tab"
          role="tab"
          data-tab="archive"
          aria-selected="false"
        >Archive</button>
        <button
          class="tab"
          role="tab"
          data-tab="topics"
          aria-selected="false"
        >Topics</button>
      </div>
      <div id="list" class="list" role="tree" aria-label="Workstreams"></div>
    </div>
    <script nonce="${nonce}" src="${scriptUri}"></script>
  </body>
</html>`;
  }
}

function makeNonce(): string {
  const chars =
    'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  let out = '';
  for (let i = 0; i < 32; i++) {
    out += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return out;
}
