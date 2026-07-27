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
import type { ControlPlaneClient } from './controlPlaneClient';
import {
  renderControlPlaneUnavailableDoc,
  renderDocumentEnvelopeDoc,
  renderDocumentNotFoundDoc,
} from './documentRenderer';

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
    if (kind === 'topic' && this.controlPlaneClient) {
      // WM 13.0 "topic-consumer-repoint": a topic body may resolve from the
      // control-plane (async). A control-plane-resolved doc is READ-ONLY (like
      // `/document/<id>.md`); a journal-fallback doc keeps its writable behavior
      // when a journal store is present.
      // TODO: editable-body SAVE of a control-plane-only topic is DEFERRED — the
      // writeFile topic branch is journal-only, so saving such a doc throws
      // FileNotFound until the topic-body save is repointed onto the
      // control-plane.
      return this.renderTopicMaybeControlPlane(slug, uri).then(
        ({ text, fromControlPlane }) => ({
          type: vscode.FileType.File,
          ctime: mtime,
          mtime,
          size: Buffer.byteLength(text, 'utf8'),
          permissions:
            fromControlPlane || !this.store
              ? vscode.FilePermission.Readonly
              : undefined,
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
    if (kind === 'topic' && this.controlPlaneClient) {
      // WM 13.0 "topic-consumer-repoint": prefer the control-plane topic (async).
      return this.renderTopicMaybeControlPlane(slug, uri).then(({ text }) =>
        Buffer.from(text, 'utf8'),
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
    return renderDocumentEnvelopeDoc(result.document);
  }

  /**
   * Render a `working-memory:/topic/<slug>.md` body, preferring the control-plane
   * topic (WM 13.0 "topic-consumer-repoint") and falling back to the journal
   * topic doc for legacy slugs or when the daemon is down / the topic isn't in
   * the control-plane. Resolution goes through the canonical topic domain read
   * (`ws-topic-read`) to decide whether the slug is a control-plane topic, then
   * fetches THAT topic's envelope by id for the shared document-envelope
   * renderer.
   *
   * Returns the rendered text plus `fromControlPlane`, which `stat` uses to make
   * a control-plane-resolved doc READ-ONLY (like `/document/<id>.md`) while a
   * journal-fallback doc keeps its writable behavior. Only invoked when a
   * control-plane client is present; without one the topic path stays
   * synchronous (journal-rendered) — see `readFile` / `stat`.
   */
  private async renderTopicMaybeControlPlane(
    slug: string,
    uri: vscode.Uri,
  ): Promise<{ text: string; fromControlPlane: boolean }> {
    const client = this.controlPlaneClient;
    if (client) {
      try {
        const topics = await client.topicRead({ slug });
        const topic = topics[0];
        if (topic && typeof topic.id === 'string') {
          const result = await client.getDocument({ id: topic.id });
          if (result.available && result.document) {
            return {
              text: renderDocumentEnvelopeDoc(result.document),
              fromControlPlane: true,
            };
          }
        }
      } catch {
        // Fall through to the journal render on any control-plane error.
      }
    }
    return { text: this.render('topic', slug, uri), fromControlPlane: false };
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
