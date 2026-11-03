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
  'renders Diagnostics telemetry and keeps locally queued reports visible when the backend is unavailable',
  async () => {
    const executable: unknown = createRequire(import.meta.url)('electron');
    if (typeof executable !== 'string') throw new Error('Electron executable is unavailable.');
    const directory = await mkdtemp(join(tmpdir(), 'wm-diagnostics-browser-'));
    const fixture = `
      import { mount } from 'svelte';
      import Settings from '/src/renderer/documents/SettingsView.svelte';
      const instance = {
        version: '1.4.1', startedAt: Date.now(),
        runtime: { heapUsedBytes: 60 * 1048576, heapLimitBytes: 100 * 1048576, rssBytes: 80 * 1048576,
          eventLoopMaxMs: 1100, activeSessions: 2, activeRequests: 1, admissionBlocked: true },
        minutes: [{ at: Date.now(), transactions: 42, errors: 3, averageMs: 100, maxMs: 3500 }],
        callers: [{ caller: 'client:approved-id', route: '/mcp', status: 503, transactions: 3 }],
        events: [{ sequence: 1, at: Date.now(), code: 'mcp_admission_rejected', route: '/mcp',
          status: 503, durationMs: 10, count: 3, requestId: 'correlated-request-id' }],
      };
      const state = window.__diagnosticsTest = { offline: false, calls: 0 };
      window.workingMemory = {
        async getInstanceDiagnostics() {
          state.calls++;
          return { instance: state.offline ? null : instance, error: state.offline ? 'Backend unavailable' : null,
            incidents: [{ id: 'incident-id', at: Date.now(), kind: 'outage', evidence: 'Three health probes failed.',
              topicId: state.offline ? null : 'topic-id', deliveryError: state.offline ? 'Waiting for recovery' : null }] };
        },
      };
      const target = document.createElement('main'); document.body.append(target);
      mount(Settings, { target, props: {
        profiles: [], routing: {}, humanName: 'Test', credentialStorage: 'secure', settingsStatus: '', saving: false,
        testingProfileId: null, onHumanName() {}, onAddProfile() {}, onRemoveProfile() {},
        async onTestProfile() {}, onChange() {}, onFlush() {}, selectedMcpUrl: 'http://127.0.0.1:7719/mcp',
        async onMakeCurrent() {}, async onInstancesChanged() {}, onFeaturesChanged() {}, tab: 'diagnostics',
      } });
    `;
    const server = await createServer({
      configFile: false, root: fileURLToPath(new URL('..', import.meta.url)), cacheDir: join(directory, 'vite-cache'),
      resolve: { dedupe: ['svelte', 'zod'] }, optimizeDeps: { include: ['svelte', 'zod'] },
      plugins: [svelte(), {
        name: 'diagnostics-fixture',
        resolveId: id => id === '/diagnostics-fixture.js' ? '\0diagnostics-fixture' : undefined,
        load: id => id === '\0diagnostics-fixture' ? fixture : undefined,
        configureServer(server) {
          server.middlewares.use((req, res, next) => {
            if (req.url !== '/diagnostics-test.html') { next(); return; }
            res.setHeader('content-type', 'text/html');
            res.end('<!doctype html><html><body><script type="module" src="/diagnostics-fixture.js"></script></body></html>');
          });
        },
      }],
      server: { host: '127.0.0.1', port: 0, fs: { allow: [fileURLToPath(new URL('../..', import.meta.url))] } },
      appType: 'custom',
    });
    try {
      await server.listen();
      const address = server.httpServer?.address();
      if (!address || typeof address === 'string') throw new Error('Browser fixture did not bind.');
      const script = join(directory, 'diagnostics-test.cjs');
      await writeFile(script, `
        const { app, BrowserWindow } = require('electron');
        const assert = require('node:assert/strict');
        app.setPath('userData', ${JSON.stringify(join(directory, 'profile'))});
        app.whenReady().then(async () => {
          const window = new BrowserWindow({ show: false, webPreferences: { contextIsolation: true } });
          const evaluate = code => window.webContents.executeJavaScript(code);
          async function wait(code) {
            const deadline = Date.now() + 7000;
            while (Date.now() < deadline) {
              if (await evaluate(code)) return;
              await new Promise(resolve => setTimeout(resolve, 20));
            }
            throw new Error('Timed out: ' + code + '\\n' + await evaluate('document.body.innerText'));
          }
          await window.loadURL('http://127.0.0.1:${address.port}/diagnostics-test.html');
          await wait("document.body.innerText.includes('correlated-request-id')");
          assert.equal(await evaluate("document.querySelector('[role=tab][aria-selected=true]').textContent"), 'Diagnostics');
          assert.equal(await evaluate("document.querySelectorAll('table').length"), 3);
          const text = await evaluate('document.body.innerText');
          for (const value of ['42', '503', '60.0 MiB', '1100 ms', 'client:approved-id', '60% heap safety cutoff']) {
            assert.ok(text.includes(value), value + ' missing');
          }
          assert.equal(await evaluate("document.querySelector('a').getAttribute('href')"), 'working-memory://open/topic/topic-id');
          assert.equal(await evaluate("Array.from(document.querySelectorAll('button')).some(b => b.textContent.trim() === 'Save')"), false);
          await evaluate("window.__diagnosticsTest.offline = true; Array.from(document.querySelectorAll('button')).find(b => b.textContent.trim() === 'Refresh').click()");
          await wait("document.body.innerText.includes('Queued for Inbox')");
          assert.equal(await evaluate("document.querySelector('[role=alert]').textContent"), 'Backend unavailable');
          assert.equal(await evaluate("document.querySelectorAll('table').length"), 0);
          assert.ok((await evaluate('document.body.innerText')).includes('Waiting for recovery'));
          window.destroy();
          console.log('diagnostics-browser-ok');
          app.quit();
        }).catch(error => { console.error(error); app.exit(1); });
      `);
      const { stdout } = await promisify(execFile)(executable, [script], {
        env: { ...process.env, ELECTRON_RUN_AS_NODE: '' }, timeout: 30000, maxBuffer: 1024 * 1024,
      });
      expect(stdout).toContain('diagnostics-browser-ok');
    } finally {
      await server.close();
      await rm(directory, { recursive: true, force: true });
    }
  }, 45000,
);
