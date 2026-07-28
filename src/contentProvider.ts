import * as vscode from 'vscode';
import { JournalStore } from './db';
import {
  renderWorkstreamDoc,
  renderTopicDoc,
  renderTopicTypeDoc,
  renderSessionDoc,
  renderAlertDoc,
  renderNaniteDoc,
  renderNaniteRunDoc,
  enrichDeepLinks,
  extractTopicBody,
  extractTopicTypeBodyTemplate,
  extractTopicTypeLabel,
  extractTopicTypeDescription,
  extractAlertTitle,
  extractAlertStatus,
  extractAlertDescription,
  extractAlertRecommendedAction,
  extractNaniteInstructions,
} from './virtualFileRenderer';
import { AlertsStore } from './alerts/store';
import { NanitesStore } from './nanites/store';
import type { AlertStatus } from './alerts/types';
import type {
  Alert,
  ControlPlaneClient,
  DocumentEnvelope,
  Topic,
} from './controlPlaneClient';
import {
  renderControlPlaneUnavailableDoc,
  renderDocumentNotFoundDoc,
} from './documentRenderer';
import { renderDocumentByKind } from './documentRenderers';
import { renderTopicDocument } from './documentRenderers/topic';
import { renderWorkstreamDocument } from './documentRenderers/workstream';
import { renderTopicTypeDocument } from './documentRenderers/topictype';

type DocKind =
  | 'workstream'
  | 'topic'
  | 'topic-type'
  | 'session'
  | 'alert'
  | 'nanite'
  | 'nanite-run'
  | 'document'
  | 'unknown';

function classifyUri(uri: vscode.Uri): { kind: DocKind; slug: string | null } {
  const p = uri.path;
  if (p.startsWith('/workstream/') && p.endsWith('.md')) {
    const slug = p.slice('/workstream/'.length, p.length - '.md'.length);
    return { kind: 'workstream', slug: slug || null };
  }
  if (p.startsWith('/topic/') && p.endsWith('.md')) {
    const slug = p.slice('/topic/'.length, p.length - '.md'.length);
    return { kind: 'topic', slug: slug || null };
  }
  if (p.startsWith('/topic-type/') && p.endsWith('.md')) {
    const id = p.slice('/topic-type/'.length, p.length - '.md'.length);
    return { kind: 'topic-type', slug: id || null };
  }
  if (p.startsWith('/session/') && p.endsWith('.md')) {
    const id = p.slice('/session/'.length, p.length - '.md'.length);
    return { kind: 'session', slug: id || null };
  }
  if (p.startsWith('/alert/') && p.endsWith('.md')) {
    const id = p.slice('/alert/'.length, p.length - '.md'.length);
    return { kind: 'alert', slug: id || null };
  }
  if (p.startsWith('/nanite-run/') && p.endsWith('.md')) {
    const id = p.slice('/nanite-run/'.length, p.length - '.md'.length);
    return { kind: 'nanite-run', slug: id || null };
  }
  if (p.startsWith('/nanite/') && p.endsWith('.md')) {
    const slug = p.slice('/nanite/'.length, p.length - '.md'.length);
    return { kind: 'nanite', slug: slug || null };
  }
  if (p.startsWith('/document/') && p.endsWith('.md')) {
    const id = p.slice('/document/'.length, p.length - '.md'.length);
    return { kind: 'document', slug: id ? decodeSegment(id) : null };
  }
  return { kind: 'unknown', slug: null };
}

/** Best-effort percent-decode of a URI path segment (falls back to raw). */
function decodeSegment(segment: string): string {
  try {
    return decodeURIComponent(segment);
  } catch {
    return segment;
  }
}

/**
 * URI DocKind → control-plane document kind name. Only the kinds that have a
 * control-plane equivalent are mapped; a mapped kind renders CONTROL-PLANE-FIRST
 * (see `renderKindMaybeControlPlane`). Alerts resolve control-plane-first too
 * (their id may be a control-plane uuid/slug, not a journal numeric id), with a
 * journal fallback for legacy numeric ids. Sessions and nanites have no by-slug
 * control-plane doc here, so they stay journal-rendered.
 */
const CONTROL_PLANE_KIND: Partial<
  Record<DocKind, 'Topic' | 'Workstream' | 'TopicType' | 'Alert'>
> = {
  topic: 'Topic',
  workstream: 'Workstream',
  'topic-type': 'TopicType',
  alert: 'Alert',
};

/**
 * `FileSystemProvider` for the `working-memory:` scheme. Workstream and
 * session docs are read-only (rendered fresh from the DB every read);
 * topic, topic-type, and alert docs are writable — on save we parse the
 * editable regions and persist via the matching store update. When `store`
 * is null (no hub workspace) every doc renders a "DB not available" body
 * and writes are rejected.
 */
export class WorkstreamDocumentProvider implements vscode.FileSystemProvider {
  public static readonly scheme = 'working-memory';

  private readonly _onDidChangeFile = new vscode.EventEmitter<
    vscode.FileChangeEvent[]
  >();
  readonly onDidChangeFile = this._onDidChangeFile.event;

  private readonly knownUris = new Set<string>();
  private readonly mtimes = new Map<string, number>();

  constructor(private store: JournalStore | null) {}

  /**
   * Control-plane MCP client used to render `working-memory:/document/<id>.md`
   * virtual docs (WM 13.0 "blackboard-tab"). Optional: when null, document
   * URIs render an "unavailable" body.
   */
  private controlPlaneClient: ControlPlaneClient | null = null;

  /** Update the store reference after a late DB open (e.g. startup restore). */
  updateStore(store: JournalStore | null): void {
    this.store = store;
  }

  /** Inject the control-plane MCP client (for `/document/<id>` rendering). */
  setControlPlaneClient(client: ControlPlaneClient | null): void {
    this.controlPlaneClient = client;
  }

  refresh(uri?: vscode.Uri): void {
    if (uri) {
      this.markChanged(uri);
      return;
    }
    for (const key of this.knownUris) {
      this.markChanged(vscode.Uri.parse(key));
    }
  }

  private markChanged(uri: vscode.Uri): void {
    this.mtimes.set(uri.toString(), Date.now());
    this._onDidChangeFile.fire([
      { type: vscode.FileChangeType.Changed, uri },
    ]);
  }

  watch(): vscode.Disposable {
    return new vscode.Disposable(() => undefined);
  }

  stat(uri: vscode.Uri): vscode.FileStat | Thenable<vscode.FileStat> {
    const { kind, slug } = classifyUri(uri);
    if (!slug) {
      throw vscode.FileSystemError.FileNotFound(uri);
    }
    this.knownUris.add(uri.toString());
    const mtime = this.mtimes.get(uri.toString()) ?? Date.now();
    if (kind === 'document') {
      // Document bodies are fetched async over MCP; they're always read-only.
      return this.renderDocument(slug).then((text) => ({
        type: vscode.FileType.File,
        ctime: mtime,
        mtime,
        size: Buffer.byteLength(text, 'utf8'),
        permissions: vscode.FilePermission.Readonly,
      }));
    }
    const cpKind = CONTROL_PLANE_KIND[kind];
    if (cpKind && this.controlPlaneClient) {
      // WM 13.0: `topic` / `workstream` / `topic-type` docs resolve
      // CONTROL-PLANE-FIRST (async). A control-plane-resolved doc is READ-ONLY
      // (like `/document/<id>.md`); a journal-fallback doc keeps its per-kind
      // permission behavior (topic/topic-type writable when a store is present,
      // workstream always read-only).
      // TODO: editable-body SAVE of a control-plane-only topic/topic-type is
      // DEFERRED — the writeFile branches are journal-only, so saving such a doc
      // throws FileNotFound until the save is repointed onto the control-plane.
      return this.renderKindMaybeControlPlane(cpKind, slug, uri).then(
        ({ text, fromControlPlane }) => ({
          type: vscode.FileType.File,
          ctime: mtime,
          mtime,
          size: Buffer.byteLength(text, 'utf8'),
          permissions: fromControlPlane
            ? vscode.FilePermission.Readonly
            : this.journalPermission(kind),
        }),
      );
    }
    const text = this.render(kind, slug, uri);
    return {
      type: vscode.FileType.File,
      ctime: mtime,
      mtime,
      size: Buffer.byteLength(text, 'utf8'),
      permissions:
        (kind === 'topic' || kind === 'topic-type' || kind === 'alert' ||
          kind === 'nanite') &&
        this.store
          ? undefined
          : vscode.FilePermission.Readonly,
    };
  }

  readDirectory(): [string, vscode.FileType][] {
    return [];
  }

  createDirectory(): void {
    // no-op
  }

  readFile(uri: vscode.Uri): Uint8Array | Thenable<Uint8Array> {
    const { kind, slug } = classifyUri(uri);
    if (!slug) {
      throw vscode.FileSystemError.FileNotFound(uri);
    }
    this.knownUris.add(uri.toString());
    if (kind === 'document') {
      return this.renderDocument(slug).then((text) =>
        Buffer.from(text, 'utf8'),
      );
    }
    const cpKind = CONTROL_PLANE_KIND[kind];
    if (cpKind && this.controlPlaneClient) {
      // WM 13.0: prefer the control-plane doc (async) for topic / workstream /
      // topic-type; fall back to the journal renderer.
      return this.renderKindMaybeControlPlane(cpKind, slug, uri).then(
        ({ text }) => Buffer.from(text, 'utf8'),
      );
    }
    const text = this.render(kind, slug, uri);
    return Buffer.from(text, 'utf8');
  }

  /**
   * Render a `working-memory:/document/<id>.md` body by fetching the envelope
   * through the control-plane MCP client (`wm-document-read`). Distinguishes
   * daemon-unavailable from unknown-id so the reader gets an actionable body.
   */
  private async renderDocument(id: string): Promise<string> {
    if (!this.controlPlaneClient) {
      return renderControlPlaneUnavailableDoc(id);
    }
    const result = await this.controlPlaneClient.getDocument({ id });
    if (!result.available) {
      return renderControlPlaneUnavailableDoc(id);
    }
    if (!result.document) {
      return renderDocumentNotFoundDoc(id);
    }
    return renderDocumentByKind(result.document);
  }

  /**
   * Render a control-plane-backed virtual doc (`/topic`, `/workstream`,
   * `/topic-type`) CONTROL-PLANE-FIRST (WM 13.0). With a client present, fetch
   * the document by `{ slug, kind }` (kind ∈ `Topic | Workstream | TopicType`)
   * and, on a hit, render it via the per-kind document renderer. Otherwise fall
   * back to the journal doc for the mapped URI kind (legacy slugs, daemon down,
   * or object not in the control-plane).
   *
   * Returns the rendered text plus `fromControlPlane`, which `stat` uses to make
   * a control-plane-resolved doc READ-ONLY (like `/document/<id>.md`) while a
   * journal-fallback doc keeps its per-kind permission behavior. Only invoked
   * when a control-plane client is present; without one these paths stay
   * synchronous (journal-rendered) — see `readFile` / `stat`.
   */
  private async renderKindMaybeControlPlane(
    controlPlaneKind: 'Topic' | 'Workstream' | 'TopicType' | 'Alert',
    slug: string,
    uri: vscode.Uri,
  ): Promise<{ text: string; fromControlPlane: boolean }> {
    const client = this.controlPlaneClient;
    if (client) {
      try {
        let result = await client.getDocument({
          slug,
          kind: controlPlaneKind,
        });
        // A deep-link identifier isn't always a live SLUG. A slugless
        // workstream is opened by the panel via `/document/<uuid>`, and
        // topic↔workstream attach can write that uuid into a topic's
        // `spec.workstreams`, so the topic-doc link becomes
        // `open/workstream/<uuid>`. The by-slug lookup then misses; retry by id
        // so the doc resolves instead of rendering the "not found" fallback.
        if (result.available && !result.document) {
          result = await client.getDocument({
            id: slug,
            kind: controlPlaneKind,
          });
        }
        if (result.available && result.document) {
          const doc = result.document;
          // Reverse-relation sections are resolved HERE and passed into the
          // pure per-kind renderer (the renderers never do I/O):
          //   - Topic       → `## Alerts`  (an Alert's `spec.topics` lists the
          //     topic slugs it concerns).
          //   - Workstream  → `## Topics`  (a Topic's `spec.workstreams` lists
          //     the workstream slugs it belongs to).
          //   - TopicType   → usage count + `## Recent topics` (a Topic's
          //     `spec.topicType` names its type id).
          let text: string;
          if (controlPlaneKind === 'Topic') {
            text = renderTopicDocument(doc, await this.topicAlerts(client, doc));
          } else if (controlPlaneKind === 'Workstream') {
            text = renderWorkstreamDocument(
              doc,
              await this.workstreamTopics(client, doc),
            );
          } else if (controlPlaneKind === 'TopicType') {
            text = renderTopicTypeDocument(
              doc,
              await this.topicTypeTopics(client, doc),
            );
          } else {
            text = renderDocumentByKind(doc);
          }
          return {
            text,
            fromControlPlane: true,
          };
        }
      } catch {
        // Fall through to the journal render on any control-plane error.
      }
    }
    const uriKind: DocKind =
      controlPlaneKind === 'Workstream'
        ? 'workstream'
        : controlPlaneKind === 'TopicType'
          ? 'topic-type'
          : controlPlaneKind === 'Alert'
            ? 'alert'
            : 'topic';
    return { text: this.render(uriKind, slug, uri), fromControlPlane: false };
  }

  /**
@@   * Resolve the alerts that concern a control-plane topic document. Alerts are a
   * reverse relation — an Alert's `spec.topics` array lists the topic slugs it
   * concerns — so they're read via `alertRead()` and matched against the topic's
   * slug here. CLOSED alerts are INCLUDED (so the topic doc can render their
   * Reopen actions); results are sorted newest-first by `updated_at`. Any
   * control-plane error degrades to an empty list so the topic doc still renders.
   */
  private async topicAlerts(
    client: ControlPlaneClient,
    doc: DocumentEnvelope,
  ): Promise<Alert[]> {
    const topicSlug = doc.metadata.slug;
    if (!topicSlug) {
      return [];
    }
    try {
      const alerts = await client.alertRead();
      return alerts
        .filter(
          (a) => Array.isArray(a.topics) && a.topics.includes(topicSlug),
        )
        .sort((a, b) => b.updated_at - a.updated_at);
    } catch {
      return [];
    }
  }

  /**
   * Resolve the topics that BELONG to a control-plane workstream document.
   * Membership is a reverse relation — a Topic's `spec.workstreams` array lists
   * the workstream slugs it belongs to — so topics are read via `topicRead()`
   * and matched against the workstream's slug here. The server-side `workstream`
   * filter is passed as a hint, but the result is ALSO filtered client-side so
   * the section is correct regardless of the daemon's filter behavior. Any
   * control-plane error degrades to an empty list so the workstream doc still
   * renders its metadata + spec.
   */
  private async workstreamTopics(
    client: ControlPlaneClient,
    doc: DocumentEnvelope,
  ): Promise<Topic[]> {
    const wsSlug = doc.metadata.slug;
    if (!wsSlug) {
      return [];
    }
    try {
      const topics = await client.topicRead({ workstream: wsSlug });
      return topics.filter(
        (t) => Array.isArray(t.workstreams) && t.workstreams.includes(wsSlug),
      );
    } catch {
      return [];
    }
  }

  /**
   * Resolve the topics that USE a control-plane topic-type document. Usage is a
   * reverse relation — a Topic's `spec.topicType` names its type id — so topics
   * are read via `topicRead()` and matched against the topic-type's id
   * (`doc.metadata.slug`, the human id like `feature`/`topic`) here. Used for
   * both the usage count and the `## Recent topics` list. Any control-plane
   * error degrades to an empty list so the topic-type doc still renders.
   */
  private async topicTypeTopics(
    client: ControlPlaneClient,
    doc: DocumentEnvelope,
  ): Promise<Topic[]> {
    const typeId = doc.metadata.slug;
    if (!typeId) {
      return [];
    }
    try {
      const topics = await client.topicRead({});
      return topics.filter((t) => t.topicType === typeId);
    } catch {
      return [];
    }
  }
  private journalPermission(kind: DocKind): vscode.FilePermission | undefined {
    return (kind === 'topic' ||
      kind === 'topic-type' ||
      kind === 'alert' ||
      kind === 'nanite') &&
      this.store
      ? undefined
      : vscode.FilePermission.Readonly;
  }

  writeFile(
    uri: vscode.Uri,
    content: Uint8Array,
    _options: { create: boolean; overwrite: boolean },
  ): void {
    const { kind, slug } = classifyUri(uri);
    if (
      (kind !== 'topic' && kind !== 'topic-type' && kind !== 'alert' &&
        kind !== 'nanite') ||
      !slug
    ) {
      throw vscode.FileSystemError.NoPermissions(uri);
    }
    if (!this.store) {
      throw vscode.FileSystemError.NoPermissions(uri);
    }
    const text = Buffer.from(content).toString('utf8');
    if (kind === 'alert') {
      const id = Number(slug);
      const alerts = new AlertsStore(this.store.connection);
      if (!Number.isInteger(id) || id <= 0 || !alerts.getAlert(id)) {
        throw vscode.FileSystemError.FileNotFound(uri);
      }
      const status = extractAlertStatus(text);
      const title = extractAlertTitle(text);
      const description = extractAlertDescription(text);
      const recommended_action = extractAlertRecommendedAction(text);
      const valid: AlertStatus[] = ['alert', 'informational', 'closed'];
      if (!valid.includes(status as AlertStatus)) {
        vscode.window.showErrorMessage(
          `Working Memory: status must be one of ${valid.join(', ')} — save aborted.`,
        );
        this.markChanged(uri);
        return;
      }
      if (!description.trim()) {
        vscode.window.showErrorMessage(
          'Working Memory: description must not be empty — save aborted.',
        );
        this.markChanged(uri);
        return;
      }
      alerts.updateAlert(id, {
        status: status as AlertStatus,
        title,
        description,
        recommended_action,
      });
      this.markChanged(uri);
      return;
    }
    if (kind === 'nanite') {
      const nanites = new NanitesStore(this.store.connection);
      if (!nanites.getNaniteBySlug(slug, true)) {
        throw vscode.FileSystemError.FileNotFound(uri);
      }
      const instructions = extractNaniteInstructions(text);
      if (!instructions.trim()) {
        vscode.window.showErrorMessage(
          'Working Memory: instructions must not be empty — save aborted.',
        );
        this.markChanged(uri);
        return;
      }
      nanites.updateNanite(slug, { instructions });
      this.markChanged(uri);
      return;
    }
    if (kind === 'topic') {
      // TODO (WM 13.0 "topic-consumer-repoint"): topic-body SAVE stays
      // journal-backed (DEFERRED). A control-plane-only topic has no journal row,
      // so this throws FileNotFound until the save is repointed; legacy journal
      // topics still save here as before.
      const topic = this.store.getTopic(slug);
      if (!topic) {
        throw vscode.FileSystemError.FileNotFound(uri);
      }
      const body = extractTopicBody(text);
      this.store.updateTopic(slug, { body });
    } else {
      // kind === 'topic-type'
      const topicType = this.store.getTopicType(slug);
      if (!topicType) {
        throw vscode.FileSystemError.FileNotFound(uri);
      }
      const body_template = extractTopicTypeBodyTemplate(text);
      const label = extractTopicTypeLabel(text);
      const description = extractTopicTypeDescription(text);
      if (!label.trim()) {
        vscode.window.showErrorMessage(
          'Working Memory: label must not be empty — save aborted.',
        );
        this.markChanged(uri);
        return;
      }
      if (!description.trim()) {
        vscode.window.showErrorMessage(
          'Working Memory: description must not be empty — save aborted.',
        );
        this.markChanged(uri);
        return;
      }
      this.store.updateTopicType(slug, { label, description, body_template });
    }
    this.markChanged(uri);
  }

  delete(uri: vscode.Uri): void {
    throw vscode.FileSystemError.NoPermissions(uri);
  }

  rename(uri: vscode.Uri): void {
    throw vscode.FileSystemError.NoPermissions(uri);
  }

  private render(kind: DocKind, slug: string, uri: vscode.Uri): string {
    if (!this.store) {
      return [
        `# Working Memory DB not available`,
        '',
        `Cannot render \`${uri.toString()}\` — no hub workspace is open.`,
        '',
        '_Tip: open the folder containing `AGENTS.md` and a `memory/`_',
        '_directory, then run "Working Memory: Reload Window"._',
        '',
      ].join('\n');
    }
    if (kind === 'workstream') {
      return enrichDeepLinks(this.store, renderWorkstreamDoc(this.store, slug));
    }
    if (kind === 'topic') {
      return enrichDeepLinks(this.store, renderTopicDoc(this.store, slug));
    }
    if (kind === 'topic-type') {
      return enrichDeepLinks(this.store, renderTopicTypeDoc(this.store, slug));
    }
    if (kind === 'session') {
      return enrichDeepLinks(this.store, renderSessionDoc(this.store, slug));
    }
    if (kind === 'alert') {
      return enrichDeepLinks(this.store, renderAlertDoc(this.store, slug));
    }
    if (kind === 'nanite') {
      return enrichDeepLinks(this.store, renderNaniteDoc(this.store, slug));
    }
    if (kind === 'nanite-run') {
      return enrichDeepLinks(this.store, renderNaniteRunDoc(this.store, slug));
    }
    return `# Unknown working-memory URI\n\n\`${uri.toString()}\``;
  }
}
