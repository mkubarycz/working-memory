import { expect, it } from 'vitest';
import { createServer } from 'vite';
import { svelte } from '@sveltejs/vite-plugin-svelte';
import { createRequire } from 'node:module';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

it.skipIf(process.platform === 'linux' && !process.env.DISPLAY)(
  'recovers the actual workspace after identity failures without losing drafts or bypassing authentication',
  async () => {
    const executable: unknown = createRequire(import.meta.url)('electron');
    if (typeof executable !== 'string') throw new Error('Electron executable is unavailable.');
    const directory = await mkdtemp(join(tmpdir(), 'working-memory-connection-browser-'));
    const fixture = `
      import { mount } from 'svelte';
      import App from '/src/renderer/App.svelte';
      import '/src/renderer/style.css';
      const parameters = new URLSearchParams(location.search);
      const state = window.__connectionTest = {
        mode: parameters.has('startup') ? 'timeout' : 'success', authenticated: !parameters.has('signedOut'),
        passwordConfigured: parameters.get('signedOut') !== 'setup',
        reads: 0, activeReads: 0, maxReads: 0, pause: false, releases: [],
        streamStarts: 0, current: parameters.has('offline') ? -1 : 0,
        offline: parameters.has('offline'), discoveries: 0, opened: [],
        pauseWorkspace: false, activeLoads: 0, workspaceReleases: [], observability: false, mounts: [],
      };
      const environments = [7717, 7719].map(port => ({
        id: 'test-' + port, port, displayName: 'Test ' + port,
        mcpUrl: 'http://127.0.0.1:' + port + '/mcp', source: 'sandbox',
      }));
      const environmentState = () => ({ environments: state.offline ? [] : environments, selected: environments[state.current] ?? null });
      const interval = window.setInterval.bind(window);
      window.setInterval = (callback, milliseconds, ...args) => {
        if (milliseconds === 30_000 && callback.toString().includes('refreshBackendHealth')) {
          state.heartbeat = callback;
          state.heartbeatMilliseconds = milliseconds;
          return interval(callback, 3_600_000, ...args);
        }
        return interval(callback, milliseconds, ...args);
      };
      window.workingMemory = {
        getDesktopBuildInfo: async () => null,
        getConfig: async () => ({
          endpoint: '', model: '', hasApiKey: false, credentialStorage: 'session',
          humanName: '', profiles: [], routing: {},
        }),
        getOpenAiHealth: async () => ({ state: 'unreachable', result: 'Not configured', observedAt: Date.now() }),
        discoverEnvironments: async () => {
          state.discoveries++;
          if (!state.offline && state.current < 0) state.current = 1;
          return environmentState();
        },
        switchEnvironment: async url => {
          state.current = environments.findIndex(environment => environment.mcpUrl === url);
          return environmentState();
        },
        async getInstanceIdentity() {
          state.reads++;
          state.maxReads = Math.max(state.maxReads, ++state.activeReads);
          const mode = state.mode;
          const result = {
            environment: environments[state.current].mcpUrl.replace('/mcp', ''),
            passwordConfigured: state.passwordConfigured, passwordHint: '', setupAvailable: true,
            authenticated: state.authenticated,
          };
          try {
            if (state.pause) await new Promise(resolve => state.releases.push(resolve));
            if (mode === 'timeout') throw new Error('Instance request timed out after 10 seconds (GET /identity/v1/status).');
            if (mode === 'unavailable') throw new Error('Instance connection failed (HTTP 503).');
            if (state.renewalEvent) {
              state.renewalEvent = false;
              state.authenticationChanged({ mcpUrl: environments[state.current].mcpUrl, authenticated: true });
            }
            if (!result.authenticated) {
              state.authenticationChanged({ mcpUrl: environments[state.current].mcpUrl, authenticated: false });
            }
            return result;
          } finally { state.activeReads--; }
        },
        async signInInstance() {
          state.authenticated = true;
          state.authenticationChanged({ mcpUrl: environments[state.current].mcpUrl, authenticated: true });
        },
        onInstanceAuthenticationChanged: callback => {
          state.authenticationChanged = callback;
          return () => {};
        },
        onOpenResource: callback => { state.openResource = callback; return () => {}; },
        async openResource(kind, identifier) {
          state.opened.push({ kind, identifier, environment: state.current });
          return { kind: 'workstream', id: identifier, title: 'Recovered link', status: 'open',
            createdAt: 1, updatedAt: 1, closure: null, resourceVersion: 1, editable: false,
            topics: [], tree: [], agentMessages: [] };
        },
        onDocumentChanges: () => () => {},
        onResourceDragResult: () => () => {},
        getBackendHealth: async () => ({
          state: state.offline ? 'unreachable' : 'healthy', endpoint: environments[state.current]?.mcpUrl,
          result: 'OK', observedAt: Date.now(), source: 'sandbox',
        }),
        getActivePanel: async () => {
          if (state.pauseWorkspace) {
            state.activeLoads++;
            await new Promise(resolve => state.workspaceReleases.push(resolve));
            state.activeLoads--;
          }
          return { tab: 'active', items: [], emptyMessage: 'No active workstreams.' };
        },
        getChatHistory: async () => ({ journals: [] }),
        getAgentMessages: async () => [],
        listContainerApps: async () => state.observability && !state.missingObservability ? [{
          id: 'observability-' + state.current, displayName: 'Working Memory Observability', icon: 'pulse',
          embeddable: true, nativeSurface: 'observability',
        }] : [],
        inspectContainerApp: async () => ({ ready: true, url: 'http://localhost:5080/web/' }),
        getAppMcpStatus: async () => ({ state: 'disconnected' }),
        mountContainerAppSurface: async (...args) => { state.mounts.push(args); },
        resizeContainerAppSurface: async () => {},
        setContainerAppSurfaceVisible: async () => {},
        closeContainerAppSurface: async () => {},
        getEmbeddingDashboard: async () => ({ enabled: false }),
        getInstanceFeatures: async () => {
          if (state.failFeatures) throw new Error('Feature status unavailable');
          return { hostTasks: false, search: false, observability: state.observability };
        },
        getInstanceAccess: async () => ({ requests: [], clients: [] }),
        startDocumentChanges: async () => { state.streamStarts++; },
      };
      mount(App, { target: document.body });
    `;
    const server = await createServer({
      configFile: false, root: fileURLToPath(new URL('..', import.meta.url)),
      cacheDir: join(directory, 'vite-cache'),
      optimizeDeps: { include: [
        'svelte', '@codemirror/commands', '@codemirror/lang-markdown', '@codemirror/language',
        '@lezer/highlight', '@lezer/markdown', '@codemirror/state', '@codemirror/view',
        '@codemirror/lang-javascript', '@codemirror/lang-json', 'chrono-node', 'markdown-it', 'turndown', 'zod',
      ] },
      plugins: [svelte(), {
        name: 'connection-browser-fixture',
        resolveId: id => id === '/connection-fixture.js' ? '\0connection-fixture' : undefined,
        load: id => id === '\0connection-fixture' ? fixture : undefined,
        configureServer(server) {
          server.middlewares.use((req, res, next) => {
            if (!req.url?.startsWith('/connection-test.html')) { next(); return; }
            res.setHeader('content-type', 'text/html');
            res.end('<!doctype html><html><body><script type="module" src="/connection-fixture.js"></script></body></html>');
          });
        },
      }],
      server: { host: '127.0.0.1', port: 0 }, appType: 'custom',
    });
    try {
      await server.listen();
      const address = server.httpServer?.address();
      if (!address || typeof address === 'string') throw new Error('Connection fixture did not bind a TCP port.');
      const script = join(directory, 'connection-test.cjs');
      await writeFile(script, `
        const { app, BrowserWindow } = require('electron');
        const assert = require('node:assert/strict');
        app.setPath('userData', ${JSON.stringify(join(directory, 'profile'))});
        app.whenReady().then(async () => {
          const window = new BrowserWindow({ show: false });
          window.webContents.on('console-message', event => console.error(event.message));
          const evaluate = code => window.webContents.executeJavaScript(code);
          const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
          async function wait(code) {
            const until = Date.now() + 10_000;
            while (Date.now() < until) {
              if (await evaluate(code)) return;
              await delay(20);
            }
            throw new Error('Timed out: ' + code + '\\n' + await evaluate('document.body.innerText')
              + '\\n' + await evaluate('JSON.stringify(window.__connectionTest)'));
          }
          async function signIn() {
            await evaluate(\`{ const password = document.querySelector('input[type=password]');
              password.value = 'test-owner-password'; password.dispatchEvent(new Event('input', { bubbles: true }));
              password.form.requestSubmit(); }\`);
            await wait("document.querySelector('.shell') && window.__connectionTest.streamStarts > 0");
          }
          async function switchTo(port) {
            await evaluate("document.querySelector('.environment-trigger').click()");
            await wait("document.querySelectorAll('[role=menuitemradio]').length === 2");
            await evaluate("Array.from(document.querySelectorAll('[role=menuitemradio]')).find(button => button.textContent.includes('" + port + "')).click()");
          }
          await window.loadURL('http://127.0.0.1:${address.port}/connection-test.html');
          await wait("document.querySelector('.shell') && window.__connectionTest.streamStarts === 1");
          assert.equal(await evaluate('window.__connectionTest.heartbeatMilliseconds'), 30_000);
          await evaluate("document.querySelector('.topic-backlog-button').click()");
          await wait("document.querySelector('.backlog-head')");
          await evaluate(\`document.querySelector('.backlog-head').dataset.originalMount = 'kept';
            const composer = document.querySelector('textarea[aria-label=Message]');
            composer.value = 'Unsaved diagnostic notes';
            composer.dispatchEvent(new Event('input', { bubbles: true }));\`);
          await evaluate("window.__connectionTest.mode = 'timeout'; window.__connectionTest.heartbeat()");
          await wait("document.querySelector('.instance-connection-notice')");
          assert.equal(await evaluate("document.querySelector('.instance-connection')"), null);
          assert.equal(await evaluate("document.querySelector('textarea[aria-label=Message]').value"), 'Unsaved diagnostic notes');
          assert.equal(await evaluate("document.querySelector('.backlog-head').dataset.originalMount"), 'kept');
          assert.match(await evaluate("document.querySelector('.instance-connection-notice').textContent"), /10 seconds.*identity\\/v1\\/status/);
          assert.match(await evaluate("document.querySelector('.instance-connection-notice').textContent"), /Open Observability/);
          assert.match(await evaluate("document.querySelector('.instance-connection-notice').textContent"), /Settings > Features/);
          await evaluate("window.__connectionTest.mode = 'success'; window.__connectionTest.pause = true; document.querySelector('.instance-connection-notice button').click()");
          await wait('window.__connectionTest.activeReads === 1');
          const reads = await evaluate('window.__connectionTest.reads');
          await evaluate("document.querySelector('.instance-connection-notice button').click(); window.__connectionTest.heartbeat(); window.__connectionTest.heartbeat()");
          await delay(100);
          assert.equal(await evaluate('window.__connectionTest.reads'), reads, 'Retry and heartbeat must not overlap identity checks');
          assert.ok(await evaluate("document.querySelector('.instance-connection-notice') !== null"), 'Keep the error visible until recovery');
          await evaluate("window.__connectionTest.pause = false; window.__connectionTest.releases.shift()()");
          await wait("!document.querySelector('.instance-connection-notice')");
          assert.equal(await evaluate("document.querySelector('.backlog-head').dataset.originalMount"), 'kept');
          assert.equal(await evaluate("document.querySelector('textarea[aria-label=Message]').value"), 'Unsaved diagnostic notes');
          assert.equal(await evaluate('window.__connectionTest.maxReads'), 1);
          await evaluate("window.__connectionTest.mode = 'unavailable'; window.__connectionTest.heartbeat()");
          await wait("document.querySelector('.instance-connection-notice')?.textContent.includes('HTTP 503')");
          await evaluate("window.__connectionTest.mode = 'success'; window.__connectionTest.heartbeat()");
          await wait("!document.querySelector('.instance-connection-notice')");
          const streamsBeforeHeartbeatRenewal = await evaluate('window.__connectionTest.streamStarts');
          await evaluate("window.__connectionTest.renewalEvent = true; window.__connectionTest.heartbeat()");
          await wait("window.__connectionTest.streamStarts === " + (streamsBeforeHeartbeatRenewal + 1));
          assert.equal(await evaluate("document.querySelector('.backlog-head').dataset.originalMount"), 'kept');
          const streamsBeforeRenewal = await evaluate('window.__connectionTest.streamStarts');
          await evaluate("window.__connectionTest.pause = true; window.__connectionTest.authenticationChanged({ mcpUrl: 'http://127.0.0.1:7717/mcp', authenticated: false, reason: 'expired' })");
          await wait("window.__connectionTest.activeReads === 1 && document.querySelector('.instance-session-recovery')");
          const renewalReads = await evaluate('window.__connectionTest.reads');
          await evaluate("window.__connectionTest.authenticationChanged({ mcpUrl: 'http://127.0.0.1:7717/mcp', authenticated: false, reason: 'expired' }); window.__connectionTest.heartbeat()");
          await delay(100);
          assert.equal(await evaluate('window.__connectionTest.reads'), renewalReads);
          assert.equal(await evaluate("document.querySelector('.instance-connection')"), null);
          assert.equal(await evaluate("document.querySelector('.backlog-head').dataset.originalMount"), 'kept');
          assert.equal(await evaluate("document.querySelector('textarea[aria-label=Message]').value"), 'Unsaved diagnostic notes');
          await evaluate("window.__connectionTest.pause = false; window.__connectionTest.releases.shift()()");
          await wait("!document.querySelector('.instance-session-recovery') && window.__connectionTest.streamStarts === " + (streamsBeforeRenewal + 1));
          assert.equal(await evaluate("document.querySelector('.backlog-head').dataset.originalMount"), 'kept');
          assert.equal(await evaluate("document.querySelector('textarea[aria-label=Message]').value"), 'Unsaved diagnostic notes');
          await evaluate("window.__connectionTest.pause = true; window.__connectionTest.heartbeat()");
          await wait('window.__connectionTest.activeReads === 1');
          const readsDuringPoll = await evaluate('window.__connectionTest.reads');
          await evaluate("window.__connectionTest.authenticationChanged({ mcpUrl: 'http://127.0.0.1:7717/mcp', authenticated: false, reason: 'expired' })");
          await wait("document.querySelector('.instance-session-recovery')");
          await delay(100);
          assert.equal(await evaluate('window.__connectionTest.reads'), readsDuringPoll, 'Renewal must wait for an in-flight identity check');
          await evaluate("window.__connectionTest.pause = false; window.__connectionTest.releases.shift()()");
          await wait("!document.querySelector('.instance-session-recovery') && window.__connectionTest.streamStarts === " + (streamsBeforeRenewal + 2));
          assert.equal(await evaluate('window.__connectionTest.maxReads'), 1);
          assert.equal(await evaluate("document.querySelector('.backlog-head').dataset.originalMount"), 'kept');
          await evaluate("window.__connectionTest.authenticated = false; window.__connectionTest.authenticationChanged({ mcpUrl: 'http://127.0.0.1:7717/mcp', authenticated: false, reason: 'expired' })");
          await wait("document.querySelector('.instance-connection input[type=password]')");
          const signedOutReads = await evaluate('window.__connectionTest.reads');
          await evaluate('window.__connectionTest.heartbeat()');
          await delay(100);
          assert.equal(await evaluate('window.__connectionTest.reads'), signedOutReads, 'Do not silently reauthenticate a rejected session');
          await signIn();
          await evaluate("window.__connectionTest.pause = true; window.__connectionTest.authenticationChanged({ mcpUrl: 'http://127.0.0.1:7717/mcp', authenticated: false, reason: 'expired' })");
          await wait('window.__connectionTest.activeReads === 1');
          await evaluate(\`window.__connectionTest.authenticated = false;
            window.__connectionTest.authenticationChanged({ mcpUrl: 'http://127.0.0.1:7717/mcp', authenticated: false });\`);
          await wait("document.querySelector('.instance-connection')");
          await evaluate("window.__connectionTest.pause = false; window.__connectionTest.releases.shift()()");
          await wait('window.__connectionTest.activeReads === 0');
          assert.equal(await evaluate("document.querySelector('.shell')"), null, 'A stale authenticated reply must not undo revocation');
          await signIn();
          await evaluate("window.__connectionTest.pause = true; window.__connectionTest.authenticationChanged({ mcpUrl: 'http://127.0.0.1:7717/mcp', authenticated: false, reason: 'expired' })");
          await wait('window.__connectionTest.activeReads === 1');
          await evaluate("window.__connectionTest.pause = false; window.__connectionTest.authenticated = false");
          await switchTo(7719);
          await wait("document.querySelector('.instance-address')?.textContent.includes('7719')");
          await evaluate('window.__connectionTest.releases.shift()()');
          await wait('window.__connectionTest.activeReads === 0');
          assert.equal(await evaluate("document.querySelector('.shell')"), null, 'The previous instance cannot authenticate the selected instance');
          await signIn();
          await evaluate("window.__connectionTest.pause = true; window.__connectionTest.mode = 'timeout'; window.__connectionTest.heartbeat()");
          await wait('window.__connectionTest.activeReads === 1');
          await evaluate("window.__connectionTest.pause = false; window.__connectionTest.mode = 'success'");
          await switchTo(7717);
          await wait("document.querySelector('.shell') && document.querySelector('.environment-trigger').textContent.includes('7717')");
          await evaluate('window.__connectionTest.releases.shift()()');
          await wait('window.__connectionTest.activeReads === 0');
          assert.equal(await evaluate("document.querySelector('.instance-connection-notice')"), null, 'Ignore failures from the previous instance');
          await evaluate("localStorage.setItem('working-memory.desktop.composer-draft:test-7719', 'Saved destination draft'); window.__connectionTest.mode = 'timeout'");
          await switchTo(7719);
          await wait("document.querySelector('.instance-connection')?.textContent.includes('10 seconds')");
          await evaluate("window.__connectionTest.openResource('workstream', 'stale-environment-link'); window.__connectionTest.pauseWorkspace = true; window.__connectionTest.mode = 'success'; window.__connectionTest.heartbeat()");
          await wait("document.querySelector('textarea[aria-label=Message]')?.value === 'Saved destination draft'");
          await wait("window.__connectionTest.activeLoads === 1");
          await evaluate(\`{ const composer = document.querySelector('textarea[aria-label=Message]');
            composer.value += ' continued'; composer.dispatchEvent(new Event('input', { bubbles: true })); }\`);
          assert.equal(await evaluate("localStorage.getItem('working-memory.desktop.composer-draft:test-7719')"), 'Saved destination draft continued');
          await evaluate("window.__connectionTest.pauseWorkspace = false");
          await switchTo(7717);
          await wait("document.querySelector('.shell') && document.querySelector('.environment-trigger').textContent.includes('7717')");
          await evaluate("window.__connectionTest.workspaceReleases.shift()()");
          await wait("window.__connectionTest.activeLoads === 0");
          assert.equal(await evaluate("window.__connectionTest.opened.length"), 0, 'A stale recovery must not open the queued link in another environment');
          const startup = new BrowserWindow({ show: false });
          await startup.loadURL('http://127.0.0.1:${address.port}/connection-test.html?startup=timeout');
          await waitStartup("document.querySelector('.instance-connection')?.textContent.includes('10 seconds')");
          assert.equal(await startup.webContents.executeJavaScript("document.querySelector('.shell')"), null);
          await startup.webContents.executeJavaScript(\`
            localStorage.setItem('working-memory.desktop.composer-draft:test-7717', 'Saved startup draft');
            window.__connectionTest.openResource('workstream', 'queued-link');
            window.__connectionTest.mode = 'success'; window.__connectionTest.pauseWorkspace = true;
            window.__connectionTest.heartbeat();\`);
          await waitStartup("window.__connectionTest.activeLoads === 1");
          assert.equal(await startup.webContents.executeJavaScript("document.querySelector('textarea[aria-label=Message]').value"), 'Saved startup draft');
          await startup.webContents.executeJavaScript(\`
            window.__connectionTest.authenticated = false;
            window.__connectionTest.authenticationChanged({ mcpUrl: 'http://127.0.0.1:7717/mcp', authenticated: false });
            window.__connectionTest.pauseWorkspace = false; window.__connectionTest.workspaceReleases.shift()();\`);
          await waitStartup("document.querySelector('.instance-connection input[type=password]') && window.__connectionTest.activeLoads === 0");
          assert.equal(await startup.webContents.executeJavaScript("window.__connectionTest.opened.length"), 0, 'Revocation must not consume the pending link');
          await startup.webContents.executeJavaScript(\`{ const password = document.querySelector('input[type=password]');
            password.value = 'test-owner-password'; password.dispatchEvent(new Event('input', { bubbles: true }));
            password.form.requestSubmit(); }\`);
          await waitStartup("document.querySelector('.shell') && window.__connectionTest.streamStarts === 1");
          await waitStartup("window.__connectionTest.opened.length === 1 && document.body.innerText.includes('Recovered link')");
          assert.deepEqual(await startup.webContents.executeJavaScript("window.__connectionTest.opened"), [
            { kind: 'workstream', identifier: 'queued-link', environment: 0 },
          ]);
          await startup.webContents.executeJavaScript("window.__connectionTest.heartbeat()");
          await delay(50);
          assert.equal(await startup.webContents.executeJavaScript("window.__connectionTest.opened.length"), 1);
          const offline = new BrowserWindow({ show: false });
          await offline.loadURL('http://127.0.0.1:${address.port}/connection-test.html?offline=true');
          await waitStartup("window.__connectionTest.discoveries === 1 && typeof window.__connectionTest.heartbeat === 'function'", offline);
          assert.equal(await offline.webContents.executeJavaScript("window.__connectionTest.reads"), 0);
          await offline.webContents.executeJavaScript("window.__connectionTest.heartbeat(); window.__connectionTest.heartbeat()");
          await waitStartup("window.__connectionTest.discoveries === 2", offline);
          await offline.webContents.executeJavaScript("window.__connectionTest.offline = false; window.__connectionTest.heartbeat()");
          await waitStartup("document.querySelector('.shell') && window.__connectionTest.streamStarts === 1", offline);
          assert.equal(await offline.webContents.executeJavaScript("window.__connectionTest.current"), 1, 'Recover the intended target, not the first discovered environment');
          assert.equal(await offline.webContents.executeJavaScript("document.querySelector('textarea[aria-label=Message]').value"), 'Saved destination draft continued');
          assert.equal(await offline.webContents.executeJavaScript("window.__connectionTest.maxReads"), 1);
          for (const mode of ['setup', 'login']) {
            const signedOut = new BrowserWindow({ show: false });
            await signedOut.loadURL('http://127.0.0.1:${address.port}/connection-test.html?signedOut=' + mode);
            await waitStartup("document.querySelector('.instance-connection input[type=password]')", signedOut);
            assert.equal(await signedOut.webContents.executeJavaScript("document.querySelectorAll('input[type=password]').length"), mode === 'setup' ? 2 : 1);
            assert.equal(await signedOut.webContents.executeJavaScript("document.querySelector('.shell')"), null);
            assert.equal(await signedOut.webContents.executeJavaScript("window.__connectionTest.streamStarts"), 0);
            signedOut.destroy();
          }
          await evaluate("window.__connectionTest.mode = 'timeout'; window.__connectionTest.heartbeat()");
          await wait("!!document.querySelector('.instance-connection-notice')");
          const openObservability = "Array.from(document.querySelectorAll('.instance-connection-notice button')).find(button => button.textContent === 'Open Observability').click()";
          await evaluate(openObservability);
          await wait("document.querySelector('[aria-label=\\"Feature flags\\"]')");
          assert.ok(await evaluate("document.body.innerText.includes('Enable Observability in the Features tab in Settings')"));
          assert.equal(await evaluate("window.__connectionTest.mounts.length"), 0);
          await evaluate("window.__connectionTest.observability = true");
          await evaluate(openObservability);
          await wait("window.__connectionTest.mounts.length === 1");
          assert.equal(await evaluate("window.__connectionTest.mounts[0][0]"), 'observability-0');
          assert.ok(await evaluate("!!document.querySelector('.container-app-dashboard')"));
          assert.equal(await evaluate("document.querySelector('[aria-label=\\"Feature flags\\"]')"), null);
          await evaluate("window.__connectionTest.missingObservability = true");
          await evaluate(openObservability);
          await wait("document.body.innerText.includes('Observability Container App is missing')");
          assert.equal(await evaluate("window.__connectionTest.mounts.length"), 1);
          await evaluate("window.__connectionTest.failFeatures = true");
          await evaluate(openObservability);
          await wait("document.body.innerText.includes('Feature status unavailable')");
          assert.equal(await evaluate("window.__connectionTest.mounts.length"), 1);
          offline.destroy();
          startup.destroy();
          window.destroy();
          async function waitStartup(code, target = startup) {
            const until = Date.now() + 10_000;
            while (Date.now() < until) {
              if (await target.webContents.executeJavaScript(code)) return;
              await delay(20);
            }
            throw new Error('Startup recovery timed out: ' + code);
          }
          console.log('connection-browser: workspace, drafts, retry, startup, revocation and environment isolation passed');
          app.exit(0);
        }).catch(error => { console.error(error); app.exit(1); });
      `);
      const { stdout, stderr } = await promisify(execFile)(executable, [script], {
        timeout: 60_000, env: { ...process.env, ELECTRON_RUN_AS_NODE: '' },
      });
      expect(stdout, stderr).toContain('connection-browser: workspace, drafts, retry, startup, revocation and environment isolation passed');
    } finally {
      await server.close();
      await rm(directory, { recursive: true, force: true });
    }
  }, 90_000,
);
