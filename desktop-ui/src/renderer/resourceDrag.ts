import type {
  ContainerAppResourceReference,
  DesktopApi,
  PreparedResourceDrag,
} from '../shared/contracts';
import type { WorkstreamSection } from '../../../shared/panelData';
import type { TopicDragSource } from './topicTransfer';

export type ActiveResourceDrag = (
  | ({ kind: 'topic' } & TopicDragSource)
  | { kind: 'workstream'; id: string; section: WorkstreamSection }
) & { native?: boolean };

export function topicDropMoves(event: Pick<DragEvent, 'altKey' | 'ctrlKey' | 'metaKey'>): boolean {
  return !(event.altKey || event.ctrlKey || event.metaKey);
}

export function resourceDropEffect(
  drag: ActiveResourceDrag | null,
  intended: 'copy' | 'move',
): 'copy' | 'move' {
  // Electron's Windows native file source allows copy/link, not move.
  return drag?.native ? 'copy' : intended;
}

const RESOURCE_URI_RE =
  /^working-memory:\/(?:\/)?(workstream|topic|document|agent-message|alert|topic-type)\/([^/]+)\.working-memory$/;

export interface ResourceDragLink {
  href: string;
  markdown: string;
}

export interface TopicLinkReference {
  id: string;
  title: string;
}

export class TopicLinkDragController {
  private cache: ResourceDragPreparationCache;
  private owned: ActiveResourceDrag | null = null;
  private nativeFile: string | null = null;

  constructor(
    private api: Pick<DesktopApi, 'prepareResourceDrag' | 'startResourceDrag' | 'onResourceDragResult'>,
    private current: () => ActiveResourceDrag | null,
    private update: (drag: ActiveResourceDrag | null) => void,
    private onError: (message: string) => void,
  ) {
    this.cache = new ResourceDragPreparationCache(
      (uri, title) => api.prepareResourceDrag(uri, title),
      error => onError(`Unable to prepare drag context: ${error instanceof Error ? error.message : String(error)}`),
    );
  }
  private uri(id: string): string {
    return `working-memory:/topic/${encodeURIComponent(id)}.working-memory`;
  }
  prepare(id: string, title: string): void {
    this.cache.prepare(this.uri(id), title);
  }
  clear(): void { this.cache.clear(); }
  get native(): boolean { return this.nativeFile !== null; }
  listen(): () => void {
    return this.api.onResourceDragResult(result => {
      if (result.filePath !== this.nativeFile || result.status !== 'failed') return;
      this.finish();
      this.onError(`Unable to drag Working Memory context: ${result.error ?? 'Native drag failed.'}`);
    });
  }
  start(event: DragEvent, id: string, title: string, sourceWorkstream = ''): void {
    event.stopPropagation();
    const uri = this.uri(id);
    const prepared = this.cache.get(uri);
    event.dataTransfer?.clearData();
    if (!setResourceDragData(event.dataTransfer, uri, title, prepared)) {
      event.preventDefault();
      this.onError('Unable to drag this Working Memory link.');
      return;
    }
    this.owned = { kind: 'topic', id, sourceWorkstream, ...(prepared ? { native: true } : {}) };
    this.update(this.owned);
    this.owned = this.current();
    if (sourceWorkstream && event.dataTransfer) event.dataTransfer.effectAllowed = 'copyMove';
    if (!prepared) return;
    event.preventDefault();
    this.nativeFile = prepared.filePath;
    this.api.startResourceDrag(prepared);
  }
  finish(): void {
    if (this.owned && this.current() === this.owned) this.update(null);
    this.owned = null;
    this.nativeFile = null;
  }
  dispose(): void { this.clear(); this.finish(); }
}

export class ResourceDragPreparationCache {
  private readonly prepared = new Map<string, PreparedResourceDrag>();
  private readonly pending = new Map<string, number>();
  private generation = 0;

  constructor(
    private readonly prepareContext: (openUri: string, label: string) => Promise<PreparedResourceDrag>,
    private readonly onError: (error: unknown) => void,
  ) {}

  get(openUri: string): PreparedResourceDrag | undefined {
    return this.prepared.get(openUri);
  }

  prepare(openUri: string, label: string): void {
    const generation = this.generation;
    if (this.prepared.has(openUri) || this.pending.get(openUri) === generation) return;
    this.pending.set(openUri, generation);
    void this.prepareContext(openUri, label)
      .then(prepared => {
        if (generation === this.generation) this.prepared.set(openUri, prepared);
      })
      .catch(error => {
        if (generation === this.generation) this.onError(error);
      })
      .finally(() => {
        if (this.pending.get(openUri) === generation) this.pending.delete(openUri);
      });
  }

  clear(): void {
    this.generation++;
    this.prepared.clear();
    this.pending.clear();
  }
}

export const WORKING_MEMORY_REFERENCE_MIME =
  'application/vnd.kubarycz.working-memory+json';
export const CONTAINER_APP_RESOURCE_MIME =
  'application/vnd.kubarycz.container-app-resource+json';

function escapeMarkdownLabel(label: string): string {
  return label.replace(/[\\[\]]/g, '\\$&');
}

export function resourceDragLink(openUri: string, label: string): ResourceDragLink | null {
  const match = RESOURCE_URI_RE.exec(openUri);
  if (!match) return null;
  const [, kind, id] = match;
  const href = `http://127.0.0.1:7718/open/${kind}/${id}`;
  return {
    href,
    markdown: `[${escapeMarkdownLabel(label)}](${href})`,
  };
}

export function setResourceDragData(
  dataTransfer: DataTransfer | null,
  openUri: string,
  label: string,
  prepared?: PreparedResourceDrag,
): boolean {
  const link = resourceDragLink(openUri, label);
  if (!dataTransfer || !link) return false;
  dataTransfer.effectAllowed = 'copy';
  dataTransfer.setData('text/plain', link.markdown);
  dataTransfer.setData('text/markdown', link.markdown);
  if (prepared) {
    dataTransfer.setData('text/uri-list', prepared.fileUrl);
    dataTransfer.setData(
      'DownloadURL',
      `text/markdown:${prepared.filename}:${prepared.fileUrl}`,
    );
  }
  dataTransfer.setData(WORKING_MEMORY_REFERENCE_MIME, JSON.stringify({
    version: 1,
    title: label,
    href: link.href,
    ...(prepared ? { uri: prepared.fileUrl } : {}),
  }));
  return true;
}

export function parseContainerAppResourceReference(
  value: string,
): ContainerAppResourceReference | null {
  try {
    const reference = JSON.parse(value) as Record<string, unknown>;
    if (
      (reference.version !== 1 && reference.version !== 2)
      || typeof reference.appId !== 'string'
      || !reference.appId.trim()
      || typeof reference.resourceKind !== 'string'
      || !reference.resourceKind.trim()
      || typeof reference.resourceId !== 'string'
      || !reference.resourceId.trim()
      || typeof reference.title !== 'string'
      || !reference.title.trim()
      || typeof reference.deepLink !== 'string'
    ) return null;
    const deepLink = new URL(reference.deepLink);
    if (
      deepLink.protocol !== 'http:'
      || (deepLink.hostname !== '127.0.0.1' && deepLink.hostname !== 'localhost')
    ) return null;
    const preview = reference.version === 2
      ? parseResourcePreview(reference.preview)
      : undefined;
    if (reference.version === 2 && reference.preview !== undefined && !preview) return null;
    const legacyMarkdown = typeof reference.markdown === 'string' && reference.markdown.trim()
      ? reference.markdown
      : undefined;
    const context = parseResourceContext(reference.context, legacyMarkdown);
    if (reference.context !== undefined && !context) return null;
    return {
      version: 2,
      appId: reference.appId,
      resourceKind: reference.resourceKind,
      resourceId: reference.resourceId,
      title: reference.title,
      deepLink: deepLink.toString(),
      ...(preview ? { preview } : {}),
      ...(context ? { context } : {}),
    };
  } catch {
    return null;
  }
}

export function containerAppResourceMarkdown(reference: ContainerAppResourceReference): string {
  return `[${escapeMarkdownLabel(containerAppResourceLabel(reference))}](${reference.deepLink})`;
}

export function containerAppResourceLabel(reference: ContainerAppResourceReference): string {
  const values = [
    reference.preview?.date,
    reference.preview?.description ?? reference.title,
    reference.preview?.amount,
    ...(reference.preview?.details ?? []).map(({ label, value }) => `${label}: ${value}`),
  ].filter((value, index, entries): value is string =>
    Boolean(value?.trim()) && entries.indexOf(value) === index);
  return values.join(' · ') || reference.title;
}

export function composeContainerAppResourceMessage(
  message: string,
  references: ContainerAppResourceReference[],
): string {
  return [
    message.trim(),
    ...references.map((reference) =>
      `@${reference.appId} ${containerAppResourceMarkdown(reference)}`),
  ].filter(Boolean).join('\n\n');
}

export function setContainerAppResourceDragData(
  dataTransfer: DataTransfer,
  reference: ContainerAppResourceReference,
): void {
  const markdown = containerAppResourceMarkdown(reference);
  dataTransfer.effectAllowed = 'copy';
  dataTransfer.setData(CONTAINER_APP_RESOURCE_MIME, JSON.stringify(reference));
  dataTransfer.setData('text/plain', markdown);
  dataTransfer.setData('text/markdown', markdown);
  dataTransfer.setData('text/uri-list', reference.deepLink);
}

function parseResourcePreview(value: unknown): ContainerAppResourceReference['preview'] | undefined {
  if (value === undefined) return undefined;
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const candidate = value as Record<string, unknown>;
  const stringField = (name: string): string | undefined => {
    const field = candidate[name];
    return typeof field === 'string' && field.trim() ? field.trim() : undefined;
  };
  let details: Array<{ label: string; value: string }> | undefined;
  if (candidate.details !== undefined) {
    if (!Array.isArray(candidate.details) || candidate.details.length > 12) return undefined;
    details = [];
    for (const detail of candidate.details) {
      if (!detail || typeof detail !== 'object' || Array.isArray(detail)) return undefined;
      const { label, value: detailValue } = detail as Record<string, unknown>;
      if (typeof label !== 'string' || !label.trim()
        || typeof detailValue !== 'string' || !detailValue.trim()) return undefined;
      details.push({ label: label.trim(), value: detailValue.trim() });
    }
  }
  const preview = {
    ...(stringField('date') ? { date: stringField('date') } : {}),
    ...(stringField('description') ? { description: stringField('description') } : {}),
    ...(stringField('amount') ? { amount: stringField('amount') } : {}),
    ...(details?.length ? { details } : {}),
  };
  return Object.keys(preview).length ? preview : undefined;
}

function parseResourceContext(
  value: unknown,
  legacyMarkdown: string | undefined,
): ContainerAppResourceReference['context'] | undefined {
  if (legacyMarkdown) return { markdown: legacyMarkdown };
  if (value === undefined) return undefined;
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const markdown = (value as Record<string, unknown>).markdown;
  return typeof markdown === 'string' && markdown.trim()
    ? { markdown: markdown.trim() }
    : undefined;
}
