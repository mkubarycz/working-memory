import * as vscode from 'vscode';
import {
  emptyAllPanelData,
  getAllPanelData,
  type PanelAction,
  type PanelData,
  type PanelWorkstreamSection,
} from '../panelData';
import { JournalStore } from '../db';
import type { PanelRevealTarget } from '../panelReveal';

interface InvokeMessage {
  type: 'invoke';
  command: string;
  args?: unknown[];
}

interface OpenMessage {
  type: 'open';
  uri: string;
  revealSection?: 'sessions' | 'recent-entries' | 'entries';
}

interface ActionsMessage {
  type: 'actions';
  nodeId: string;
  actions: PanelAction[];
}

interface ReadyMessage {
  type: 'ready';
}

interface CardUnfocusMessage {
  type: 'card.unfocus';
  slug: string;
  topicSlug: string;
}

interface CardFocusMessage {
  type: 'card.focus';
  slug: string;
  topicSlug: string;
}

type InboundMessage =
  | InvokeMessage
  | OpenMessage
  | ActionsMessage
  | ReadyMessage
  | CardUnfocusMessage
  | CardFocusMessage;

/**
 * `WebviewViewProvider` for the single Working Memory panel. Hosts a tab
 * strip (Active / Archive / Topics / Topic Types) + tree-like list. Data is shaped by
 * `panelData.ts`; rendering and expand/collapse state live in
 * `media/panel/panel.js`. When `store` is null (no hub workspace) the
 * panel renders an empty state with a hint to open the hub folder.
 */
export class WorkstreamPanelProvider implements vscode.WebviewViewProvider {
  public static readonly viewType = 'workingMemory.workstreams';

  private view: vscode.WebviewView | undefined;

  /**
   * Latest reveal target pushed from the extension host (the WM doc currently
   * visible in the active tab group, or null when none). Stored so we can
   * replay it when the webview (re)sends `ready` after a reload.
   */
  private lastReveal: PanelRevealTarget | null = null;

  constructor(
    private readonly extensionUri: vscode.Uri,
    private readonly store: JournalStore | null,
  ) {}

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
    // Wire the message listener BEFORE assigning `html`. Setting `html` is
    // what boots the webview script, which posts `ready` immediately; if the
    // listener isn't attached yet that first message (and its reveal replay)
    // can be dropped.
    webviewView.webview.onDidReceiveMessage((msg: InboundMessage) =>
      this.handleMessage(msg),
    );
    webviewView.webview.html = this.renderHtml(webviewView.webview);
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
    const data = this.store ? getAllPanelData(this.store) : emptyAllPanelData();
    this.view.webview.postMessage({ type: 'data', data });
    this.updateBadge(data.active);
  }

  /**
   * Mirror the In-Progress count onto the view-container icon in the activity
   * bar as a numeric badge. The count is the number of active workstreams that
   * resolve to the 'progress' section — read straight off the panel data we
   * just posted so it stays perfectly in sync with the rendered cards. A count
   * of 0 clears the badge (VS Code hides a zero-value badge anyway).
   */
  private updateBadge(active: PanelData): void {
    if (!this.view) {
      return;
    }
    const progress = active.items.find(
      (item): item is PanelWorkstreamSection =>
        item.kind === 'workstream-section' && item.section === 'progress',
    );
    const count = progress ? progress.workstreams.length : 0;
    this.view.badge =
      count > 0
        ? { value: count, tooltip: `${count} in progress` }
        : undefined;
  }

  /**
   * Tell the webview to scroll the matching row into view and highlight it
   * (switching tabs / expanding ancestors as needed). Pass null to clear any
   * existing highlight. The target is remembered and replayed on `ready` so
   * it survives webview reloads.
   */
  reveal(target: PanelRevealTarget | null): void {
    this.lastReveal = target;
    this.view?.webview.postMessage({ type: 'reveal', target });
  }

  private handleMessage(msg: InboundMessage): void {
    if (!msg || typeof msg !== 'object') {
      return;
    }
    switch (msg.type) {
      case 'ready':
        this.refresh();
        // Replay the last reveal so a freshly (re)loaded webview restores the
        // highlight for whatever WM doc is currently open.
        this.view?.webview.postMessage({
          type: 'reveal',
          target: this.lastReveal,
        });
        return;
      case 'open':
        if (typeof msg.uri === 'string') {
          if (
            msg.revealSection === 'sessions' ||
            msg.revealSection === 'recent-entries' ||
            msg.revealSection === 'entries'
          ) {
            try {
              const uri = vscode.Uri.parse(msg.uri).with({
                fragment: msg.revealSection,
              });
              void vscode.commands.executeCommand('vscode.open', uri);
              return;
            } catch (err) {
              console.warn('[working-memory] panel open URI parse failed:', err);
            }
          }
          void vscode.commands.executeCommand('vscode.open', vscode.Uri.parse(msg.uri));
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
      case 'card.unfocus':
        if (
          typeof msg.slug === 'string' &&
          msg.slug.trim().length > 0 &&
          typeof msg.topicSlug === 'string' &&
          msg.topicSlug.trim().length > 0
        ) {
          this.handleCardUnfocus(msg.slug, msg.topicSlug);
        }
        return;
      case 'card.focus':
        if (
          typeof msg.slug === 'string' &&
          msg.slug.trim().length > 0 &&
          typeof msg.topicSlug === 'string' &&
          msg.topicSlug.trim().length > 0
        ) {
          this.handleCardFocus(msg.slug, msg.topicSlug);
        }
        return;
    }
  }

  private handleCardFocus(slug: string, topicSlug: string): void {
    if (!this.store) {
      return;
    }
    try {
      this.store.linkWorkstreamTopic({
        workstream_slug: slug,
        topic_slug: topicSlug,
        focused: true,
      });
      this.refresh();
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      vscode.window.showErrorMessage(
        `Working Memory: failed to add topic to focus — ${message}`,
      );
    }
  }

  private handleCardUnfocus(slug: string, topicSlug: string): void {
    if (!this.store) {
      return;
    }
    try {
      this.store.unfocusWorkstreamTopic({
        workstream_slug: slug,
        topic_slug: topicSlug,
      });
      this.refresh();
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      vscode.window.showErrorMessage(
        `Working Memory: failed to remove topic from focus — ${message}`,
      );
    }
  }

  private async showActionsQuickPick(actions: PanelAction[]): Promise<void> {
    if (!Array.isArray(actions) || actions.length === 0) {
      return;
    }
    const items = actions.map((a) => ({
      label: a.title,
      description: a.description,
      action: a,
    }));
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
    const codiconUri = webview.asWebviewUri(
      vscode.Uri.joinPath(this.extensionUri, 'media', 'codicons', 'codicon.css'),
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
    <link rel="stylesheet" href="${codiconUri}" />
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
        <button
          class="tab"
          role="tab"
          data-tab="topic-types"
          aria-selected="false"
        >Topic Types</button>
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
