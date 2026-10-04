import type { PreparedResourceDrag } from '../shared/contracts';

const RESOURCE_URI_RE =
  /^working-memory:\/(?:\/)?(workstream|topic|document|alert|topic-type)\/([^/]+)\.working-memory$/;

export interface ResourceDragLink {
  href: string;
  markdown: string;
}

export const WORKING_MEMORY_REFERENCE_MIME =
  'application/vnd.kubarycz.working-memory+json';

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
