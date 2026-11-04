import type { DesktopResourceKind } from './contracts';

export const WORKING_MEMORY_PROTOCOL = 'working-memory';

const RESOURCE_KINDS = new Set<DesktopResourceKind>([
  'workstream',
  'topic',
  'document',
  'alert',
  'agent-message',
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
    || url.username
    || url.password
    || url.port
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
      ? { kind: match[1] === 'alert' ? 'agent-message' : match[1] as DesktopResourceKind, identifier }
      : null;
  } catch {
    return null;
  }
}

/** Resolve authored resource links locally, including historical bridge links. */
export function parseDesktopResourceLink(raw: string): DesktopDeepLinkTarget | null {
  const native = parseDesktopDeepLink(raw);
  if (native) return native;
  let url: URL;
  try {
    url = new URL(raw, 'working-memory://local');
  } catch {
    return null;
  }
  if (url.username || url.password || url.search || url.hash) return null;
  let path: string;
  if ((url.protocol === 'http:' && ['127.0.0.1', 'localhost'].includes(url.hostname) && url.port === '7718')
    || (url.protocol === 'vscode:' && url.hostname === 'kubarycz.working-memory')) {
    if (!url.pathname.startsWith('/open/')) return null;
    path = url.pathname.slice('/open'.length);
  } else if (url.protocol === 'working-memory:') {
    path = url.hostname && url.hostname !== 'local'
      ? `/${url.hostname}${url.pathname}` : url.pathname;
    if (!path.endsWith('.working-memory')) return null;
    path = path.slice(0, -'.working-memory'.length);
  } else return null;
  const match = /^\/([^/]+)\/([^/]+)$/.exec(path);
  if (!match || !RESOURCE_KINDS.has(match[1] as DesktopResourceKind)) return null;
  try {
    const identifier = decodeURIComponent(match[2]);
    return identifier ? {
      kind: match[1] === 'alert' ? 'agent-message' : match[1] as DesktopResourceKind,
      identifier,
    } : null;
  } catch {
    return null;
  }
}
