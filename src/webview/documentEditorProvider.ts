import * as vscode from 'vscode';
import { randomBytes } from 'node:crypto';
import type {
  ControlPlaneClient,
  DocumentEnvelope,
  Topic,
  TopicType,
  Workstream,
} from '../controlPlaneClient';

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
  | { type: 'openWorkstream'; slug: string };

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
        case 'save':
          await this.saveWorkstream(document.ref, msg.patch ?? {}, post);
          return;
        case 'saveTopic':
          await this.saveTopic(document.ref, msg.patch ?? {}, post);
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
