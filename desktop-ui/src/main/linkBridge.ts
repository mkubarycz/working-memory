import { randomBytes } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import type { DesktopDeepLinkTarget } from '../shared/deepLink';
import type { DesktopResourceKind } from '../shared/contracts';

export const DESKTOP_LINK_HOST = '127.0.0.1';
export const DESKTOP_LINK_PORT = 7718;
const POST_RESPONSE_FOCUS_DELAY_MS = 250;

const RESOURCE_KINDS = new Set<DesktopResourceKind>([
  'workstream',
  'topic',
  'document',
  'alert',
  'topic-type',
]);

export function desktopHttpLink(
  kind: DesktopResourceKind,
  identifier: string,
): string {
  return `http://${DESKTOP_LINK_HOST}:${DESKTOP_LINK_PORT}/open/${kind}/${encodeURIComponent(identifier)}`;
}

export function parseDesktopHttpPath(rawUrl: string): DesktopDeepLinkTarget | null {
  let url: URL;
  try {
    url = new URL(rawUrl, `http://${DESKTOP_LINK_HOST}:${DESKTOP_LINK_PORT}`);
  } catch {
    return null;
  }
  if (url.search || url.hash) return null;
  const match = /^\/open\/([^/]+)\/([^/]+)$/.exec(url.pathname);
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

export class DesktopLinkBridge {
  private server: Server | null = null;
  private boundPort: number | null = null;

  constructor(
    private readonly onOpen: (target: DesktopDeepLinkTarget) => void | Promise<void>,
    private readonly port = DESKTOP_LINK_PORT,
    private readonly onResponseFinished?: () => void | Promise<void>,
  ) {}

  start(): Promise<number> {
    if (this.server) throw new Error('Desktop link bridge is already running');
    const server = createServer(async (request, response) => {
      const allowedHosts = new Set([
        `${DESKTOP_LINK_HOST}:${this.boundPort ?? this.port}`,
        `localhost:${this.boundPort ?? this.port}`,
      ]);
      if (!request.headers.host || !allowedHosts.has(request.headers.host)) {
        response.writeHead(400, { 'Content-Type': 'text/plain; charset=utf-8' });
        response.end('Invalid Working Memory link host.');
        return;
      }
      if (request.method !== 'GET') {
        response.writeHead(405, {
          Allow: 'GET',
          'Content-Type': 'text/plain; charset=utf-8',
        });
        response.end('Only GET is supported.');
        return;
      }
      const target = parseDesktopHttpPath(request.url ?? '');
      if (!target) {
        response.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
        response.end('Working Memory resource link not found.');
        return;
      }
      try {
        await this.onOpen(target);
        const nonce = randomBytes(18).toString('base64');
        response.writeHead(200, {
          'Cache-Control': 'no-store',
          'Content-Security-Policy': `default-src 'none'; script-src 'nonce-${nonce}'`,
          'Content-Type': 'text/html; charset=utf-8',
          'X-Content-Type-Options': 'nosniff',
        });
        if (this.onResponseFinished) {
          response.once('finish', () => {
            const timer = setTimeout(() => {
              void Promise.resolve(this.onResponseFinished?.()).catch((error) => {
                console.error('[desktop] Unable to focus Working Memory after link response:', error);
              });
            }, POST_RESPONSE_FOCUS_DELAY_MS);
            timer.unref();
          });
        }
        response.end([
          '<!doctype html>',
          '<html lang="en">',
          '<head><meta charset="utf-8"><title>Working Memory</title></head>',
          '<body>',
          '<p>Opened in the Working Memory desktop app. You can close this page if it remains open.</p>',
          `<script nonce="${nonce}">window.close();setTimeout(()=>window.close(),150);</script>`,
          '</body>',
          '</html>',
        ].join(''));
      } catch (error) {
        console.error('[desktop] Unable to open Working Memory link:', error);
        response.writeHead(500, {
          'Cache-Control': 'no-store',
          'Content-Type': 'text/plain; charset=utf-8',
          'X-Content-Type-Options': 'nosniff',
        });
        response.end('Unable to open this resource in the Working Memory desktop app.');
      }
    });
    this.server = server;
    return new Promise((resolve, reject) => {
      const fail = (error: Error): void => {
        server.close();
        this.server = null;
        reject(error);
      };
      server.once('error', fail);
      server.listen(this.port, DESKTOP_LINK_HOST, () => {
        server.removeListener('error', fail);
        const address = server.address();
        this.boundPort =
          typeof address === 'object' && address ? address.port : this.port;
        resolve(this.boundPort);
      });
    });
  }

  close(): Promise<void> {
    const server = this.server;
    this.server = null;
    this.boundPort = null;
    if (!server) return Promise.resolve();
    return new Promise((resolve, reject) => {
      server.close((error) => error ? reject(error) : resolve());
    });
  }
}
