import { BrowserWindow, dialog, session, WebContentsView, type WebContents } from 'electron';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { ObservabilityCredentials } from './observabilityContainer';
import type { ContainerAppSurfaceBounds } from '../shared/contracts';
import { observabilityLogsUrl, type ObservabilityLogSource } from '../../../shared/observabilityDashboard';

async function authenticate(rawUrl: string, credentials: ObservabilityCredentials, signal?: AbortSignal) {
  const url = new URL(rawUrl);
  if (url.protocol !== 'http:' || url.hostname !== 'localhost' || url.username || url.password) {
    throw new Error('OpenObserve must use its managed localhost endpoint.');
  }
  const origin = url.origin;
  const isolated = session.fromPartition(`wm-observability-${randomUUID()}`);
  isolated.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
  isolated.setPermissionCheckHandler(() => false);
  isolated.webRequest.onBeforeRequest((details, callback) => {
    callback({ cancel: new URL(details.url).origin !== origin });
  });
  const response = await isolated.fetch(`${origin}/auth/login`, {
    method: 'POST', credentials: 'include', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: credentials.username, password: credentials.password }),
    redirect: 'error', signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(10000)]) : AbortSignal.timeout(10000),
  });
  if (!response.ok) {
    await response.body?.cancel();
    throw new Error(`OpenObserve automatic sign-in failed (HTTP ${response.status}).`);
  }
  const login = z.object({ status: z.literal(true), role: z.string().optional() }).parse(await response.json());
  const probe = await isolated.fetch(`${origin}/api/default/streams?type=logs`, {
    redirect: 'error', credentials: 'include',
    signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(10000)]) : AbortSignal.timeout(10000),
  });
  await probe.body?.cancel();
  if (!probe.ok) throw new Error(`OpenObserve did not establish an authenticated browser session (HTTP ${probe.status}).`);
  const dashboards = await isolated.fetch(`${origin}/api/default/dashboards`, {
    redirect: 'error', credentials: 'include',
    signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(10000)]) : AbortSignal.timeout(10000),
  });
  if (!dashboards.ok) {
    await dashboards.body?.cancel();
    throw new Error(`OpenObserve dashboard discovery failed (HTTP ${dashboards.status}).`);
  }
  const dashboard = z.object({ dashboards: z.array(z.object({
    title: z.string(), dashboard_id: z.string(), folder_id: z.string(),
  })) }).parse(await dashboards.json()).dashboards.find(item => item.title === 'Working Memory diagnostics');
  if (!dashboard) throw new Error('The Working Memory diagnostics dashboard is missing. Re-enable Observability to restore it.');
  const dashboardUrl = new URL(`${origin}/web/dashboards/view`);
  dashboardUrl.search = new URLSearchParams({ org_identifier: 'default', dashboard: dashboard.dashboard_id,
    folder: dashboard.folder_id, tab: 'queue', refresh: '10s', period: '15m' }).toString();
  isolated.on('will-download', event => event.preventDefault());
  return { origin, isolated, role: login.role ?? 'root', dashboardUrl: dashboardUrl.toString() };
}

function restrictNavigation(contents: WebContents, origin: string, openLogLinks = false): void {
  const isolated = contents.session;
  contents.setWindowOpenHandler(({ url: target }) => {
    if (!URL.canParse(target)) return { action: 'deny' };
    const url = new URL(target);
    if (url.origin !== origin || url.username || url.password || url.pathname !== '/web/logs') return { action: 'deny' };
    return { action: 'allow', overrideBrowserWindowOptions: {
      title: 'Working Memory diagnostic logs', width: 1280, height: 900,
      webPreferences: { session: isolated, nodeIntegration: false, contextIsolation: true, sandbox: true },
    } };
  });
  contents.on('did-create-window', window => restrictNavigation(window.webContents, origin));
  contents.on('will-navigate', (event, target) => {
    const url = new URL(target);
    if (url.origin !== origin || url.username || url.password) { event.preventDefault(); return; }
    if (openLogLinks && url.pathname === '/web/logs') {
      event.preventDefault();
      const window = new BrowserWindow({
        title: 'Working Memory diagnostic logs', width: 1280, height: 900, show: false,
        webPreferences: { session: isolated, nodeIntegration: false, contextIsolation: true, sandbox: true },
      });
      restrictNavigation(window.webContents, origin);
      void window.loadURL(url.toString()).then(() => window.show()).catch(error => {
        window.destroy();
        dialog.showErrorBox('Unable to open diagnostic logs', error instanceof Error ? error.message : String(error));
      });
    }
  });
  contents.on('will-redirect', (event, target) => {
    if (new URL(target).origin !== origin) event.preventDefault();
  });
}

async function loadFrontend(contents: WebContents, origin: string, credentials: ObservabilityCredentials,
  role: string, dashboardUrl: string): Promise<void> {
  await contents.loadURL(`${origin}/healthz`);
  const now = Math.floor(Date.now() / 1000);
  const user = { email: credentials.username, name: credentials.username, given_name: 'Working Memory',
    family_name: '', role, auth_time: now, exp: now + 86400 };
  // The pinned UI needs display identity as well as its HttpOnly authentication cookie.
  await contents.executeJavaScript(`localStorage.setItem("userInfo", ${JSON.stringify(Buffer.from(JSON.stringify(user)).toString('base64'))});
    localStorage.setItem("currentuser", ${JSON.stringify(JSON.stringify(user))});`);
  await contents.loadURL(dashboardUrl);
}

async function installMetricHelp(contents: WebContents, isolated: Electron.Session, dashboardUrl: string,
  signal: AbortSignal): Promise<void> {
  const dashboard = new URL(dashboardUrl);
  const id = dashboard.searchParams.get('dashboard'), folder = dashboard.searchParams.get('folder');
  if (!id || !folder) throw new Error('OpenObserve dashboard metadata location is missing.');
  const response = await isolated.fetch(`${dashboard.origin}/api/default/dashboards/${encodeURIComponent(id)}?folder=${encodeURIComponent(folder)}`, {
    credentials: 'include', redirect: 'error', signal: AbortSignal.any([signal, AbortSignal.timeout(10000)]),
  });
  if (!response.ok) {
    await response.body?.cancel();
    throw new Error(`OpenObserve metric information failed to load (HTTP ${response.status}).`);
  }
  const metadata = z.object({ version: z.literal(8), v8: z.object({ tabs: z.array(z.object({
    panels: z.array(z.object({ id: z.string(), title: z.string(), description: z.string().optional() })),
  })) }) }).parse(await response.json());
  const descriptions = metadata.v8.tabs.flatMap(tab => tab.panels)
    .filter(panel => panel.description?.trim()).map(panel => [panel.id, panel]);
  if (!descriptions.length) return;
  // Print mode omits upstream help icons. Add only header help; retain its read-only dashboard and native Legends control.
  await contents.insertCSS(`
    [data-wm-metric-help] { flex-shrink:0; margin-left:6px; width:19px; height:19px; padding:0;
      border:1px solid currentColor; border-radius:50%; background:transparent; color:inherit;
      font:600 12px/17px sans-serif; cursor:help; }
    [data-wm-metric-help]:focus-visible { outline:2px solid currentColor; outline-offset:2px; }
    [data-wm-metric-popover] { box-sizing:border-box; margin:0; padding:12px; max-width:min(360px,calc(100vw - 24px));
      max-height:calc(100vh - 24px); overflow:auto; border:1px solid GrayText; border-radius:6px;
      background:var(--color-surface-panel,Canvas); color:var(--color-text-body,CanvasText);
      font:13px/1.5 sans-serif; box-shadow:0 3px 12px #0003; white-space:pre-wrap; }
  `);
  await contents.executeJavaScript(`(() => {
    const descriptions = new Map(${JSON.stringify(descriptions)});
    let sequence = 0;
    return new Promise((resolve, reject) => {
      let ready = false;
      const timeout = setTimeout(() => {
        observer.disconnect();
        reject(new Error('OpenObserve graph headers are unavailable for metric information.'));
      }, 10000);
      const install = () => {
        for (const item of document.querySelectorAll('.grid-stack-item[gs-id]')) {
          const panel = descriptions.get(item.getAttribute('gs-id'));
          const header = item.querySelector('[data-test="dashboard-panel-bar"]');
          if (!panel || !header || header.querySelector('[data-wm-metric-help]')) continue;
          const button = document.createElement('button'), help = document.createElement('div');
          button.type = 'button';
          button.textContent = 'i';
          button.dataset.wmMetricHelp = panel.id;
          button.title = panel.description;
          button.setAttribute('aria-label', 'About ' + panel.title);
          help.id = 'wm-metric-help-' + (++sequence);
          help.dataset.wmMetricPopover = panel.id;
          help.popover = 'auto';
          help.setAttribute('role', 'tooltip');
          help.textContent = panel.description;
          button.setAttribute('aria-describedby', help.id);
          button.setAttribute('popovertarget', help.id);
          button.setAttribute('aria-expanded', 'false');
          help.addEventListener('toggle', event => {
            button.setAttribute('aria-expanded', String(event.newState === 'open'));
            if (event.newState !== 'open') return;
            const rect = button.getBoundingClientRect();
            help.style.left = Math.max(12, Math.min(rect.right - help.offsetWidth, innerWidth - help.offsetWidth - 12)) + 'px';
            help.style.top = Math.max(12, Math.min(rect.bottom + 6, innerHeight - help.offsetHeight - 12)) + 'px';
          });
          header.append(button, help);
          if (!ready) { ready = true; clearTimeout(timeout); resolve(); }
        }
      };
      const observer = new MutationObserver(install);
      observer.observe(document.body, { childList:true, subtree:true });
      const dismiss = event => {
        if (event.target instanceof Element && event.target.closest('[data-wm-metric-popover]')) return;
        document.querySelectorAll('[data-wm-metric-popover]:popover-open').forEach(help => help.hidePopover());
      };
      addEventListener('scroll', dismiss, true);
      addEventListener('resize', dismiss);
      install();
    });
  })()`);
}

export async function openObservabilityWindow(rawUrl: string, credentials: ObservabilityCredentials,
  parent?: BrowserWindow, source?: ObservabilityLogSource): Promise<void> {
  const { origin, isolated, role, dashboardUrl } = await authenticate(rawUrl, credentials);
  const window = new BrowserWindow({
    title: 'Working Memory Observability', width: 1280, height: 900, show: false,
    parent,
    webPreferences: { session: isolated, nodeIntegration: false, contextIsolation: true, sandbox: true },
  });
  restrictNavigation(window.webContents, origin, !source);
  try {
    const to = Date.now() * 1000;
    await loadFrontend(window.webContents, origin, credentials, role,
      source ? observabilityLogsUrl(origin, source, { from: to - 15 * 60 * 1000000, to }) : dashboardUrl);
    window.show();
  } catch (error) {
    window.destroy();
    throw error;
  }
}

interface DashboardSurface {
  id: string;
  controller: AbortController;
  parent: BrowserWindow;
  bounds: ContainerAppSurfaceBounds;
  view?: WebContentsView;
  attached: boolean;
  visible: boolean;
  ready: boolean;
  refreshing: boolean;
  refreshTimer?: ReturnType<typeof setInterval>;
  onClosed: () => void;
}

export class ObservabilitySurface {
  private current?: DashboardSurface;

  async open(id: string, parent: BrowserWindow, bounds: ContainerAppSurfaceBounds,
    connect: () => Promise<{ url: string; credentials: ObservabilityCredentials }>): Promise<void> {
    this.close();
    const current: DashboardSurface = { id, controller: new AbortController(), parent, bounds,
      attached: false, visible: true, ready: false, refreshing: false, onClosed: () => this.close(id) };
    this.current = current;
    parent.once('closed', current.onClosed);
    try {
      const { url, credentials } = await connect();
      current.controller.signal.throwIfAborted();
      const { origin, isolated, role, dashboardUrl } = await authenticate(url, credentials, current.controller.signal);
      current.controller.signal.throwIfAborted();
      const view = new WebContentsView({
        webPreferences: { session: isolated, nodeIntegration: false, contextIsolation: true, sandbox: true },
      });
      current.view = view;
      restrictNavigation(view.webContents, origin, true);
      const presentation = new URL(dashboardUrl);
      // The pinned print-mode timer does not start. Drive its native refresh action without navigating or signing in again.
      presentation.searchParams.set('print', 'true');
      presentation.searchParams.delete('refresh');
      await loadFrontend(view.webContents, origin, credentials, role, presentation.toString());
      await installMetricHelp(view.webContents, isolated, dashboardUrl, current.controller.signal);
      current.ready = true;
      view.webContents.on('did-start-navigation', (_event, _url, isInPlace, isMainFrame) => {
        if (isMainFrame && !isInPlace) current.ready = false;
      });
      view.webContents.on('did-finish-load', () => {
        void installMetricHelp(view.webContents, isolated, dashboardUrl, current.controller.signal).then(() => {
          current.ready = true;
        }).catch(error => {
          if (!current.controller.signal.aborted) {
            dialog.showErrorBox('Unable to load metric information', error instanceof Error ? error.message : String(error));
          }
        });
      });
      current.controller.signal.throwIfAborted();
      view.setVisible(current.visible);
      parent.contentView.addChildView(view);
      current.attached = true;
      this.resize(id, current.bounds);
      current.refreshTimer = setInterval(() => {
        if (!current.visible || !current.ready || current.refreshing || current.controller.signal.aborted) return;
        current.refreshing = true;
        void view.webContents.executeJavaScript(`(() => {
          const button = document.querySelector('[data-test="dashboard-refresh-btn"]');
          if (!(button instanceof HTMLButtonElement)) throw new Error('OpenObserve dashboard refresh control is unavailable.');
          if (!button.disabled) button.click();
        })()`).catch(error => {
          clearInterval(current.refreshTimer);
          if (!current.controller.signal.aborted) {
            dialog.showErrorBox('Observability automatic refresh stopped',
              `${error instanceof Error ? error.message : String(error)} Reopen the Observability tab to retry.`);
          }
        }).finally(() => { current.refreshing = false; });
      }, 10000);
    } catch (error) {
      this.close(id);
      throw error;
    }
  }

  setVisible(id: string, visible: boolean): void {
    if (this.current?.id !== id) return;
    this.current.visible = visible;
    this.current.view?.setVisible(visible);
  }

  resize(id: string, bounds: ContainerAppSurfaceBounds): void {
    const current = this.current;
    if (!current || current.id !== id) return;
    current.bounds = bounds;
    if (!current.view || !current.attached) return;
    const content = current.parent.getContentBounds();
    const x = Math.min(content.width, Math.max(0, Math.round(bounds.x)));
    const y = Math.min(content.height, Math.max(0, Math.round(bounds.y)));
    current.view.setBounds({ x, y,
      width: Math.min(content.width - x, Math.max(0, Math.round(bounds.width))),
      height: Math.min(content.height - y, Math.max(0, Math.round(bounds.height))) });
  }

  close(id?: string): void {
    const current = this.current;
    if (!current || id !== undefined && current.id !== id) return;
    this.current = undefined;
    clearInterval(current.refreshTimer);
    current.controller.abort(new Error('The OpenObserve tab was closed.'));
    current.parent.removeListener('closed', current.onClosed);
    if (current.view && current.attached && !current.parent.isDestroyed()) current.parent.contentView.removeChildView(current.view);
    if (current.view && !current.view.webContents.isDestroyed()) current.view.webContents.close();
  }
}
