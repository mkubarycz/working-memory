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
      import { LocalEmbeddings } from '/src/main/localEmbeddings';
      import '/src/renderer/style.css';
      const state = window.__featuresTest = {
        enabled: false, search: false, writes: [], reads: 0, activeReads: 0, maxReads: 0, changes: [],
        pauseRead: false, releaseRead: null, failSave: false, failPoll: false,
        embeddings: false, embeddingActions: [], failEmbeddingSave: false, failEmbeddingPoll: false, repairFailure: false,
      };
      const localEmbeddings = new LocalEmbeddings(() => ({
        endpoint: 'http://127.0.0.1:7717/mcp',
        client: { async callTool(name) {
          if (name !== 'wm-embeddings-dashboard') throw new Error('Unexpected embedding request');
          return { ok: true, result: {
            endpoint: 'http://host.docker.internal:7716', enabled: state.embeddings, paused: false,
            configurationKey: 'd'.repeat(64),
            phase: state.repairFailure ? 'error' : state.embeddings ? 'indexing' : 'disabled',
            model: 'minilm-l6-v2:1110a243:384:v1', downloadBytes: 0, downloadTotal: 90871461,
            backend: null, warning: null, rssBytes: null, lastInferenceMs: null, lastSuccessAtMs: null, stats: null,
            error: state.repairFailure ? 'Host inference service unavailable: connection refused' : null,
          } };
        } },
      }), {
        async restore() {},
        async ensure() { throw new Error('Private WSL route blocked'); },
        readSettings: () => ({ idleTimeoutMinutes: null }),
        async setRetention() {},
        usesWslNetworking: () => true,
      });
      window.workingMemory = {
        async getEmbeddingDashboard() {
          if (state.failEmbeddingPoll) throw new Error('Embedding feature unavailable');
          return localEmbeddings.snapshot();
        },
        async setEmbeddingAction(action) {
          if (state.failEmbeddingSave) { state.failEmbeddingSave = false; throw new Error('Embedding enable failed'); }
          state.embeddingActions.push(action);
          state.embeddings = action === 'enable';
          state.repairFailure = false;
          return { enabled: state.embeddings };
        },
        async getInstanceFeatures() {
          state.reads++;
          state.maxReads = Math.max(state.maxReads, ++state.activeReads);
          const result = { hostTasks: state.enabled, search: state.search };
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
          state.writes.push(input);
          if (input.hostTasks !== undefined) state.enabled = input.hostTasks;
          if (input.search !== undefined) state.search = input.search;
          return { hostTasks: state.enabled, search: state.search };
        },
      };
      const target = document.createElement('main');
      target.className = 'settings';
      document.body.append(target);
      const mountFeatures = () => mount(Features, { target, props: {
        onChanged: features => state.changes.push(features.hostTasks),
      } });
      let component = mountFeatures();
      state.remount = async () => { await unmount(component); component = mountFeatures(); };
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
          assert.equal(await evaluate("document.querySelectorAll('[role=switch]').length"), 3);
          assert.equal(await evaluate("document.querySelector('[aria-label=Embeddings]').disabled"), true);
          assert.equal(await evaluate('document.querySelectorAll("[role=switch]")[1].checked'), false);
          assert.equal(await evaluate('document.querySelectorAll("[role=switch]")[1].getAttribute("aria-label")'), 'Working Memory search');
          await evaluate('document.querySelectorAll("[role=switch]")[1].click()');
          await wait("window.__featuresTest.search && !document.querySelector('[role=switch]').disabled");
          assert.deepEqual(await evaluate("window.__featuresTest.writes.at(-1)"), { search: true });
          assert.equal(await evaluate("window.__featuresTest.enabled"), false);
          await wait("!document.querySelector('[aria-label=Embeddings]').disabled");
          await evaluate("document.querySelector('[aria-label=Embeddings]').click()");
          await wait("window.__featuresTest.embeddings && !document.querySelector('[aria-label=Embeddings]').disabled");
          assert.deepEqual(await evaluate("window.__featuresTest.embeddingActions"), ['enable']);
          await evaluate("window.__featuresTest.failEmbeddingSave = true; document.querySelector('[aria-label=Embeddings]').click()");
          await wait("document.querySelector('[role=alert]')?.textContent === 'Embedding enable failed'");
          assert.equal(await evaluate("document.querySelector('[aria-label=Embeddings]').checked"), true);
          await evaluate("window.__featuresTest.repairFailure = true; window.__featuresTest.remount()");
          await wait("document.querySelector('[role=alert]')?.textContent.includes('Automatic WSL route repair failed: Private WSL route blocked')");
          assert.equal(await evaluate("document.querySelector('[aria-label=Embeddings]').checked"), true);
          assert.equal(await evaluate("document.querySelector('[aria-label=Embeddings]').disabled"), false);
          await evaluate("document.querySelector('[aria-label=Embeddings]').click()");
          await wait("!window.__featuresTest.embeddings && !document.querySelector('[role=alert]')");
          assert.deepEqual(await evaluate("window.__featuresTest.embeddingActions"), ['enable', 'disable']);
          await evaluate("window.__featuresTest.failEmbeddingPoll = true");
          await wait("document.querySelector('[role=alert]')?.textContent === 'Embedding feature unavailable'");
          assert.equal(await evaluate("document.querySelector('[aria-label=Embeddings]').disabled"), true);
          assert.equal(await evaluate("document.querySelector('[aria-label=\\"Host tasks\\"]').disabled"), false);
          await evaluate("window.__featuresTest.failEmbeddingPoll = false");
          await wait("!document.querySelector('[role=alert]') && !document.querySelector('[aria-label=Embeddings]').disabled");
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
          assert.equal(await evaluate("window.__featuresTest.search"), true);
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
