import * as vscode from 'vscode';
import {
  extractTopicBody,
  extractTopicTypeBodyTemplate,
  extractTopicTypeDescription,
  extractTopicTypeLabel,
} from './editableRegions';
import type {
  Alert,
  ControlPlaneClient,
  DocumentEnvelope,
  Topic,
  TopicType,
  Workstream,
} from './controlPlaneClient';
import {
  renderControlPlaneUnavailableDoc,
  renderDocumentNotFoundDoc,
} from './documentRenderer';
import { renderDocumentByKind } from './documentRenderers';
import { renderNaniteDocument } from './documentRenderers/nanite';
import { renderTopicDocument } from './documentRenderers/topic';
import type { TopicRelations } from './documentRenderers/topic';
import { buildFamilyTree } from './documentRenderers/family';
import { asStr, asStrArray } from './documentRenderers/shared';
import { renderWorkstreamDocument } from './documentRenderers/workstream';
import { renderTopicTypeDocument } from './documentRenderers/topictype';
import {
  DEEP_LINK_FALLBACK_ICON,
  enrichDeepLinks,
  type DeepLinkContext,
} from './documentRenderers/enrichDeepLinks';

/**
 * The control-plane data used to enrich deep-links in EVERY rendered doc plus
 * resolve a topic's `## Family` / `## Workstreams` sections. Fetched ONCE per
 * render (all topics + all topic-types + all workstreams) and threaded through
 * so we never double-fetch: the same `topics`/`workstreams` power the family
 * tree AND the deep-link icon/count adjacency in `ctx`.
 */
interface EnrichmentData {
  topics: Topic[];
  workstreams: Workstream[];
  ctx: DeepLinkContext;
}

type DocKind =
  | 'workstream'
  | 'topic'
  | 'topic-type'
  | 'alert'
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
  if (p.startsWith('/alert/') && p.endsWith('.md')) {
    const id = p.slice('/alert/'.length, p.length - '.md'.length);
    return { kind: 'alert', slug: id || null };
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
 * URI DocKind → control-plane document kind name. Every supported kind maps —
 * the extension runs PURELY on the control plane; there is no journal fallback.
 */
const CONTROL_PLANE_KIND: Record<
  Exclude<DocKind, 'document' | 'unknown'>,
  'Topic' | 'Workstream' | 'TopicType' | 'Alert'
> = {
  topic: 'Topic',
  workstream: 'Workstream',
  'topic-type': 'TopicType',
  alert: 'Alert',
};

/**
 * `FileSystemProvider` for the `working-memory:` scheme. Every virtual doc is
 * rendered from the control-plane document store — there is no journal DB.
 * `topic` and `topic-type` docs are writable (on save the editable regions are
 * parsed and persisted via `ws-topic-update` / `ws-topictype-update`);
 * `workstream`, `alert`, and `document` docs are read-only. When no
 * control-plane client is wired in (or the daemon is unreachable) every doc
 * renders a "control plane not running" body and writes are rejected.
 */
export class WorkstreamDocumentProvider implements vscode.FileSystemProvider {
  public static readonly scheme = 'working-memory';

  private readonly _onDidChangeFile = new vscode.EventEmitter<
    vscode.FileChangeEvent[]
  >();
  readonly onDidChangeFile = this._onDidChangeFile.event;

  private readonly knownUris = new Set<string>();
  private readonly mtimes = new Map<string, number>();

  /**
   * Control-plane MCP client used to render every virtual doc. Optional: when
   * null (daemon not yet discovered / no hub), docs render an "unavailable"
   * body and are read-only.
   */
  private controlPlaneClient: ControlPlaneClient | null = null;

  /** Inject the control-plane MCP client. */
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
    if (kind === 'unknown') {
      throw vscode.FileSystemError.FileNotFound(uri);
    }
    const cpKind = CONTROL_PLANE_KIND[kind];
    return this.renderKindControlPlane(cpKind, slug).then(
      ({ text, permission }) => ({
        type: vscode.FileType.File,
        ctime: mtime,
        mtime,
        size: Buffer.byteLength(text, 'utf8'),
        permissions: permission,
      }),
    );
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
    if (kind === 'unknown') {
      throw vscode.FileSystemError.FileNotFound(uri);
    }
    const cpKind = CONTROL_PLANE_KIND[kind];
    return this.renderKindControlPlane(cpKind, slug).then(({ text }) =>
      Buffer.from(text, 'utf8'),
    );
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
    // Nanites render a precise "why is this pending" status, which needs the
    // OWNING template's approval policy — fetch it best-effort and pass it in.
    if (result.document.kind === 'Nanite') {
      const templateId = asStr(result.document.spec?.templateId);
      let allowRunWithoutHuman = false;
      if (templateId) {
        try {
          const [tpl] = await this.controlPlaneClient.naniteTemplateRead({ slug: templateId });
          const template =
            tpl ?? (await this.controlPlaneClient.naniteTemplateRead({ id: templateId }))[0];
          allowRunWithoutHuman = template?.allowRunWithoutHuman === true;
        } catch {
          // best-effort — fall back to the approval-required wording
        }
      }
      return renderNaniteDocument(result.document, { allowRunWithoutHuman });
    }
    return renderDocumentByKind(result.document);
  }

  /**
   * Render a control-plane virtual doc for the mapped kind. A found document
   * renders via the per-kind renderer; a missing one renders "not found"; a
   * dead/absent daemon (or no client) renders "unavailable".
   *
   * Returns the rendered text plus the doc `permission`: topic + topic-type
   * bodies are editable (saved via `ws-topic-update` / `ws-topictype-update`);
   * every other case is read-only. Reverse-relation sections (topic `## Alerts`,
   * workstream `## Topics`, topic-type usage) are resolved here and passed into
   * the pure per-kind renderers (which never do I/O).
   */
  private async renderKindControlPlane(
    controlPlaneKind: 'Topic' | 'Workstream' | 'TopicType' | 'Alert',
    slug: string,
  ): Promise<{ text: string; permission: vscode.FilePermission | undefined }> {
    const client = this.controlPlaneClient;
    const readonly = vscode.FilePermission.Readonly;

    if (!client) {
      // No client → every kind renders "unavailable", read-only.
      return {
        text: renderControlPlaneUnavailableDoc(slug),
        permission: readonly,
      };
    }

    try {
      let result = await client.getDocument({ slug, kind: controlPlaneKind });
      // A deep-link identifier isn't always a live SLUG (a slugless workstream
      // is opened by uuid, and that uuid can land in a topic's
      // `spec.workstreams`), so retry by id before giving up.
      if (result.available && !result.document) {
        result = await client.getDocument({ id: slug, kind: controlPlaneKind });
      }
      if (result.available && result.document) {
        const doc = result.document;
        // Fetch the enrichment data ONCE (all topics / topic-types /
        // workstreams). It powers both the topic `## Family` tree and the
        // deep-link icon/count post-pass applied to every kind below.
        const enrichment = await this.buildEnrichmentData(client);
        let text: string;
        if (controlPlaneKind === 'Topic') {
          text = renderTopicDocument(
            doc,
            await this.topicAlerts(client, doc),
            this.topicFamily(doc, enrichment),
          );
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
        // Post-pass: rewrite deep-links with a leading type codicon + `(N)`
        // child-count (WM 13.0.2 `feature-friendly-wm-links`). Pure + applied
        // to the FINAL markdown for all kinds; alert links / fenced code are
        // left untouched by the pass itself.
        text = enrichDeepLinks(text, enrichment.ctx);
        const editable =
          controlPlaneKind === 'Topic' || controlPlaneKind === 'TopicType';
        return { text, permission: editable ? undefined : readonly };
      }
      // Reached the control plane, but no such document.
      return { text: renderDocumentNotFoundDoc(slug), permission: readonly };
    } catch {
      // Control-plane error (daemon down / dropped connection).
      return {
        text: renderControlPlaneUnavailableDoc(slug),
        permission: readonly,
      };
    }
  }

  /**
   * Resolve the alerts that concern a control-plane topic document. Alerts are a
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
   * Fetch the control-plane data every render needs — ALL topics, topic-types,
   * and workstreams — ONCE, and build the {@link DeepLinkContext} adjacency from
   * it (topic→child count via reverse `parents`, workstream→topic count, and the
   * topic-type slug→icon / topic slug→topic-type maps for icons). The raw
   * `topics` + `workstreams` are returned alongside so `topicFamily` reuses them
   * instead of re-fetching. Each fetch is guarded independently: a missing
   * client method or a control-plane error degrades that slice to empty, so the
   * context still resolves (fallback icon, zero counts) and enrichment never
   * throws. Perf note: this is a fetch-all on EVERY doc render — fine at current
   * corpus size; revisit with a server-side adjacency endpoint if it grows.
   */
  private async buildEnrichmentData(
    client: ControlPlaneClient,
  ): Promise<EnrichmentData> {
    let topics: Topic[] = [];
    let topicTypes: TopicType[] = [];
    let workstreams: Workstream[] = [];
    try {
      topics = await client.topicRead({});
    } catch {
      topics = [];
    }
    try {
      topicTypes = await client.topicTypeRead({});
    } catch {
      topicTypes = [];
    }
    try {
      workstreams = await client.wsRead({});
    } catch {
      workstreams = [];
    }

    const iconByType = new Map<string, string>();
    for (const tt of topicTypes) {
      const key = tt.slug ?? tt.id;
      if (key && tt.icon) {
        iconByType.set(key, tt.icon);
      }
    }
    const typeByTopic = new Map<string, string>();
    const childCount = new Map<string, number>();
    const wsTopicCount = new Map<string, number>();
    for (const t of topics) {
      const key = t.slug ?? t.id;
      if (key && t.topicType) {
        typeByTopic.set(key, t.topicType);
      }
      for (const parent of Array.isArray(t.parents) ? t.parents : []) {
        childCount.set(parent, (childCount.get(parent) ?? 0) + 1);
      }
      for (const ws of Array.isArray(t.workstreams) ? t.workstreams : []) {
        wsTopicCount.set(ws, (wsTopicCount.get(ws) ?? 0) + 1);
      }
    }

    const ctx: DeepLinkContext = {
      topicTypeIcon: (slug) => iconByType.get(slug) ?? DEEP_LINK_FALLBACK_ICON,
      topicTypeOf: (slug) => typeByTopic.get(slug) ?? null,
      topicChildCount: (slug) => childCount.get(slug) ?? 0,
      workstreamTopicCount: (slug) => wsTopicCount.get(slug) ?? 0,
    };

    return { topics, workstreams, ctx };
  }

  /**
   * Resolve a control-plane topic's `## Family` tree + friendly `## Workstreams`
   * links (WM 13.0.2 `feature-family-tree-display`). Both are cross-document
   * relations the topic envelope can't carry, so they're resolved from the
   * already-fetched {@link EnrichmentData} (no I/O here — the fetch happened once
   * in `buildEnrichmentData`):
   *   - Family: reduce ALL topics to slug/title/parents triples and let
   *     `buildFamilyTree` walk parents upward (bounded) and the reverse
   *     parent→child adjacency downward (cycle + depth guarded).
   *   - Workstreams: resolve each `spec.workstreams` slug to its title via the
   *     prefetched workstream list so the links read as human titles, not slugs.
   * Missing data degrades gracefully: an empty family (renderer falls back to a
   * single-node tree) and slug-labeled workstream links.
   */
  private topicFamily(
    doc: DocumentEnvelope,
    enrichment: EnrichmentData,
  ): TopicRelations {
    const spec = doc.spec ?? {};
    const slug = doc.metadata.slug;
    const title = asStr(spec.title) ?? slug ?? doc.metadata.id;
    const wsSlugs = asStrArray(spec.workstreams);

    // Default (degraded) workstream links use the slug as the label.
    let workstreams = wsSlugs.map((s) => ({ slug: s, title: s }));
    let family: TopicRelations['family'] = [];

    if (!slug) {
      return { family, workstreams };
    }

    const familyTopics = enrichment.topics.map((t) => ({
      slug: t.slug ?? t.id,
      title: t.title,
      parents: Array.isArray(t.parents) ? t.parents : [],
    }));
    family = buildFamilyTree(slug, title, familyTopics, asStrArray(spec.parents));

    if (wsSlugs.length > 0) {
      const titleBySlug = new Map<string, string>();
      for (const w of enrichment.workstreams) {
        if (w.slug) {
          titleBySlug.set(w.slug, w.title);
        }
      }
      workstreams = wsSlugs.map((s) => ({
        slug: s,
        title: titleBySlug.get(s) ?? s,
      }));
    }

    return { family, workstreams };
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

  async writeFile(
    uri: vscode.Uri,
    content: Uint8Array,
    _options: { create: boolean; overwrite: boolean },
  ): Promise<void> {
    const { kind, slug } = classifyUri(uri);
    if ((kind !== 'topic' && kind !== 'topic-type') || !slug) {
      throw vscode.FileSystemError.NoPermissions(uri);
    }
    const text = Buffer.from(content).toString('utf8');

    // `topic` and `topic-type` bodies save via `ws-topic-update` /
    // `ws-topictype-update`. Offline (no client) → the doc is read-only, so a
    // save is NoPermissions; an unknown slug is FileNotFound.
    const client = this.controlPlaneClient;
    if (!client) {
      throw vscode.FileSystemError.NoPermissions(uri);
    }

    if (kind === 'topic') {
      let exists = false;
      try {
        exists = (await client.topicRead({ slug })).length > 0;
      } catch {
        throw vscode.FileSystemError.NoPermissions(uri);
      }
      if (!exists) {
        throw vscode.FileSystemError.FileNotFound(uri);
      }
      const body = extractTopicBody(text);
      try {
        await client.topicUpdate({ slug, body });
      } catch (err) {
        vscode.window.showErrorMessage(
          `Working Memory: could not save topic — ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
      }
      this.markChanged(uri);
      return;
    }

    // kind === 'topic-type'
    let exists = false;
    try {
      exists = (await client.topicTypeRead({ slug })).length > 0;
    } catch {
      throw vscode.FileSystemError.NoPermissions(uri);
    }
    if (!exists) {
      throw vscode.FileSystemError.FileNotFound(uri);
    }
    const label = extractTopicTypeLabel(text);
    const description = extractTopicTypeDescription(text);
    const body_template = extractTopicTypeBodyTemplate(text);
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
    try {
      await client.topicTypeUpdate({
        slug,
        label,
        description,
        body_template,
      });
    } catch (err) {
      vscode.window.showErrorMessage(
        `Working Memory: could not save topic type — ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
    this.markChanged(uri);
  }

  delete(uri: vscode.Uri): void {
    throw vscode.FileSystemError.NoPermissions(uri);
  }

  rename(uri: vscode.Uri): void {
    throw vscode.FileSystemError.NoPermissions(uri);
  }
}
