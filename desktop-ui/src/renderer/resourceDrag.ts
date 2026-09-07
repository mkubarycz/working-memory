const RESOURCE_URI_RE =
  /^working-memory:\/(?:\/)?(workstream|topic|document|alert|topic-type)\/([^/]+)\.working-memory$/;

export interface ResourceDragLink {
  href: string;
  markdown: string;
}

function escapeMarkdownLabel(label: string): string {
  return label.replace(/[\\[\]]/g, '\\$&');
}

export function resourceDragLink(openUri: string, label: string): ResourceDragLink | null {
  const match = RESOURCE_URI_RE.exec(openUri);
  if (!match) return null;
  const href = `vscode://kubarycz.working-memory/open/${match[1]}/${match[2]}`;
  return { href, markdown: `[${escapeMarkdownLabel(label)}](${href})` };
}

export function setResourceDragData(
  dataTransfer: DataTransfer | null,
  openUri: string,
  label: string,
): boolean {
  const link = resourceDragLink(openUri, label);
  if (!dataTransfer || !link) return false;
  dataTransfer.effectAllowed = 'copy';
  dataTransfer.setData('text/plain', link.markdown);
  dataTransfer.setData('text/markdown', link.markdown);
  return true;
}