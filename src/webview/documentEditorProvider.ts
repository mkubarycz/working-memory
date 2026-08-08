import * as vscode from 'vscode';
import { randomBytes } from 'node:crypto';
import type {
  ControlPlaneClient,
  DocumentEnvelope,
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
}

interface RelationVM {
  slug: string;
  title: string;
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
  workstreams: RelationVM[];
  focusedWorkstreams: RelationVM[];
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
  | { type: 'togglePinTopic'; slug: string };

type ExtToWebview =
  | { type: 'document'; data: DocumentVM }
  | { type: 'saved'; resourceVersion?: number }
  | { type: 'error'; message: string };

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

    const load = async (): Promise<void> => {
      const vm = await this.loadDocument(document.ref);
      if (vm) {
        post({ type: 'document', data: vm });
      } else {
        post({
          type: 'error',
          message: `Document "${document.ref.identifier}" not found, or the control plane is not running.`,
        });
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
          await this.saveWorkstream(document.ref, msg.patch ?? {}, post);
          return;
        case 'saveTopic':
          await this.saveTopic(document.ref, msg.patch ?? {}, post);
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
            await this.togglePinTopic(document.ref, msg.slug, load, post);
          }
          return;
      }
    });
  }

  /**
   * Load ANY document through the control-plane client and build a kind-keyed
   * view-model. Workstream / topic get bespoke VMs (loaded via the typed
   * `ws-*` methods); every other kind falls back to a generic envelope VM
   * (loaded via `wm-document-read`). NO database access.
   */
  private async loadDocument(ref: ParsedRef): Promise<DocumentVM | null> {
    const client = this.getClient();
    if (!client) {
      return null;
    }
    const cpKind = controlPlaneKindFor(ref.kindHint);
    if (cpKind === 'Workstream') {
      return this.loadWorkstream(client, ref.identifier);
    }
    if (cpKind === 'Topic') {
      return this.loadTopic(client, ref.identifier);
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
    };
  }

  private async readWorkstream(
    client: ControlPlaneClient,
    identifier: string,
  ): Promise<Workstream | null> {
    try {
      const bySlug = await client.wsRead({ slug: identifier });
      if (bySlug[0]) {
        return bySlug[0];
      }
    } catch {
      // fall through to id lookup
    }
    try {
      const byId = await client.wsRead({ id: identifier });
      if (byId[0]) {
        return byId[0];
      }
    } catch {
      // not resolvable
    }
    return null;
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
    // Relations resolve slug → title via a title map built from all topics /
    // workstreams (best-effort; a missing title falls back to the slug).
    const topicTitles = await this.titleMap(
      () => client.topicRead(),
      (t) => t.slug,
      (t) => t.title,
    );
    const wsTitles = await this.titleMap(
      () => client.wsRead(),
      (w) => w.slug,
      (w) => w.title,
    );
    const rel = (slug: string, titles: Map<string, string>): RelationVM => ({
      slug,
      title: titles.get(slug) ?? slug,
    });
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
      parents: topic.parents.map((s) => rel(s, topicTitles)),
      workstreams: topic.workstreams.map((s) => rel(s, wsTitles)),
      focusedWorkstreams: topic.focusedWorkstreams.map((s) => rel(s, wsTitles)),
    };
  }

  private async readTopic(
    client: ControlPlaneClient,
    identifier: string,
  ): Promise<Topic | null> {
    try {
      const bySlug = await client.topicRead({ slug: identifier });
      if (bySlug[0]) {
        return bySlug[0];
      }
    } catch {
      // fall through to id lookup
    }
    try {
      const byId = await client.topicRead({ id: identifier });
      if (byId[0]) {
        return byId[0];
      }
    } catch {
      // not resolvable
    }
    return null;
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
  ): Promise<GenericDocVM | null> {
    // Try by id first (the `/document/<id>` form), then by slug (+ kind).
    let result = await client.getDocument(
      cpKind ? { id: identifier, kind: cpKind } : { id: identifier },
    );
    if (result.available && !result.document) {
      result = await client.getDocument(
        cpKind ? { slug: identifier, kind: cpKind } : { slug: identifier },
      );
    }
    if (!result.available || !result.document) {
      return null;
    }
    return this.buildGeneric(result.document);
  }

  private buildGeneric(doc: DocumentEnvelope): GenericDocVM {
    return buildGenericVM(doc);
  }

  // ---- Autosave -------------------------------------------------------------

  private async saveWorkstream(
    ref: ParsedRef,
    patch: { title?: string; status?: string },
    post: (msg: ExtToWebview) => void,
  ): Promise<void> {
    const client = this.getClient();
    if (!client) {
      post({
        type: 'error',
        message: 'Control plane is not running — changes were not saved.',
      });
      return;
    }
    const ws = await this.readWorkstream(client, ref.identifier);
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
        message: `Save failed: ${err instanceof Error ? err.message : String(err)}`,
      });
      return;
    }
    const vm = await this.loadWorkstream(client, ref.identifier);
    if (vm) {
      post({ type: 'document', data: vm });
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
    ref: ParsedRef,
    topicSlug: string,
    reload: () => Promise<void>,
    post: (msg: ExtToWebview) => void,
  ): Promise<void> {
    const client = this.getClient();
    if (!client) {
      post({
        type: 'error',
        message: 'Control plane is not running — changes were not saved.',
      });
      return;
    }
    const ws = await this.readWorkstream(client, ref.identifier);
    if (!ws || !ws.slug) {
      post({
        type: 'error',
        message: 'This workstream has no slug, so topics cannot be pinned to it.',
      });
      return;
    }
    const topic = await this.readTopic(client, topicSlug);
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
        message: `Pin failed: ${err instanceof Error ? err.message : String(err)}`,
      });
      return;
    }
    await reload();
  }

  private async saveTopic(
    ref: ParsedRef,
    patch: TopicPatch,
    post: (msg: ExtToWebview) => void,
  ): Promise<void> {
    const client = this.getClient();
    if (!client) {
      post({
        type: 'error',
        message: 'Control plane is not running — changes were not saved.',
      });
      return;
    }
    const topic = await this.readTopic(client, ref.identifier);
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
        message: `Save failed: ${err instanceof Error ? err.message : String(err)}`,
      });
      return;
    }
    const vm = await this.loadTopic(client, ref.identifier);
    if (vm) {
      post({ type: 'document', data: vm });
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
