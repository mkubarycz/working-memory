import * as vscode from 'vscode';
import { randomBytes } from 'node:crypto';
import type {
  ControlPlaneClient,
  DocumentEnvelope,
  Alert,
  Nanite,
  NaniteTemplate,
  Topic,
  TopicType,
  Workstream,
} from '../controlPlaneClient';
import {
  buildWorkstreamTree,
  type PanelAction,
  type PanelNaniteRow,
  type PanelTopic,
  type PanelTopicsGroup,
} from '../panelData';
import { decideRefreshAction } from './refreshDecision';
import { buildAlertVMs, RECENT_CLOSED_ALERT_MS, alertBubbleForTopic } from './alertVms';

/**
 * The unified Working Memory document custom editor (WM 14.2
 * "svelte-document-editor").
 *
 * The control plane is a GENERIC document store, so there is ONE custom editor —
 * not one per kind. VS Code is URI-addressed, not disk-addressed: a "document
 * file" is a synthetic virtual URI
 * `working-memory:/<kind>/<slug-or-id>.working-memory`. The `.working-memory`
 * extension makes the `customEditors` `filenamePattern` match; the
 * `working-memory` FileSystemProvider stats it as a zero-byte handle so
 * `vscode.openWith` resolves. There is NO file on disk and NO DB access —
 * `resolveCustomEditor` loads the document THROUGH THE CONTROL-PLANE CLIENT and
 * pushes a view-model to a Svelte webview, which dispatches its UI by `kind`
 * (workstream / topic / a generic fallback for every other kind).
 *
 * Save model is autosave: an editable field posts a debounced patch, persisted
 * via the typed control-plane update methods (`ws-workstream-update` /
 * `ws-topic-update`), which echoes the refreshed view-model back. No dirty
 * state, so the CustomDocument edit/save/revert hooks are inert.
 */

// ---- View-models (structural mirror of `webview-ui/src/lib/types.ts`) --------

interface WorkstreamTopicVM {
  title: string;
  slug: string;
  status: string;
  pinned: boolean;
}

interface TreeActionVM {
  command: string;
  title: string;
  icon: string;
  args: unknown[];
  enabled: boolean;
}

interface TreeNaniteVM {
  kind: 'nanite';
  id: string;
  label: string;
  icon: string;
  phase: string;
  openId: string;
  actions: TreeActionVM[];
}

interface TreeTopicVM {
  kind: 'topic';
  id: string;
  label: string;
  icon: string;
  status: string;
  slug: string;
  pinned: boolean;
  alertCount: number;
  alertSeverity: 'alert' | 'informational' | null;
  children: Array<TreeTopicVM | TreeNaniteVM>;
  actions: TreeActionVM[];
}

interface TreeGroupVM {
  kind: 'group';
  id: string;
  label: string;
  icon: string;
  children: Array<TreeTopicVM | TreeNaniteVM>;
}

interface WorkstreamVM {
  kind: 'workstream';
  title: string;
  slug: string | null;
  status: string;
  createdAt: number;
  updatedAt: number;
  closure: string | null;
  resourceVersion: number;
  editable: boolean;
  topics: WorkstreamTopicVM[];
  tree: TreeGroupVM[];
  alerts: AlertVM[];
}

interface RelationVM {
  slug: string;
  title: string;
  alertCount: number;
  alertSeverity: 'alert' | 'informational' | null;
}

interface AlertVM {
  id: string;
  title: string;
  description: string;
  recommendedAction: string;
  status: 'alert' | 'informational' | 'closed';
  updatedAt: number;
  dimmed: boolean;
}

interface TopicTypeMetaVM {
  slug: string | null;
  label: string;
  icon: string;
  description: string;
}

interface TopicVM {
  kind: 'topic';
  title: string;
  slug: string | null;
  status: string;
  topicType: string;
  typeMeta: TopicTypeMetaVM | null;
  body: string;
  createdAt: number;
  updatedAt: number;
  resourceVersion: number;
  editable: boolean;
  parents: RelationVM[];
  children: RelationVM[];
  workstreams: RelationVM[];
  focusedWorkstreams: RelationVM[];
  alerts: AlertVM[];
}

interface GenericFieldVM {
  key: string;
  value: string;
}

interface GenericDocVM {
  kind: string;
  id: string;
  slug: string | null;
  title: string;
  createdAt: number;
  updatedAt: number;
  resourceVersion: number;
  spec: GenericFieldVM[];
}

type DocumentVM = WorkstreamVM | TopicVM | GenericDocVM;

interface TopicPatch {
  title?: string;
  status?: string;
  body?: string;
}

type WebviewToExt =
  | { type: 'ready' }
  | { type: 'save'; patch: { title?: string; status?: string } }
  | { type: 'saveTopic'; patch: TopicPatch }
  | { type: 'openTopic'; slug: string }
  | { type: 'openWorkstream'; slug: string }
  | { type: 'openDocument'; id: string }
  | { type: 'invoke'; command: string; args: unknown[] }
  | { type: 'togglePinTopic'; slug: string }
  // Transition an alert's lifecycle status from a callout button, routed to
  // `ws-alert-update` via the control-plane client.
  | { type: 'setAlertStatus'; id: string; status: 'alert' | 'informational' | 'closed' }
  // The webview reports whether it currently holds un-flushed local edits so the
  // host's refresh decision can avoid stomping in-progress work (Bug A).
  | { type: 'editState'; hasPendingEdits: boolean }
  // The user clicked the "content changed — reload" banner: discard local edits
  // and re-push the current server version.
  | { type: 'discardAndReload' };

type ExtToWebview =
  | { type: 'document'; data: DocumentVM }
  | { type: 'saved'; resourceVersion?: number }
  | { type: 'error'; message: string }
  // Non-terminal startup state: the control plane isn't connected yet, so the
  // webview shows "connecting…" and waits for a refresh to heal it (Bug B).
  | { type: 'connecting' }
  // A newer server version exists but the user has unsaved edits — the webview
  // surfaces a reload affordance instead of overwriting (Bug A).
  | { type: 'staleReload' };

/** Outcome of loading a document: distinguishes "not ready" from a genuine 404. */
type LoadOutcome =
  | { status: 'ok'; vm: DocumentVM }
  | { status: 'notFound' }
  | { status: 'notReady'; message?: string };

/**
 * Per-open-editor state the provider tracks so it can re-fetch + re-push each
 * live webview when the store changes out-of-process (Bug A) and heal editors
 * that failed their first load because the daemon wasn't up yet (Bug B).
 */
interface OpenEditorEntry {
  ref: ParsedRef;
  post: (msg: ExtToWebview) => void;
  /** The `hashVm` of the view-model currently displayed, or null when unloaded. */
  loadedSignal: string | null;
  /** True while showing an error / connecting state or not yet loaded. */
  errored: boolean;
  /** True while the webview holds un-flushed local edits. */
  hasPendingEdits: boolean;
  /**
   * Whether this editor's panel is currently visible. Hidden editors are
   * skipped by `refreshOpen()` and revalidated when they become visible again.
   */
  visible: boolean;
}

/** The parsed kind hint + identifier from a `.working-memory` URI. */
interface ParsedRef {
  /** URI kind hint: 'workstream' | 'topic' | 'document' | any other kind name. */
  kindHint: string;
  /** Slug or id captured from the URI. */
  identifier: string;
}

/** Minimal custom document: the URI + parsed kind hint / identifier. */
interface WmDocument extends vscode.CustomDocument {
  readonly ref: ParsedRef;
}

/** Parse `working-memory:/<kind>/<x>.working-memory` into a kind hint + id. */
export function parseRef(uri: vscode.Uri): ParsedRef {
  const match = /^\/([^/]+)\/(.+)\.working-memory$/.exec(uri.path);
  if (!match) {
    return { kindHint: 'document', identifier: uri.path };
  }
  const kindHint = match[1];
  let identifier = match[2];
  try {
    identifier = decodeURIComponent(identifier);
  } catch {
    // keep raw
  }
  return { kindHint, identifier };
}

/** Map a URI kind hint to the control-plane document `kind` name. */
export function controlPlaneKindFor(kindHint: string): string | null {
  switch (kindHint) {
    case 'workstream':
      return 'Workstream';
    case 'topic':
      return 'Topic';
    case 'topic-type':
      return 'TopicType';
    case 'alert':
      return 'Alert';
    case 'document':
      return null; // generic by-id lookup, any kind
    default:
      // A capitalized kind name passed straight through (e.g. 'Nanite').
      return kindHint;
  }
}

function makeNonce(): string {
  return randomBytes(16).toString('base64');
}

/** Extract a human-readable message from an unknown thrown value. */
function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * Decide whether toggling a topic's pin in this workstream should SET focus
 * (true) or CLEAR it (false): set when the workstream isn't already in the
 * topic's `focusedWorkstreams`. Pure so the toggle decision is unit-testable.
 */
export function shouldSetFocus(
  focusedWorkstreams: readonly string[],
  wsSlug: string,
): boolean {
  return !focusedWorkstreams.includes(wsSlug);
}

/** Nanite lifecycle commands the tree may invoke on the host (allow-list). */
const NANITE_TREE_COMMANDS = new Set([
  'workingMemory.nanite.run',
  'workingMemory.nanite.reset',
  'workingMemory.nanite.restart',
]);

/** Bounded backoff for the initial "connecting…" retry on first load (Bug B). */
const LOAD_RETRY_LIMIT = 5;
const LOAD_RETRY_DELAY_MS = 600;

/** Best-effort string coercion for a `spec` value. */
export function asString(v: unknown): string {
  if (v === null || v === undefined) {
    return '';
  }
  if (typeof v === 'string') {
    return v;
  }
  return typeof v === 'object' ? JSON.stringify(v, null, 2) : String(v);
}

/**
 * Build the generic fallback view-model from a document envelope: flatten +
 * sort the `spec` into readable fields and derive a title. Pure — no client,
 * no VS Code APIs — so it can be unit-tested directly.
 */
export function buildGenericVM(doc: DocumentEnvelope): GenericDocVM {
  const spec: GenericFieldVM[] = Object.entries(doc.spec ?? {}).map(
    ([key, value]) => ({ key, value: asString(value) }),
  );
  spec.sort((a, b) => a.key.localeCompare(b.key));
  const title =
    asString(doc.spec?.title) ||
    asString(doc.spec?.label) ||
    doc.metadata.slug ||
    doc.metadata.id;
  return {
    kind: doc.kind,
    id: doc.metadata.id,
    slug: doc.metadata.slug,
    title,
    createdAt: doc.metadata.createdAt,
    updatedAt: doc.metadata.updatedAt,
    resourceVersion: doc.metadata.resourceVersion,
    spec,
  };
}

/**
 * Host-side change-detection hash over an ENTIRE view-model. The workstream
 * screen is a COMPOSITE — it embeds its child topic + nanite tree — but the
 * workstream's own `resourceVersion` only moves when the workstream document
 * itself changes. Closing a child topic bumps the TOPIC's version, not the
 * workstream's, so a plain version compare misses it. Hashing the whole VM
 * (which includes that tree) catches every child-only change too, so no bespoke
 * composite fingerprint is needed. `JSON.stringify` is stable here: the VM is
 * built deterministically (sorted rows/tree) from the same inputs each fetch.
 */
export function hashVm(vm: DocumentVM): string {
  return JSON.stringify(vm);
}

/** Parse a topic slug out of a `working-memory:/topic/<slug>.working-memory` uri. */
function topicSlugFromUri(uri: string): string {
  const m = /^working-memory:\/topic\/(.+)\.working-memory$/.exec(uri);
  return m ? m[1] : '';
}

/** Parse a document id out of a `working-memory:/document/<id>.working-memory` uri. */
function documentIdFromUri(uri: string): string {
  const m = /^working-memory:\/document\/(.+)\.working-memory$/.exec(uri);
  return m ? m[1] : '';
}

/** Map a rail Panel topic/nanite row to the editor's minimal tree node VM. */
function toTreeNode(
  row: PanelTopic | PanelNaniteRow,
): TreeTopicVM | TreeNaniteVM {
  if (row.kind === 'nanite') {
    return {
      kind: 'nanite',
      id: row.id,
      label: row.label,
      icon: row.icon,
      phase: row.phase,
      openId: documentIdFromUri(row.openUri),
      actions: toTreeActions(row.actions),
    };
  }
  return {
    kind: 'topic',
    id: row.id,
    label: row.label,
    icon: row.icon,
    status: row.status,
    slug: topicSlugFromUri(row.openUri),
    pinned: row.focused,
    alertCount: row.alertCount ?? 0,
    alertSeverity: row.alertSeverity ?? null,
    children: (row.children ?? []).map(toTreeNode),
    actions: toTreeActions(row.actions),
  };
}

/** Map rail PanelAction[] to the tree's minimal action VMs (dropping description). */
function toTreeActions(actions: PanelAction[] | undefined): TreeActionVM[] {
  return (actions ?? []).map((a) => ({
    command: a.command,
    title: a.title,
    icon: a.icon ?? '',
    args: Array.isArray(a.args) ? a.args : [],
    enabled: a.enabled !== false,
  }));
}

/** Map a rail Panel topics-group to the editor's tree group VM. */
function toTreeGroup(group: PanelTopicsGroup): TreeGroupVM {
  return {
    kind: 'group',
    id: group.id,
    label: group.label,
    icon: group.icon,
    children: group.children.map(toTreeNode),
  };
}

export class DocumentEditorProvider
  implements vscode.CustomEditorProvider<WmDocument>
{
  public static readonly viewType = 'workingMemory.documentEditor';

  /** Build the virtual URI that opens a document of `kind` in this editor. */
  public static uriFor(kind: string, slugOrId: string): vscode.Uri {
    return vscode.Uri.parse(
      `working-memory:/${kind}/${encodeURIComponent(slugOrId)}.working-memory`,
    );
  }

  // Autosave-through-API means the document is never dirty, so this never fires.
  private readonly _onDidChangeCustomDocument = new vscode.EventEmitter<
    vscode.CustomDocumentEditEvent<WmDocument>
  >();
  readonly onDidChangeCustomDocument = this._onDidChangeCustomDocument.event;

  /**
   * Live registry of open webview panels so external store changes can re-fetch
   * + re-push each one (Bug A) and stuck "connecting" editors can self-heal once
   * the daemon comes up (Bug B). Cleared per-entry on `onDidDispose`.
   */
  private readonly openEditors = new Set<OpenEditorEntry>();

  constructor(
    private readonly extensionUri: vscode.Uri,
    private readonly getClient: () => ControlPlaneClient | null,
  ) {}

  openCustomDocument(uri: vscode.Uri): WmDocument {
    return { uri, ref: parseRef(uri), dispose: () => undefined };
  }

  async resolveCustomEditor(
    document: WmDocument,
    webviewPanel: vscode.WebviewPanel,
  ): Promise<void> {
    const webview = webviewPanel.webview;
    webview.options = {
      enableScripts: true,
      localResourceRoots: [vscode.Uri.joinPath(this.extensionUri, 'media')],
    };
    webview.html = this.renderHtml(webview);

    const post = (msg: ExtToWebview): void => {
      void webview.postMessage(msg);
    };

    // Register this panel so `refreshOpen()` can re-fetch + re-push it when the
    // store changes out-of-process, and heal it if the daemon wasn't up yet.
    const entry: OpenEditorEntry = {
      ref: document.ref,
      post,
      loadedSignal: null,
      errored: true,
      hasPendingEdits: false,
      visible: webviewPanel.visible,
    };
    this.openEditors.add(entry);
    webviewPanel.onDidDispose(() => {
      this.openEditors.delete(entry);
    });

    // Track panel visibility so `refreshOpen()` can skip hidden editors, and
    // revalidate an editor the moment it becomes visible again (hidden panels
    // don't get live store updates, so they'd otherwise show stale content).
    webviewPanel.onDidChangeViewState(() => {
      const wasVisible = entry.visible;
      entry.visible = webviewPanel.visible;
      if (!wasVisible && entry.visible) {
        void this.refreshEntry(entry);
      }
    });

    // Initial load with a short bounded backoff: if the control plane isn't
    // connected yet, show a NON-terminal "connecting…" state and retry a few
    // times. The primary heal is still the CP-ready `refresh()` → `refreshOpen()`
    // signal, but this covers the case where no store write follows startup.
    const load = async (attempt = 0): Promise<void> => {
      const outcome = await this.loadDocument(document.ref);
      if (outcome.status === 'ok') {
        this.pushDocument(entry, outcome.vm);
        return;
      }
      if (outcome.status === 'notFound') {
        entry.errored = true;
        entry.loadedSignal = null;
        post({
          type: 'error',
          message: `Document "${document.ref.identifier}" was not found.`,
        });
        return;
      }
      // notReady: daemon not connected yet — stay non-terminal and retry.
      entry.errored = true;
      entry.loadedSignal = null;
      post({ type: 'connecting' });
      if (attempt < LOAD_RETRY_LIMIT) {
        setTimeout(() => {
          if (this.openEditors.has(entry)) {
            void load(attempt + 1);
          }
        }, LOAD_RETRY_DELAY_MS);
      }
    };

    webview.onDidReceiveMessage(async (msg: WebviewToExt) => {
      if (!msg || typeof msg !== 'object') {
        return;
      }
      switch (msg.type) {
        case 'ready':
          await load();
          return;
        case 'openTopic':
          if (typeof msg.slug === 'string' && msg.slug.length > 0) {
            void vscode.commands.executeCommand('working-memory.open', {
              kind: 'topic',
              id: msg.slug,
            });
          }
          return;
        case 'openWorkstream':
          if (typeof msg.slug === 'string' && msg.slug.length > 0) {
            void vscode.commands.executeCommand('working-memory.open', {
              kind: 'workstream',
              id: msg.slug,
            });
          }
          return;
        case 'openDocument':
          // Nanites (and any generic doc) open straight through the unified
          // editor — `working-memory.open` whitelists only the named kinds, so
          // route the generic `document` kind via openWith like the rail does.
          if (typeof msg.id === 'string' && msg.id.length > 0) {
            void vscode.commands.executeCommand(
              'vscode.openWith',
              DocumentEditorProvider.uriFor('document', msg.id),
              DocumentEditorProvider.viewType,
            );
          }
          return;
        case 'save':
          await this.saveWorkstream(entry, msg.patch ?? {});
          return;
        case 'saveTopic':
          await this.saveTopic(entry, msg.patch ?? {});
          return;
        case 'editState':
          entry.hasPendingEdits = msg.hasPendingEdits === true;
          return;
        case 'discardAndReload':
          // The user chose to discard local edits and take the server version.
          entry.hasPendingEdits = false;
          await load();
          return;
        case 'invoke':
          // Nanite lifecycle actions ported from the rail — same commands, run
          // via executeCommand. Allow-listed so the webview can't invoke
          // arbitrary commands. Reload after so phase changes reflect.
          if (
            typeof msg.command === 'string' &&
            NANITE_TREE_COMMANDS.has(msg.command)
          ) {
            await vscode.commands.executeCommand(
              msg.command,
              ...(Array.isArray(msg.args) ? msg.args : []),
            );
            await load();
          }
          return;
        case 'togglePinTopic':
          if (typeof msg.slug === 'string' && msg.slug.length > 0) {
            await this.togglePinTopic(entry, msg.slug);
          }
          return;
        case 'setAlertStatus':
          if (
            typeof msg.id === 'string' &&
            msg.id.length > 0 &&
            (msg.status === 'alert' ||
              msg.status === 'informational' ||
              msg.status === 'closed')
          ) {
            await this.setAlertStatus(entry, msg.id, msg.status);
          }
          return;
      }
    });
  }

  /** Push a fresh view-model to an editor and mark it loaded (clears errors). */
  private pushDocument(entry: OpenEditorEntry, vm: DocumentVM): void {
    entry.errored = false;
    entry.loadedSignal = hashVm(vm);
    entry.post({ type: 'document', data: vm });
  }

  /**
   * Re-fetch every open editor's document and reconcile it with what's shown.
   * Rides the extension's existing `refresh()` signal (store-file watcher + poll
   * + control-plane-ready), so it heals stuck "connecting" editors after the
   * daemon comes up (Bug B) and live-updates open editors on external writes
   * (Bug A) — without stomping unsaved local edits. Only VISIBLE editors are
   * reconciled here; hidden ones revalidate when they become visible again (see
   * `onDidChangeViewState` in `resolveCustomEditor`).
   */
  public async refreshOpen(): Promise<void> {
    for (const entry of this.openEditors) {
      if (!entry.visible) {
        continue;
      }
      await this.refreshEntry(entry);
    }
  }

  /**
   * Re-fetch a single editor's document and reconcile it with what's displayed.
   * Change-detection compares a hash of the whole fetched VM against the hash of
   * the displayed one, so a child-only change (e.g. a closed child topic, which
   * doesn't move the workstream's own version) still triggers a re-push.
   */
  private async refreshEntry(entry: OpenEditorEntry): Promise<void> {
    const outcome = await this.loadDocument(entry.ref);
    if (outcome.status === 'notReady') {
      // Still not connected — leave the current state; a later signal retries.
      return;
    }
    if (outcome.status === 'notFound') {
      // A genuine miss is terminal (e.g. the document was deleted).
      entry.errored = true;
      entry.loadedSignal = null;
      entry.post({
        type: 'error',
        message: `Document "${entry.ref.identifier}" was not found.`,
      });
      return;
    }
    const action = decideRefreshAction({
      errored: entry.errored,
      displayedSignal: entry.loadedSignal,
      fetchedSignal: hashVm(outcome.vm),
      hasPendingEdits: entry.hasPendingEdits,
    });
    if (action === 'apply' || action === 'retry') {
      this.pushDocument(entry, outcome.vm);
    } else if (action === 'reload-banner') {
      // Newer server version + unsaved local edits: offer a reload instead of
      // overwriting. Displayed version is left unchanged until the user acts.
      entry.post({ type: 'staleReload' });
    }
    // noop: nothing to do.
  }

  /**
   * Load ANY document through the control-plane client and build a kind-keyed
   * view-model. Workstream / topic get bespoke VMs (loaded via the typed
   * `ws-*` methods); every other kind falls back to a generic envelope VM
   * (loaded via `wm-document-read`). NO database access.
   */
  private async loadDocument(ref: ParsedRef): Promise<LoadOutcome> {
    const client = this.getClient();
    if (!client) {
      // No client yet == the daemon isn't connected. NON-terminal (Bug B).
      return { status: 'notReady' };
    }
    const cpKind = controlPlaneKindFor(ref.kindHint);
    if (cpKind === 'Workstream' || cpKind === 'Topic') {
      // The typed `ws-*` reads THROW only on a dead/dropped daemon; a genuine
      // miss returns an empty result (no throw). So a thrown error here means
      // "not ready", while a null VM means "not found".
      try {
        const vm =
          cpKind === 'Workstream'
            ? await this.loadWorkstream(client, ref.identifier)
            : await this.loadTopic(client, ref.identifier);
        return vm ? { status: 'ok', vm } : { status: 'notFound' };
      } catch (err) {
        return { status: 'notReady', message: messageOf(err) };
      }
    }
    return this.loadGeneric(client, ref.identifier, cpKind);
  }

  // ---- Workstream (kind = workstream) ---------------------------------------

  private async loadWorkstream(
    client: ControlPlaneClient,
    identifier: string,
  ): Promise<WorkstreamVM | null> {
    const ws = await this.readWorkstream(client, identifier);
    if (!ws) {
      return null;
    }
    const slug = ws.slug;
    let topics: Topic[] = [];
    if (slug) {
      try {
        topics = await client.topicRead({ workstream: slug });
      } catch {
        topics = [];
      }
    }
    const rows: WorkstreamTopicVM[] = topics
      .map((t) => ({
        title: t.title,
        slug: t.slug ?? t.id,
        status: t.status,
        pinned: slug ? t.focusedWorkstreams.includes(slug) : false,
      }))
      .sort((a, b) => a.title.localeCompare(b.title));
    const ordered = [
      ...rows.filter((r) => r.pinned),
      ...rows.filter((r) => !r.pinned),
    ];
    // Full nested topic + nanite tree — the SAME composition the left rail's
    // workstream card renders. All inputs come through the control-plane client.
    let nanites: Nanite[] = [];
    let naniteTemplates: NaniteTemplate[] = [];
    let topicTypes: TopicType[] = [];
    if (slug) {
      try {
        nanites = await client.naniteRead({ workstream: slug });
      } catch {
        nanites = [];
      }
      try {
        naniteTemplates = await client.naniteTemplateRead();
      } catch {
        naniteTemplates = [];
      }
      try {
        topicTypes = await client.topicTypeRead();
      } catch {
        topicTypes = [];
      }
    }
    const typeMap = new Map<string, TopicType>(
      topicTypes.map((t) => [t.slug ?? t.id, t]),
    );
    const { groups } = buildWorkstreamTree(
      ws.id,
      slug ?? '',
      'active',
      slug ? topics : undefined,
      typeMap,
      [],
      nanites,
      naniteTemplates,
    );
    // Alerts relevant to this workstream = alerts referencing any member topic.
    const memberSlugs = topics
      .map((t) => t.slug)
      .filter((s): s is string => Boolean(s));
    let alerts: Alert[] = [];
    try {
      alerts = await client.alertRead();
    } catch {
      alerts = [];
    }
    return {
      kind: 'workstream',
      title: ws.title,
      slug,
      status: ws.status,
      createdAt: ws.opened_at,
      updatedAt: ws.updated_at,
      closure: ws.closure,
      resourceVersion: ws.resourceVersion,
      editable: Boolean(slug),
      topics: ordered,
      tree: groups.map(toTreeGroup),
      alerts: buildAlertVMs(alerts, memberSlugs, Date.now()),
    };
  }

  private async readWorkstream(
    client: ControlPlaneClient,
    identifier: string,
  ): Promise<Workstream | null> {
    // A miss returns an EMPTY array (no throw), so we fall through to the id
    // lookup; a dead/dropped daemon THROWS, which propagates to `loadDocument`
    // where it is classified as "not ready" (vs. this null → "not found").
    const bySlug = await client.wsRead({ slug: identifier });
    if (bySlug[0]) {
      return bySlug[0];
    }
    const byId = await client.wsRead({ id: identifier });
    return byId[0] ?? null;
  }

  // ---- Topic (kind = topic) -------------------------------------------------

  private async loadTopic(
    client: ControlPlaneClient,
    identifier: string,
  ): Promise<TopicVM | null> {
    const topic = await this.readTopic(client, identifier);
    if (!topic) {
      return null;
    }
    const typeMeta = await this.readTopicTypeMeta(client, topic.topicType);
    // Fetch all topics ONCE: drives both the relation title map and the child
    // lineage (topics whose `parents` include this one — the DAG below it).
    let allTopics: Topic[] = [];
    try {
      allTopics = await client.topicRead();
    } catch {
      allTopics = [];
    }
    const topicTitles = new Map<string, string>();
    for (const t of allTopics) {
      if (t.slug) {
        topicTitles.set(t.slug, t.title);
      }
    }
    const wsTitles = await this.titleMap(
      () => client.wsRead(),
      (w) => w.slug,
      (w) => w.title,
    );
    // Alerts whose `topics` reference THIS topic's slug (drives the callouts AND
    // the per-relation alert badges on the family tree).
    let alertsRaw: Alert[] = [];
    try {
      alertsRaw = await client.alertRead();
    } catch {
      alertsRaw = [];
    }
    // Non-topic relation (a workstream) — never carries a topic alert badge.
    const rel = (slug: string, titles: Map<string, string>): RelationVM => ({
      slug,
      title: titles.get(slug) ?? slug,
      alertCount: 0,
      alertSeverity: null,
    });
    // Topic relation (parent / child) — tagged with its open-alert bubble.
    const topicRel = (slug: string, title: string): RelationVM => {
      const b = alertBubbleForTopic(alertsRaw, slug);
      return { slug, title, alertCount: b.count, alertSeverity: b.severity };
    };
    const children: RelationVM[] = topic.slug
      ? allTopics
          .filter((t) => t.slug && t.parents.includes(topic.slug as string))
          .map((t) => topicRel(t.slug as string, t.title))
          .sort((a, b) => a.title.localeCompare(b.title))
      : [];
    const alerts = buildAlertVMs(
      alertsRaw,
      topic.slug ? [topic.slug] : [],
      Date.now(),
    );
    return {
      kind: 'topic',
      title: topic.title,
      slug: topic.slug,
      status: topic.status,
      topicType: topic.topicType,
      typeMeta,
      body: topic.body,
      createdAt: topic.created_at,
      updatedAt: topic.updated_at,
      resourceVersion: topic.resourceVersion,
      editable: Boolean(topic.slug),
      parents: topic.parents.map((s) => topicRel(s, topicTitles.get(s) ?? s)),
      children,
      workstreams: topic.workstreams.map((s) => rel(s, wsTitles)),
      focusedWorkstreams: topic.focusedWorkstreams.map((s) => rel(s, wsTitles)),
      alerts,
    };
  }

  private async readTopic(
    client: ControlPlaneClient,
    identifier: string,
  ): Promise<Topic | null> {
    // A miss returns an EMPTY array (no throw); a dead daemon THROWS and
    // propagates so `loadDocument` classifies it as "not ready" (not 404).
    const bySlug = await client.topicRead({ slug: identifier });
    if (bySlug[0]) {
      return bySlug[0];
    }
    const byId = await client.topicRead({ id: identifier });
    return byId[0] ?? null;
  }

  /**
   * Resolve topic-type metadata (label + icon) from the control-plane TopicType
   * kind. Returns null when the type can't be resolved so the webview falls back
   * to the raw type slug + the shared fallback icon.
   */
  private async readTopicTypeMeta(
    client: ControlPlaneClient,
    topicType: string,
  ): Promise<TopicTypeMetaVM | null> {
    if (!topicType) {
      return null;
    }
    try {
      const [bySlug] = await client.topicTypeRead({ slug: topicType });
      const tt: TopicType | undefined =
        bySlug ?? (await client.topicTypeRead({ id: topicType }))[0];
      if (!tt) {
        return null;
      }
      return {
        slug: tt.slug,
        label: tt.label,
        icon: tt.icon,
        description: tt.description,
      };
    } catch {
      return null;
    }
  }

  private async titleMap<T>(
    read: () => Promise<T[]>,
    slugOf: (t: T) => string | null,
    titleOf: (t: T) => string,
  ): Promise<Map<string, string>> {
    const map = new Map<string, string>();
    try {
      for (const item of await read()) {
        const slug = slugOf(item);
        if (slug) {
          map.set(slug, titleOf(item));
        }
      }
    } catch {
      // best-effort — an empty map degrades relations to slug-only labels
    }
    return map;
  }

  // ---- Generic fallback (any other kind) ------------------------------------

  private async loadGeneric(
    client: ControlPlaneClient,
    identifier: string,
    cpKind: string | null,
  ): Promise<LoadOutcome> {
    // Try by id first (the `/document/<id>` form), then by slug (+ kind).
    // `available:false` == daemon down (NON-terminal); `available:true` +
    // no document == genuine 404 (terminal).
    let result = await client.getDocument(
      cpKind ? { id: identifier, kind: cpKind } : { id: identifier },
    );
    if (!result.available) {
      return { status: 'notReady', message: result.error };
    }
    if (!result.document) {
      result = await client.getDocument(
        cpKind ? { slug: identifier, kind: cpKind } : { slug: identifier },
      );
      if (!result.available) {
        return { status: 'notReady', message: result.error };
      }
    }
    if (!result.document) {
      return { status: 'notFound' };
    }
    return { status: 'ok', vm: this.buildGeneric(result.document) };
  }

  private buildGeneric(doc: DocumentEnvelope): GenericDocVM {
    return buildGenericVM(doc);
  }

  // ---- Autosave -------------------------------------------------------------

  private async saveWorkstream(
    entry: OpenEditorEntry,
    patch: { title?: string; status?: string },
  ): Promise<void> {
    const post = entry.post;
    const ref = entry.ref;
    const client = this.getClient();
    if (!client) {
      post({
        type: 'error',
        message: 'Control plane is not running — changes were not saved.',
      });
      return;
    }
    let ws: Workstream | null;
    try {
      ws = await this.readWorkstream(client, ref.identifier);
    } catch (err) {
      post({ type: 'error', message: `Save failed: ${messageOf(err)}` });
      return;
    }
    if (!ws || !ws.slug) {
      post({
        type: 'error',
        message: 'This workstream has no slug and cannot be edited yet.',
      });
      return;
    }
    const input: { slug: string; title?: string; status?: string } = {
      slug: ws.slug,
    };
    if (typeof patch.title === 'string') {
      input.title = patch.title;
    }
    if (typeof patch.status === 'string') {
      input.status = patch.status;
    }
    try {
      await client.wsUpdate(input);
    } catch (err) {
      post({
        type: 'error',
        message: `Save failed: ${messageOf(err)}`,
      });
      return;
    }
    const vm = await this.loadWorkstream(client, ref.identifier);
    if (vm) {
      this.pushDocument(entry, vm);
    }
    // Explicit host-confirmed ack — the webview flips its indicator green only
    // on THIS, never merely on posting the patch.
    post({ type: 'saved', resourceVersion: vm?.resourceVersion });
  }

  /**
   * Pin or unpin a topic in THIS workstream (ported from the rail's Add/Remove
   * to Focus). The document being edited is the workstream, so its slug is the
   * focus target; the topic's current `focusedWorkstreams` decides direction.
   * Toggles via the same control-plane methods the rail uses
   * (`topicSetFocus` / `topicClearFocus`), then reloads + re-pushes the tree.
   */
  private async togglePinTopic(
    entry: OpenEditorEntry,
    topicSlug: string,
  ): Promise<void> {
    const post = entry.post;
    const ref = entry.ref;
    const client = this.getClient();
    if (!client) {
      post({
        type: 'error',
        message: 'Control plane is not running — changes were not saved.',
      });
      return;
    }
    let ws: Workstream | null;
    let topic: Topic | null;
    try {
      ws = await this.readWorkstream(client, ref.identifier);
      if (ws && ws.slug) {
        topic = await this.readTopic(client, topicSlug);
      } else {
        topic = null;
      }
    } catch (err) {
      post({ type: 'error', message: `Pin failed: ${messageOf(err)}` });
      return;
    }
    if (!ws || !ws.slug) {
      post({
        type: 'error',
        message: 'This workstream has no slug, so topics cannot be pinned to it.',
      });
      return;
    }
    if (!topic || !topic.slug) {
      post({ type: 'error', message: `Topic "${topicSlug}" could not be resolved.` });
      return;
    }
    try {
      if (shouldSetFocus(topic.focusedWorkstreams, ws.slug)) {
        await client.topicSetFocus({ slug: topic.slug, workstream: ws.slug });
      } else {
        await client.topicClearFocus({ slug: topic.slug, workstream: ws.slug });
      }
    } catch (err) {
      post({
        type: 'error',
        message: `Pin failed: ${messageOf(err)}`,
      });
      return;
    }
    const vm = await this.loadWorkstream(client, ref.identifier);
    if (vm) {
      this.pushDocument(entry, vm);
    }
  }

  /**
   * Transition an alert's lifecycle status (resolve / escalate / close / reopen)
   * from a callout button. Persists via the control-plane `ws-alert-update`
   * tool (NO DB), then reloads the editor's document so the refreshed callouts
   * (and any dimming / hiding of a now-closed alert) re-render.
   */
  private async setAlertStatus(
    entry: OpenEditorEntry,
    id: string,
    status: 'alert' | 'informational' | 'closed',
  ): Promise<void> {
    const post = entry.post;
    const client = this.getClient();
    if (!client) {
      post({
        type: 'error',
        message: 'Control plane is not running — the alert was not updated.',
      });
      return;
    }
    try {
      await client.alertUpdate({ id, status });
    } catch (err) {
      post({ type: 'error', message: `Alert update failed: ${messageOf(err)}` });
      return;
    }
    const outcome = await this.loadDocument(entry.ref);
    if (outcome.status === 'ok') {
      this.pushDocument(entry, outcome.vm);
    }
  }

  private async saveTopic(
    entry: OpenEditorEntry,
    patch: TopicPatch,
  ): Promise<void> {
    const post = entry.post;
    const ref = entry.ref;
    const client = this.getClient();
    if (!client) {
      post({
        type: 'error',
        message: 'Control plane is not running — changes were not saved.',
      });
      return;
    }
    let topic: Topic | null;
    try {
      topic = await this.readTopic(client, ref.identifier);
    } catch (err) {
      post({ type: 'error', message: `Save failed: ${messageOf(err)}` });
      return;
    }
    if (!topic || !topic.slug) {
      post({
        type: 'error',
        message: 'This topic has no slug and cannot be edited yet.',
      });
      return;
    }
    const input: {
      slug: string;
      title?: string;
      status?: string;
      body?: string;
    } = { slug: topic.slug };
    if (typeof patch.title === 'string') {
      input.title = patch.title;
    }
    if (typeof patch.status === 'string') {
      input.status = patch.status;
    }
    if (typeof patch.body === 'string') {
      input.body = patch.body;
    }
    try {
      await client.topicUpdate(input);
    } catch (err) {
      post({
        type: 'error',
        message: `Save failed: ${messageOf(err)}`,
      });
      return;
    }
    const vm = await this.loadTopic(client, ref.identifier);
    if (vm) {
      this.pushDocument(entry, vm);
    }
    // Explicit host-confirmed ack — the webview flips its indicator green only
    // on THIS, never merely on posting the patch.
    post({ type: 'saved', resourceVersion: vm?.resourceVersion });
  }

  // ---- Inert CustomDocument hooks (autosave-through-API: never dirty) --------

  saveCustomDocument(): Thenable<void> {
    return Promise.resolve();
  }

  saveCustomDocumentAs(): Thenable<void> {
    return Promise.resolve();
  }

  revertCustomDocument(): Thenable<void> {
    return Promise.resolve();
  }

  backupCustomDocument(
    _document: WmDocument,
    context: vscode.CustomDocumentBackupContext,
  ): Thenable<vscode.CustomDocumentBackup> {
    return Promise.resolve({
      id: context.destination.toString(),
      delete: () => undefined,
    });
  }

  private renderHtml(webview: vscode.Webview): string {
    const nonce = makeNonce();
    const base = vscode.Uri.joinPath(this.extensionUri, 'media', 'webview-ui');
    const scriptUri = webview.asWebviewUri(
      vscode.Uri.joinPath(base, 'main.js'),
    );
    const styleUri = webview.asWebviewUri(
      vscode.Uri.joinPath(base, 'main.css'),
    );
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
    <title>Working Memory Document</title>
  </head>
  <body>
    <div id="app"></div>
    <script type="module" nonce="${nonce}" src="${scriptUri}"></script>
  </body>
</html>`;
  }
}
