import type {
  ContainerAppResourceReference,
  PreparedResourceDrag,
} from '../shared/contracts';
import type { WorkstreamSection } from '../../../shared/panelData';
import type { TopicDragSource } from './topicTransfer';

export type ActiveResourceDrag =
  | ({ kind: 'topic' } & TopicDragSource)
  | { kind: 'workstream'; id: string; section: WorkstreamSection };

const RESOURCE_URI_RE =
  /^working-memory:\/(?:\/)?(workstream|topic|document|agent-message|alert|topic-type)\/([^/]+)\.working-memory$/;

export interface ResourceDragLink {
  href: string;
  markdown: string;
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
