import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  DesktopLinkBridge,
  desktopHttpLink,
  parseDesktopHttpPath,
} from '../src/main/linkBridge';

const bridges: DesktopLinkBridge[] = [];

afterEach(async () => {
  await Promise.all(bridges.splice(0).map((bridge) => bridge.close()));
});

describe('desktop Agent Window link bridge', () => {
  it('builds and parses Agent Window-safe links', () => {
    expect(desktopHttpLink('topic', 'design notes')).toBe(
      'http://127.0.0.1:7718/open/topic/design%20notes',
    );
    expect(parseDesktopHttpPath('/open/document/id%2Fwith%20spaces')).toEqual({
      kind: 'document',
      identifier: 'id/with spaces',
    });
  });

  it('rejects unsupported or stateful routes', () => {
    expect(parseDesktopHttpPath('/edit/topic/one')).toBeNull();
    expect(parseDesktopHttpPath('/open/session/one')).toBeNull();
    expect(parseDesktopHttpPath('/open/topic/one?unexpected=true')).toBeNull();
  });

  it('opens a validated resource through loopback HTTP', async () => {
    const onOpen = vi.fn();
    const bridge = new DesktopLinkBridge(onOpen, 0);
    bridges.push(bridge);
    const port = await bridge.start();

    const response = await fetch(
      `http://127.0.0.1:${port}/open/topic/agent-window-links`,
    );

    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toBe('text/html; charset=utf-8');
    const body = await response.text();
    expect(body).toContain('Opened in the Working Memory desktop app');
    expect(body).toContain('window.close()');
    const nonce = /<script nonce="([^"]+)">/.exec(body)?.[1];
    expect(nonce).toBeTruthy();
    expect(response.headers.get('content-security-policy')).toContain(
      `script-src 'nonce-${nonce}'`,
    );
    expect(onOpen).toHaveBeenCalledWith({
      kind: 'topic',
      identifier: 'agent-window-links',
    });
  });

  it('waits for the desktop handoff before reporting success', async () => {
    let finishOpen: (() => void) | undefined;
    const onOpen = vi.fn(() => new Promise<void>((resolve) => {
      finishOpen = resolve;
    }));
    const bridge = new DesktopLinkBridge(onOpen, 0);
    bridges.push(bridge);
    const port = await bridge.start();

    let completed = false;
    const request = fetch(
      `http://127.0.0.1:${port}/open/topic/agent-window-links`,
    ).then((response) => {
      completed = true;
      return response;
    });
    await vi.waitFor(() => expect(onOpen).toHaveBeenCalledOnce());
    expect(completed).toBe(false);

    finishOpen?.();
    expect((await request).status).toBe(200);
  });

  it('reports a failed desktop handoff', async () => {
    const bridge = new DesktopLinkBridge(
      () => Promise.reject(new Error('Unable to focus window')),
      0,
    );
    bridges.push(bridge);
    const port = await bridge.start();

    const response = await fetch(
      `http://127.0.0.1:${port}/open/topic/agent-window-links`,
    );

    expect(response.status).toBe(500);
    expect(await response.text()).toContain('Unable to open this resource');
  });

  it('focuses the desktop again after the browser response finishes', async () => {
    const onResponseFinished = vi.fn();
    const bridge = new DesktopLinkBridge(
      vi.fn(),
      0,
      onResponseFinished,
    );
    bridges.push(bridge);
    const port = await bridge.start();

    const response = await fetch(
      `http://127.0.0.1:${port}/open/topic/agent-window-links`,
    );
    expect(response.status).toBe(200);
    await response.text();
    await vi.waitFor(
      () => expect(onResponseFinished).toHaveBeenCalledOnce(),
      { timeout: 1_000 },
    );
  });

  it('rejects non-GET requests', async () => {
    const bridge = new DesktopLinkBridge(vi.fn(), 0);
    bridges.push(bridge);
    const port = await bridge.start();

    const response = await fetch(
      `http://127.0.0.1:${port}/open/topic/agent-window-links`,
      { method: 'POST' },
    );

    expect(response.status).toBe(405);
  });
});
