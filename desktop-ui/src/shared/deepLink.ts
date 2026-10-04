import type { DesktopResourceKind } from './contracts';

export const WORKING_MEMORY_PROTOCOL = 'working-memory';

const RESOURCE_KINDS = new Set<DesktopResourceKind>([
  'workstream',
  'topic',
  'document',
  'alert',
  'topic-type',
]);

export interface DesktopDeepLinkTarget {
  kind: DesktopResourceKind;
  identifier: string;
}

export function desktopDeepLink(
  kind: DesktopResourceKind,
  identifier: string,
): string {
  return `${WORKING_MEMORY_PROTOCOL}://open/${kind}/${encodeURIComponent(identifier)}`;
}

export function parseDesktopDeepLink(raw: string): DesktopDeepLinkTarget | null {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }

  if (
    url.protocol !== `${WORKING_MEMORY_PROTOCOL}:`
    || url.hostname !== 'open'
    || url.search
    || url.hash
  ) {
    return null;
  }
  const match = /^\/([^/]+)\/([^/]+)$/.exec(url.pathname);
  if (!match || !RESOURCE_KINDS.has(match[1] as DesktopResourceKind)) return null;
  try {
    const identifier = decodeURIComponent(match[2]);
    return identifier
      ? { kind: match[1] as DesktopResourceKind, identifier }
      : null;
  } catch {
    return null;
  }
}
