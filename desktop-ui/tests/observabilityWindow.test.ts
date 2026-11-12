import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import type { BrowserWindow } from 'electron';

const mocks = vi.hoisted(() => ({
  fetch: vi.fn<typeof fetch>(), request: vi.fn(), permission: vi.fn(), permissionCheck: vi.fn(),
  options: vi.fn(), navigate: vi.fn(), redirect: vi.fn(), destroyed: vi.fn(),
  execute: vi.fn(), css: vi.fn(), load: vi.fn(), show: vi.fn(), openHandler: vi.fn(),
  add: vi.fn(), remove: vi.fn(), bounds: vi.fn(), close: vi.fn(),
  visible: vi.fn(), created: vi.fn(), errorBox: vi.fn(),
  events: new Map<string, (...args: unknown[]) => void>(),
}));
vi.mock('electron', () => {
  const isolated = {
    fetch: mocks.fetch, setPermissionRequestHandler: mocks.permission, setPermissionCheckHandler: mocks.permissionCheck,
    webRequest: { onBeforeRequest: mocks.request }, on: vi.fn(),
  };
  const listen = (event: string, handler: unknown) => {
    if (event === 'did-start-navigation' || event === 'did-finish-load') mocks.events.set(event, handler as (...args: unknown[]) => void);
    if (event === 'will-navigate') mocks.navigate(handler);
    if (event === 'will-redirect') mocks.redirect(handler);
    if (event === 'did-create-window') mocks.created(handler);
  };
  return {
    dialog: { showErrorBox: mocks.errorBox },
    session: { fromPartition: () => isolated },
    BrowserWindow: class {
      constructor(options: object) { mocks.options(options); }
      webContents = {
        executeJavaScript: mocks.execute, insertCSS: mocks.css, setWindowOpenHandler: mocks.openHandler,
        loadURL: mocks.load,
        session: isolated, on: listen,
      };
      loadURL = mocks.load;
      show = mocks.show;
      destroy = mocks.destroyed;
    },
    WebContentsView: class {
      constructor(options: object) { mocks.options(options); }
      webContents = {
        executeJavaScript: mocks.execute, insertCSS: mocks.css, loadURL: mocks.load, setWindowOpenHandler: mocks.openHandler,
        isDestroyed: () => false, close: mocks.close,
        session: isolated, on: listen,
      };
      setBounds = mocks.bounds;
      setVisible = mocks.visible;
    },
  };
});
import { ObservabilitySurface, openObservabilityWindow } from '../src/main/observabilityWindow';
const credentials = { username: 'wm@localhost.invalid', password: 'a generated private test password' };
beforeEach(() => {
  vi.useFakeTimers();
  vi.clearAllMocks();
  mocks.events.clear();
  mocks.fetch.mockImplementation(async url => String(url).endsWith('/auth/login')
    ? Response.json({ status: true }) : String(url).endsWith('/dashboards')
      ? Response.json({ dashboards: [{ title: 'Working Memory diagnostics', dashboard_id: 'baseline', folder_id: 'default' }] })
      : String(url).includes('/dashboards/baseline?') ? Response.json({ version: 8, v8: { tabs: [{
        panels: [{ id: 'queue-depth', title: 'Maximum queue depth', description: 'Peak waiting requests measured by the admission queue.' }],
      }] } })
      : Response.json({ list: [] }));
  mocks.load.mockResolvedValue(undefined);
  mocks.execute.mockResolvedValue(undefined);
});
afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
});

it('logs in through the native isolated session, never puts a password in renderer scripts, and sandboxes the window', async () => {
  await openObservabilityWindow('http://localhost:5080/web/', credentials);
  expect(mocks.fetch).toHaveBeenNthCalledWith(1, 'http://localhost:5080/auth/login', expect.objectContaining({
    method: 'POST', credentials: 'include', redirect: 'error',
    body: JSON.stringify({ name: credentials.username, password: credentials.password }),
  }));
  expect(mocks.fetch).toHaveBeenNthCalledWith(2, 'http://localhost:5080/api/default/streams?type=logs',
    expect.objectContaining({ credentials: 'include', redirect: 'error' }));
  expect(mocks.options).toHaveBeenCalledWith(expect.objectContaining({
    webPreferences: expect.objectContaining({ sandbox: true, contextIsolation: true, nodeIntegration: false }),
  }));
  expect(JSON.stringify(mocks.execute.mock.calls)).not.toContain(credentials.password);
  expect(mocks.load).toHaveBeenLastCalledWith(
    'http://localhost:5080/web/dashboards/view?org_identifier=default&dashboard=baseline&folder=default&tab=queue&refresh=10s&period=15m');
  expect(mocks.show).toHaveBeenCalledOnce();
});

it('does not open a window if authentication or cookie verification fails', async () => {
  mocks.fetch.mockResolvedValueOnce(new Response('', { status: 401 }));
  await expect(openObservabilityWindow('http://localhost:5080', credentials)).rejects.toThrow('HTTP 401');
  expect(mocks.options).not.toHaveBeenCalled();
  mocks.fetch.mockResolvedValueOnce(Response.json({ status: true })).mockResolvedValueOnce(new Response('', { status: 401 }));
  await expect(openObservabilityWindow('http://localhost:5080', credentials)).rejects.toThrow('authenticated browser session');
  expect(mocks.options).not.toHaveBeenCalled();
});

it('rejects remote/credential URLs and blocks cross-origin requests from the authenticated window', async () => {
  await expect(openObservabilityWindow('http://example.com', credentials)).rejects.toThrow('localhost');
  await expect(openObservabilityWindow('http://user:password@localhost:5080', credentials)).rejects.toThrow('localhost');
  await openObservabilityWindow('http://localhost:5080', credentials);
  const handler = mocks.request.mock.calls[0][0];
  const callback = vi.fn();
  handler({ url: 'http://localhost:5080/api/default/streams' }, callback);
  expect(callback).toHaveBeenLastCalledWith({ cancel: false });
  handler({ url: 'http://localhost:5081/api/default/streams' }, callback);
  expect(callback).toHaveBeenLastCalledWith({ cancel: true });
  handler({ url: 'https://example.com/collect' }, callback);
  expect(callback).toHaveBeenLastCalledWith({ cancel: true });
});

function parentWindow(): BrowserWindow {
  return Object.assign(new EventEmitter(), {
    contentView: { addChildView: mocks.add, removeChildView: mocks.remove },
    getContentBounds: () => ({ x: 0, y: 0, width: 1200, height: 900 }),
    isDestroyed: () => false,
  }) as BrowserWindow;
}
const bounds = { x: 300, y: 100, width: 800, height: 700 };
const connect = async () => ({ url: 'http://localhost:5080/web/', credentials });

it('opens sanitized same-origin log links in sandboxed authenticated windows and reports load failures', async () => {
  const surface = new ObservabilitySurface();
  await surface.open('logs', parentWindow(), bounds, connect);
  const navigate = mocks.navigate.mock.calls[0][0];
  const event = { preventDefault: vi.fn() };
  await navigate(event, 'http://localhost:5080/web/logs?query=filtered');
  await vi.waitFor(() => expect(mocks.show).toHaveBeenCalledOnce());
  expect(event.preventDefault).toHaveBeenCalledOnce();
  expect(mocks.load).toHaveBeenLastCalledWith('http://localhost:5080/web/logs?query=filtered');
  expect(mocks.options).toHaveBeenLastCalledWith(expect.objectContaining({
    webPreferences: expect.objectContaining({ sandbox: true, contextIsolation: true, nodeIntegration: false }),
  }));
  mocks.load.mockRejectedValueOnce(new Error('Collector unreachable'));
  navigate(event, 'http://localhost:5080/web/logs?query=other');
  await vi.waitFor(() => expect(mocks.errorBox).toHaveBeenCalledWith('Unable to open diagnostic logs', 'Collector unreachable'));
  const windows = mocks.options.mock.calls.length;
  navigate(event, 'http://localhost:9999/web/logs');
  expect(mocks.options).toHaveBeenCalledTimes(windows);
  surface.close();
});

it('embeds a sandboxed authenticated surface inside the tab and resizes without opening another window', async () => {
  const surface = new ObservabilitySurface(), parent = parentWindow();
  await surface.open('first', parent, bounds, connect);
  expect(mocks.add).toHaveBeenCalledOnce();
  expect(mocks.bounds).toHaveBeenLastCalledWith(bounds);
  expect(mocks.show).not.toHaveBeenCalled();
  const dashboardUrl = new URL(mocks.load.mock.calls.at(-1)![0]);
  expect(dashboardUrl.searchParams.get('print')).toBe('true');
  expect(dashboardUrl.searchParams.has('refresh')).toBe(false);
  expect(dashboardUrl.searchParams.get('dashboard')).toBe('baseline');
  expect(dashboardUrl.searchParams.get('tab')).toBe('queue');
  expect(mocks.fetch).toHaveBeenLastCalledWith('http://localhost:5080/api/default/dashboards/baseline?folder=default',
    expect.objectContaining({ credentials: 'include', redirect: 'error' }));
  expect(mocks.css).toHaveBeenCalledOnce();
  const helpScript = mocks.execute.mock.calls.at(-1)![0];
  expect(helpScript).toContain('Peak waiting requests measured by the admission queue.');
  expect(helpScript).toContain('help.textContent = panel.description');
  expect(helpScript).not.toContain('innerHTML');
  expect(mocks.options).toHaveBeenCalledWith({ webPreferences: expect.objectContaining({
    sandbox: true, contextIsolation: true, nodeIntegration: false,
  }) });
  expect(JSON.stringify(mocks.execute.mock.calls)).not.toContain(credentials.password);
  surface.resize('first', { x: -1, y: 200, width: 5000, height: 1000 });
  expect(mocks.bounds).toHaveBeenLastCalledWith({ x: 0, y: 200, width: 1200, height: 700 });
  surface.setVisible('first', false);
  expect(mocks.visible).toHaveBeenLastCalledWith(false);
  surface.setVisible('first', true);
  expect(mocks.visible).toHaveBeenLastCalledWith(true);
  surface.close('other');
  expect(mocks.close).not.toHaveBeenCalled();
  parent.emit('closed');
  expect(mocks.remove).toHaveBeenCalledOnce();
  expect(mocks.close).toHaveBeenCalledOnce();
});

it('reports metric metadata and help installation failures instead of silently omitting descriptions', async () => {
  const surface = new ObservabilitySurface();
  const fetch = mocks.fetch.getMockImplementation()!;
  mocks.fetch.mockImplementation(async (url, options) => String(url).includes('/dashboards/baseline?')
    ? new Response('', { status: 503 }) : fetch(url, options));
  await expect(surface.open('metadata', parentWindow(), bounds, connect)).rejects.toThrow('metric information failed to load (HTTP 503)');
  expect(mocks.add).not.toHaveBeenCalled();
  expect(mocks.close).toHaveBeenCalledOnce();
  mocks.fetch.mockImplementation(fetch);
  mocks.execute.mockResolvedValueOnce(undefined).mockRejectedValueOnce(new Error('Graph headers unavailable'));
  await expect(surface.open('help', parentWindow(), bounds, connect)).rejects.toThrow('Graph headers unavailable');
  expect(mocks.add).not.toHaveBeenCalled();
  expect(mocks.close).toHaveBeenCalledTimes(2);
});

it('allows a customized dashboard without optional descriptions to open without help icons', async () => {
  const fetch = mocks.fetch.getMockImplementation()!;
  mocks.fetch.mockImplementation(async (url, options) => String(url).includes('/dashboards/baseline?')
    ? Response.json({ version: 8, v8: { tabs: [{ panels: [{ id: 'custom', title: 'Custom chart' }] }] } })
    : fetch(url, options));
  const surface = new ObservabilitySurface();
  await surface.open('custom', parentWindow(), bounds, connect);
  expect(mocks.add).toHaveBeenCalledOnce();
  expect(mocks.css).not.toHaveBeenCalled();
  expect(mocks.execute).toHaveBeenCalledOnce();
  surface.close();
});

it('refreshes only the visible loaded dashboard, using the existing native session without navigation', async () => {
  const surface = new ObservabilitySurface();
  await surface.open('live', parentWindow(), bounds, connect);
  const loads = mocks.load.mock.calls.length, requests = mocks.fetch.mock.calls.length;
  mocks.execute.mockClear();
  await vi.advanceTimersByTimeAsync(20000);
  expect(mocks.execute).toHaveBeenCalledTimes(2);
  expect(mocks.execute).toHaveBeenLastCalledWith(expect.stringContaining('button.click()'));
  expect(mocks.execute).toHaveBeenLastCalledWith(expect.stringContaining('if (!button.disabled)'));
  surface.setVisible('live', false);
  await vi.advanceTimersByTimeAsync(20000);
  expect(mocks.execute).toHaveBeenCalledTimes(2);
  surface.setVisible('live', true);
  mocks.events.get('did-start-navigation')!({}, 'http://localhost:5080/web/dashboards/view?tab=http', true, true);
  await vi.advanceTimersByTimeAsync(10000);
  expect(mocks.execute).toHaveBeenCalledTimes(3);
  mocks.events.get('did-start-navigation')!({}, 'http://localhost:5080/frame', false, false);
  await vi.advanceTimersByTimeAsync(10000);
  expect(mocks.execute).toHaveBeenCalledTimes(4);
  mocks.events.get('did-start-navigation')!({}, 'http://localhost:5080/web/dashboards/view', false, true);
  await vi.advanceTimersByTimeAsync(10000);
  expect(mocks.execute).toHaveBeenCalledTimes(4);
  mocks.events.get('did-finish-load')!();
  await vi.advanceTimersByTimeAsync(10000);
  expect(mocks.execute).toHaveBeenCalledTimes(6); // Reinstall header help, then refresh.
  expect(mocks.load).toHaveBeenCalledTimes(loads);
  expect(mocks.fetch).toHaveBeenCalledTimes(requests + 1); // Dashboard metadata, not another login.
  surface.close();
  await vi.advanceTimersByTimeAsync(20000);
  expect(mocks.execute).toHaveBeenCalledTimes(6);
  expect(vi.getTimerCount()).toBe(0);
});

it('reports a failed native refresh once and stops retrying instead of silently freezing', async () => {
  const surface = new ObservabilitySurface();
  await surface.open('failed', parentWindow(), bounds, connect);
  mocks.execute.mockClear().mockRejectedValueOnce(new Error('Refresh control unavailable'));
  await vi.advanceTimersByTimeAsync(30000);
  expect(mocks.execute).toHaveBeenCalledOnce();
  expect(mocks.errorBox).toHaveBeenCalledExactlyOnceWith('Observability automatic refresh stopped',
    'Refresh control unavailable Reopen the Observability tab to retry.');
  surface.close();
});

it('does not overlap refresh commands or report a stale failure after the tab closes', async () => {
  const surface = new ObservabilitySurface();
  await surface.open('slow', parentWindow(), bounds, connect);
  let reject!: (error: Error) => void;
  mocks.execute.mockClear().mockImplementationOnce(() => new Promise((_resolve, fail) => { reject = fail; }));
  await vi.advanceTimersByTimeAsync(30000);
  expect(mocks.execute).toHaveBeenCalledOnce();
  surface.close();
  reject(new Error('View destroyed'));
  await vi.advanceTimersByTimeAsync(10000);
  expect(mocks.errorBox).not.toHaveBeenCalled();
});

it('does not attach a tab closed during credential lookup or close a newer tab with stale cleanup', async () => {
  const surface = new ObservabilitySurface(), parent = parentWindow();
  let resolve!: (target: Awaited<ReturnType<typeof connect>>) => void;
  const pending = surface.open('old', parent, bounds, () => new Promise(done => { resolve = done; }));
  const rejected = expect(pending).rejects.toThrow('tab was closed');
  surface.close('old');
  await surface.open('new', parent, bounds, connect);
  resolve(await connect());
  await rejected;
  expect(mocks.add).toHaveBeenCalledOnce();
  expect(mocks.close).not.toHaveBeenCalled();
  surface.close('new');
  expect(mocks.close).toHaveBeenCalledOnce();
});

it('surfaces sign-in and frontend load failures without leaving an attached view', async () => {
  const surface = new ObservabilitySurface(), parent = parentWindow();
  mocks.fetch.mockResolvedValueOnce(new Response('', { status: 401 }));
  await expect(surface.open('auth', parent, bounds, connect)).rejects.toThrow('HTTP 401');
  expect(mocks.add).not.toHaveBeenCalled();
  mocks.load.mockRejectedValueOnce(new Error('Collector offline'));
  await expect(surface.open('load', parent, bounds, connect)).rejects.toThrow('Collector offline');
  expect(mocks.add).not.toHaveBeenCalled();
  expect(mocks.close).toHaveBeenCalledOnce();
  expect(parent.listenerCount('closed')).toBe(0);
});

it('reports missing dashboards instead of opening a blank frontend or signing the user out', async () => {
  mocks.fetch.mockResolvedValueOnce(Response.json({ status: true }))
    .mockResolvedValueOnce(Response.json({ list: [] }))
    .mockResolvedValueOnce(Response.json({ dashboards: [] }));
  await expect(openObservabilityWindow('http://localhost:5080', credentials)).rejects.toThrow('dashboard is missing');
  expect(mocks.options).not.toHaveBeenCalled();
});

it.each(['http', 'queue', 'embeddings'] as const)('opens %s logs with native authentication and only permits sandboxed same-origin log-search popups', async source => {
  await openObservabilityWindow('http://localhost:5080', credentials, undefined, source);
  const url = new URL(mocks.load.mock.calls.at(-1)![0]);
  expect(url.pathname).toBe('/web/logs');
  expect(url.searchParams.get('stream')).toBe('wm_diagnostics');
  expect(Buffer.from(url.searchParams.get('query')!, 'base64').toString()).toContain(`source = '${source}'`);
  expect(Number(url.searchParams.get('to')) - Number(url.searchParams.get('from'))).toBe(900000000);
  const open = mocks.openHandler.mock.calls[0][0];
  expect(open({ url: url.toString() })).toMatchObject({
    action: 'allow', overrideBrowserWindowOptions: { webPreferences: {
      sandbox: true, contextIsolation: true, nodeIntegration: false,
    } },
  });
  for (const target of ['http://example.com/web/logs', 'http://localhost:5081/web/logs',
    'http://localhost:5080/auth/login', 'file:///tmp/anything', 'not a URL']) {
    expect(open({ url: target })).toEqual({ action: 'deny' });
  }
});
