import * as vscode from 'vscode';
import {
  buildBlackboardPanelData,
  buildTopicsPanel,
  buildWorkstreamPanels,
  emptyAllPanelData,
  getAllPanelData,
  type PanelAction,
  type PanelData,
  type PanelWorkstreamSection,
} from '../panelData';
import { JournalStore, type WorkstreamSection } from '../db';
import type { ControlPlaneClient } from '../controlPlaneClient';
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

interface BlackboardRefreshMessage {
  type: 'blackboard.refresh';
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

interface ReorderWorkstreamMessage {
  type: 'reorderWorkstream';
  slug: string;
  section: WorkstreamSection;
  prevSlug: string | null;
  nextSlug: string | null;
}

type InboundMessage =
  | InvokeMessage
  | OpenMessage
  | ActionsMessage
  | ReadyMessage
  | BlackboardRefreshMessage
  | CardUnfocusMessage
  | CardFocusMessage
  | ReorderWorkstreamMessage;

/**
 * `WebviewViewProvider` for the single Working Memory panel. Hosts a tab
 * strip (Active / Alerts / Nanites + gear-hosted Archive / Types / Topics) +
 * tree-like list. Data is shaped by
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
    private readonly controlPlaneClient: ControlPlaneClient | null = null,
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
    // When the view becomes visible again (expanded / tab re-selected), pull
    // fresh Blackboard rows so a doc created while it was hidden shows up. The
    // in-webview poll only runs while visible; this covers the show edge.
    webviewView.onDidChangeVisibility(() => {
      if (webviewView.visible) {
        void this.refreshBlackboard();
      }
    });
    webviewView.onDidDispose(() => {
      if (this.view === webviewView) {
        this.view = undefined;
      }
    });  }

  /** Push fresh data to the webview. Safe to call when the view is hidden. */
  refresh(): void {
    // Public entry point stays synchronous so the many call sites (tools,
    // commands, message handlers) are unchanged; the control-plane fetch for
    // the Active/Archive tabs happens inside.
    void this.refreshInternal();
  }

  /**
   * Assemble the `data` message: topics / topic-types / alerts / nanites come
   * from the journal store (unchanged), while the Active + Archive (workstream)
   * tabs are sourced ASYNC from the control-plane document store via the
   * client's ws-* domain API (WM 13.0 "ws-consumer-repoint"). Awaiting the
   * control-plane here is cheap: a down daemon fails fast (no port file), a live
   * one is a localhost round-trip. Blackboard keeps its own dedicated channel.
   */
  private async refreshInternal(): Promise<void> {
    if (!this.view) {
      return;
    }
    const journal = this.store
      ? getAllPanelData(this.store)
      : emptyAllPanelData();
    const cp = await this.loadControlPlanePanels();
    // The view may have been disposed while awaiting the control-plane.
    if (!this.view) {
      return;
    }
    const data = {
      ...journal,
      active: cp.active,
      archive: cp.archive,
      // Topics are control-plane-sourced now (WM 13.0 "topic-consumer-repoint"),
      // overriding the journal topics assembled by getAllPanelData above.
      topics: cp.topics,
    };
    this.view.webview.postMessage({ type: 'data', data });
    this.updateBadge(cp.active);
    // Blackboard rows come from the control-plane MCP server, not the journal
    // DB, so they're fetched async and posted separately.
    void this.refreshBlackboard();
  }

  /**
   * Fetch the Active + Archive (workstream) tabs AND the Topics tab from the
   * control-plane via the client's ws-* domain API, degrading to the "control
   * plane not running" empty state when the client is absent or the daemon is
   * unreachable (mirrors refreshBlackboard's unavailable handling). Workstreams
   * and topics are fetched together so each workstream card's Topics group can
   * be populated from the topic `spec.workstreams` membership (WM 13.0
   * "topic-consumer-repoint").
   */
  private async loadControlPlanePanels(): Promise<{
    active: PanelData;
    archive: PanelData;
    topics: PanelData;
  }> {
    if (!this.controlPlaneClient) {
      const ws = buildWorkstreamPanels({
        available: false,
        workstreams: [],
        error: 'Control plane not running',
      });
      return {
        active: ws.active,
        archive: ws.archive,
        topics: buildTopicsPanel({
          available: false,
          topics: [],
          error: 'Control plane not running',
        }),
      };
    }
    try {
      const [workstreams, topics, alerts] = await Promise.all([
        this.controlPlaneClient.wsRead({}),
        this.controlPlaneClient.topicRead({}),
        this.controlPlaneClient.alertRead({}),
      ]);
      const ws = buildWorkstreamPanels({
        available: true,
        workstreams,
        topics,
        alerts,
        store: this.store,
      });
      return {
        active: ws.active,
        archive: ws.archive,
        topics: buildTopicsPanel({ available: true, topics, alerts, store: this.store }),
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const ws = buildWorkstreamPanels({
        available: false,
        workstreams: [],
        error: message,
      });
      return {
        active: ws.active,
        archive: ws.archive,
        topics: buildTopicsPanel({ available: false, topics: [], error: message }),
      };
    }
  }

  /**
   * Fetch Blackboard rows from the control-plane via the MCP client and post
   * them to the webview as a dedicated `blackboard` message (so a journal-data
   * refresh never clobbers them, and vice-versa). Documents change out-of-band
   * (via the wm2 chat agent), so this is also called when the tab gains focus.
   */
  async refreshBlackboard(): Promise<void> {
    if (!this.view) {
      return;
    }
    if (!this.controlPlaneClient) {
      this.view.webview.postMessage({
        type: 'blackboard',
        data: buildBlackboardPanelData({
          available: false,
          documents: [],
          error: 'Control plane not running',
        }),
      });
      return;
    }
    const result = await this.controlPlaneClient.listDocuments();
    // The view may have been disposed while awaiting; re-check.
    this.view?.webview.postMessage({
      type: 'blackboard',
      data: buildBlackboardPanelData(result),
    });
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
          const parsed = vscode.Uri.parse(msg.uri);
          void vscode.commands.executeCommand('vscode.open', parsed);
        }
        return;
      case 'invoke':
        if (typeof msg.command === 'string') {
          const args = Array.isArray(msg.args) ? msg.args : [];
          vscode.commands.executeCommand(msg.command, ...args);
        }
        return;
      case 'blackboard.refresh':
        void this.refreshBlackboard();
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
          void this.handleCardUnfocus(msg.slug, msg.topicSlug);
        }
        return;
      case 'card.focus':
        if (
          typeof msg.slug === 'string' &&
          msg.slug.trim().length > 0 &&
          typeof msg.topicSlug === 'string' &&
          msg.topicSlug.trim().length > 0
        ) {
          void this.handleCardFocus(msg.slug, msg.topicSlug);
        }
        return;
      case 'reorderWorkstream':
        if (
          typeof msg.slug === 'string' &&
          msg.slug.trim().length > 0 &&
          (msg.section === 'queue' ||
            msg.section === 'progress' ||
            msg.section === 'backlog')
        ) {
          this.handleReorderWorkstream(
            msg.slug,
            msg.section,
            typeof msg.prevSlug === 'string' ? msg.prevSlug : null,
            typeof msg.nextSlug === 'string' ? msg.nextSlug : null,
          );
        }
        return;
    }
  }

  private handleReorderWorkstream(
    slug: string,
    section: WorkstreamSection,
    _prevSlug: string | null,
    _nextSlug: string | null,
  ): void {
    // A cross-section drag (pulling a card into Queue / In Progress / Backlog)
    // is a lifecycle-section move — delegate to the same control-plane-backed
    // command the shelf move-button uses, so drag and the button behave
    // identically (it validates, patches the workstream's status via the
    // client, and refreshes).
    // NOTE: manual WITHIN-section ordering (prevSlug/nextSlug) is still deferred
    // — control-plane workstreams have no `position` field yet — so a
    // same-section drop is a no-op status patch and the row snaps back to the
    // authoritative control-plane order on refresh.
    void vscode.commands.executeCommand('working-memory.setWorkstreamSection', {
      slug,
      section,
    });
  }

  private async handleCardFocus(slug: string, topicSlug: string): Promise<void> {
    // "Add to Focus" pins the topic in this workstream via the control-plane
    // ws-topic-update API (WM 13.0 "control-plane-topic-focus"): topicSetFocus
    // ensures the topic is a member (`spec.workstreams`) AND records the focus
    // in `spec.focusedWorkstreams`, so the pinned-focus row renders it.
    if (!this.controlPlaneClient) {
      return;
    }
    try {
      await this.controlPlaneClient.topicSetFocus({
        slug: topicSlug,
        workstream: slug,
      });
      this.refresh();
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      vscode.window.showErrorMessage(
        `Working Memory: failed to add topic to focus — ${message}`,
      );
    }
  }

  private async handleCardUnfocus(slug: string, topicSlug: string): Promise<void> {
    // "Remove from Focus" unpins the topic from this workstream via
    // topicClearFocus: it drops the workstream from `spec.focusedWorkstreams`
    // only and KEEPS `spec.workstreams` membership (unfocusing ≠ detaching),
    // matching the menu label.
    if (!this.controlPlaneClient) {
      return;
    }
    try {
      await this.controlPlaneClient.topicClearFocus({
        slug: topicSlug,
        workstream: slug,
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
          data-tab="blackboard"
          aria-selected="false"
        >Blackboard</button>
        <button
          class="tab"
          role="tab"
          data-tab="active"
          aria-selected="true"
        >Active</button>
        <button
          class="tab"
          role="tab"
          data-tab="alerts"
          aria-selected="false"
        >Alerts</button>
        <button
          class="tab"
          role="tab"
          data-tab="nanites"
          aria-selected="false"
        >Nanites</button>
        <div class="gear-tab" role="presentation">
          <button
            class="gear-chip"
            role="tab"
            data-tab="archive"
            aria-selected="false"
          >Archive</button>
          <button
            class="gear-btn"
            aria-label="More views"
            aria-haspopup="true"
            aria-expanded="false"
            title="More views"
          ><span class="codicon codicon-settings-gear"></span></button>
        </div>
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
