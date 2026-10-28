import { expect, it } from 'vitest';
import { createServer } from 'vite';
import { svelte } from '@sveltejs/vite-plugin-svelte';
import { createRequire } from 'node:module';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

it.skipIf(process.platform === 'linux' && !process.env.DISPLAY)(
  'refreshes features automatically without overlapping polls, stale updates or hidden save failures',
  async () => {
    const executable: unknown = createRequire(import.meta.url)('electron');
    if (typeof executable !== 'string') throw new Error('Electron executable is unavailable.');
    const directory = await mkdtemp(join(tmpdir(), 'working-memory-features-browser-'));
    const fixture = `
      import { mount, unmount } from 'svelte';
      import Features from '/src/renderer/documents/FeaturesView.svelte';
      import '/src/renderer/style.css';
      const state = window.__featuresTest = {
        enabled: false, reads: 0, activeReads: 0, maxReads: 0, changes: [],
        pauseRead: false, releaseRead: null, failSave: false, failPoll: false,
      };
      window.workingMemory = {
        async getInstanceFeatures() {
          state.reads++;
          state.maxReads = Math.max(state.maxReads, ++state.activeReads);
          const result = { hostTasks: state.enabled };
          try {
            if (state.pauseRead) {
              state.pauseRead = false;
              await new Promise(resolve => state.releaseRead = resolve);
            }
            if (state.failPoll) throw new Error('Feature refresh failed');
            return result;
          } finally { state.activeReads--; }
        },
        async setInstanceFeatures(input) {
          if (state.failSave) { state.failSave = false; throw new Error('Feature save failed'); }
          state.enabled = input.hostTasks;
          return { hostTasks: state.enabled };
        },
      };
      const target = document.createElement('main');
      target.className = 'settings';
      document.body.append(target);
      const component = mount(Features, { target, props: {
        onChanged: features => state.changes.push(features.hostTasks),
      } });
      state.dispose = () => unmount(component);
    `;
    const server = await createServer({
      configFile: false, root: new URL('..', import.meta.url).pathname,
      cacheDir: join(directory, 'vite-cache'), optimizeDeps: { include: ['svelte'] },
      plugins: [svelte(), {
        name: 'features-browser-fixture',
        resolveId: id => id === '/features-fixture.js' ? '\0features-fixture' : undefined,
        load: id => id === '\0features-fixture' ? fixture : undefined,
        configureServer(server) {
          server.middlewares.use((req, res, next) => {
            if (req.url !== '/features-test.html') { next(); return; }
            res.setHeader('content-type', 'text/html');
            res.end('<!doctype html><html><body><script type="module" src="/features-fixture.js"></script></body></html>');
          });
        },
      }],
      server: { host: '127.0.0.1', port: 0 }, appType: 'custom',
    });
    try {
      await server.listen();
      const address = server.httpServer?.address();
      if (!address || typeof address === 'string') throw new Error('Features fixture did not bind a TCP port.');
      const script = join(directory, 'features-test.cjs');
      await writeFile(script, `
        const { app, BrowserWindow } = require('electron');
        const assert = require('node:assert/strict');
        app.setPath('userData', ${JSON.stringify(join(directory, 'profile'))});
        app.whenReady().then(async () => {
          const window = new BrowserWindow({ show: false });
          const evaluate = code => window.webContents.executeJavaScript(code);
          const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
          async function wait(code) {
            const until = Date.now() + 7000;
            while (Date.now() < until) {
              if (await evaluate(code)) return;
              await delay(20);
            }
            throw new Error('Timed out: ' + code + '\\n' + await evaluate('document.body.innerText'));
          }
          await window.loadURL('http://127.0.0.1:${address.port}/features-test.html');
          await wait("document.querySelector('[role=switch]') && !document.querySelector('[role=switch]').disabled");
          assert.equal(await evaluate("document.querySelectorAll('button').length"), 0);
          assert.equal(await evaluate("document.querySelector('[role=switch]').checked"), false);
          await evaluate("window.__featuresTest.enabled = true");
          await wait("document.querySelector('[role=switch]').checked");
          assert.equal(await evaluate("window.__featuresTest.changes.at(-1)"), true);
          await evaluate("window.__featuresTest.pauseRead = true");
          await wait("typeof window.__featuresTest.releaseRead === 'function'");
          const reads = await evaluate("window.__featuresTest.reads");
          await delay(2200);
          assert.equal(await evaluate("window.__featuresTest.reads"), reads);
          await evaluate("document.querySelector('[role=switch]').click()");
          await wait("!document.querySelector('[role=switch]').disabled && !window.__featuresTest.enabled");
          await evaluate("window.__featuresTest.releaseRead()");
          await delay(100);
          assert.equal(await evaluate("document.querySelector('[role=switch]').checked"), false);
          assert.equal(await evaluate("window.__featuresTest.changes.at(-1)"), false);
          await evaluate("window.__featuresTest.failSave = true; document.querySelector('[role=switch]').click()");
          await wait("document.querySelector('[role=alert]')?.textContent === 'Feature save failed'");
          assert.equal(await evaluate("document.querySelector('[role=switch]').checked"), false);
          await delay(2200);
          assert.equal(await evaluate("document.querySelector('[role=alert]').textContent"), 'Feature save failed');
          await evaluate("document.querySelector('[role=switch]').click()");
          await wait("!document.querySelector('[role=alert]') && window.__featuresTest.enabled");
          await evaluate("window.__featuresTest.failPoll = true");
          await wait("document.querySelector('[role=alert]')?.textContent === 'Feature refresh failed'");
          await evaluate("window.__featuresTest.failPoll = false; window.__featuresTest.enabled = false");
          await wait("!document.querySelector('[role=alert]') && !document.querySelector('[role=switch]').checked");
          assert.equal(await evaluate("window.__featuresTest.maxReads"), 1);
          await evaluate("window.__featuresTest.dispose()");
          const finalReads = await evaluate("window.__featuresTest.reads");
          await delay(2200);
          assert.equal(await evaluate("window.__featuresTest.reads"), finalReads);
          console.log('features-browser: automatic refresh, no overlap, stale guards, rollback, errors and cleanup passed');
          window.destroy();
          app.exit(0);
        }).catch(error => { console.error(error); app.exit(1); });
      `);
      const { stdout } = await promisify(execFile)(executable, [script], {
        timeout: 25_000, env: { ...process.env, ELECTRON_RUN_AS_NODE: '' },
      });
      expect(stdout).toContain('features-browser: automatic refresh, no overlap, stale guards, rollback, errors and cleanup passed');
    } finally {
      await server.close();
      await rm(directory, { recursive: true, force: true });
    }
  }, 30_000,
);
