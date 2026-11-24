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
        enabled: false, search: false, observability: false, topicPlacementAutoLoad: true, writes: [], reads: 0, activeReads: 0, maxReads: 0, changes: [],
        pauseRead: false, releaseRead: null, failSave: false, failPoll: false,
        featurePollError: 'Feature refresh failed', featureSaveError: 'Feature save failed',
        embeddings: false, embeddingActions: [], failEmbeddingSave: false, failEmbeddingPoll: false, repairFailure: false,
        ownershipConflict: false, recoveries: 0, inspections: 0, timeout: false,
        reports: [], sends: [], failReport: false,
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
          const result = { hostTasks: state.enabled, search: state.search, observability: state.observability,
            topicPlacementAutoLoad: state.topicPlacementAutoLoad };
          try {
            if (state.pauseRead) {
              state.pauseRead = false;
              await new Promise(resolve => state.releaseRead = resolve);
            }
            if (state.failPoll) throw new Error(state.featurePollError);
            return result;
          } finally { state.activeReads--; }
        },
        async setInstanceFeatures(input) {
          if (state.timeout) throw new Error('podman info did not respond within 30s. This does not confirm that Podman is stopped.');
          if (input.observability !== undefined && state.ownershipConflict) throw new Error('Container App ownership conflict');
          if (state.failSave) { state.failSave = false; throw new Error(state.featureSaveError); }
          state.writes.push(input);
          if (input.hostTasks !== undefined) state.enabled = input.hostTasks;
          if (input.search !== undefined) state.search = input.search;
          if (input.observability !== undefined) state.observability = input.observability;
          if (input.topicPlacementAutoLoad !== undefined) state.topicPlacementAutoLoad = input.topicPlacementAutoLoad;
          return { hostTasks: state.enabled, search: state.search, observability: state.observability,
            topicPlacementAutoLoad: state.topicPlacementAutoLoad };
        },
        async listContainerApps() { return [{ id: 'observability-claim', nativeSurface: 'observability' }]; },
        async inspectContainerApp() { state.inspections++; return { id: 'observability-claim', recoveryAvailable: state.ownershipConflict }; },
        async recoverContainerApp() {
          state.recoveries++; state.ownershipConflict = false;
          return { id: 'observability-claim', recoveryAvailable: false, error: null };
        },
        async createFeatureBugReport(input) {
          state.reports.push(input);
          if (state.failReport) throw new Error('Report storage unavailable');
          return { id: 'feature-report', title: 'Feature settings bug', body: 'podman info timeout with command timings' };
        },
        async getPublicFeedbackSettings() { return { enabled: true, state: 'connected', destination: 'https://feedback.example/api' }; },
        async prepareFeedback() { return { destination: 'feedback.example',
          context: { desktop: { version: 'fixture', build: 'fixture' }, backend: { version: 'fixture' } } }; },
        async sendFeedback(...args) { state.sends.push(args); return { status: 'queued', requestId: args[1], destination: 'feedback.example', uploadedAt: new Date().toISOString() }; },
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
      cacheDir: join(directory, 'vite-cache'), optimizeDeps: { include: ['svelte', 'zod'] },
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
          const window = new BrowserWindow({ show: false, webPreferences: { backgroundThrottling: false } });
          const evaluate = async code => {
            try { return await window.webContents.executeJavaScript(code); }
            catch (error) { throw new Error('Renderer evaluation failed: ' + code, { cause: error }); }
          };
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
          assert.equal(await evaluate("document.querySelectorAll('.hint').length"), 0);
          assert.equal(await evaluate("document.querySelector('[role=switch]').checked"), false);
          assert.equal(await evaluate("document.querySelectorAll('[role=switch]').length"), 5);
          const search = "document.querySelector('[aria-label=\\"Working Memory search\\"]')";
          const embeddings = "document.querySelector('[aria-label=Embeddings]')";
          assert.equal(await evaluate(search + '.checked'), false);
          assert.equal(await evaluate(search + '.disabled'), false);
          assert.equal(await evaluate(embeddings + '.checked'), false);
          assert.equal(await evaluate(embeddings + '.disabled'), true);
          const placement = "document.querySelector('[aria-label=\\"Automatic topic placement suggestions\\"]')";
          assert.equal(await evaluate(placement + '.checked'), true);
          await evaluate(placement + '.click()');
          await wait("!window.__featuresTest.topicPlacementAutoLoad && !document.querySelector('[role=switch]').disabled");
          assert.deepEqual(await evaluate("window.__featuresTest.writes.at(-1)"), { topicPlacementAutoLoad: false });
          assert.equal(await evaluate("window.__featuresTest.search"), false);
          assert.equal(await evaluate("window.__featuresTest.embeddings"), false);
          await evaluate("window.__featuresTest.failSave = true; " + placement + '.click()');
          await wait("document.querySelector('.feature-error-message')?.textContent === 'Feature save failed'");
          assert.equal(await evaluate(placement + '.checked'), false);
          await evaluate(placement + '.click()');
          await wait("window.__featuresTest.topicPlacementAutoLoad && !document.querySelector('[role=alert]')");
          await evaluate("document.querySelector('[aria-label=\\"Observability Container App\\"]').click()");
          await wait("window.__featuresTest.observability && !document.querySelector('[role=switch]').disabled");
          assert.deepEqual(await evaluate("window.__featuresTest.writes.at(-1)"), { observability: true });
          assert.equal(await evaluate("document.querySelector('[aria-label=Embeddings]').disabled"), true);
          assert.equal(await evaluate(search + '.checked'), false);
          assert.equal(await evaluate(search + '.disabled'), false);
          await evaluate(search + '.click()');
          await wait("window.__featuresTest.search && !document.querySelector('[role=switch]').disabled");
          assert.deepEqual(await evaluate("window.__featuresTest.writes.at(-1)"), { search: true });
          assert.equal(await evaluate("window.__featuresTest.enabled"), false);
          await wait("!document.querySelector('[aria-label=Embeddings]').disabled");
          await evaluate("document.querySelector('[aria-label=Embeddings]').click()");
          await wait("window.__featuresTest.embeddings && !document.querySelector('[aria-label=Embeddings]').disabled");
          assert.deepEqual(await evaluate("window.__featuresTest.embeddingActions"), ['enable']);
          await evaluate("window.__featuresTest.failEmbeddingSave = true; document.querySelector('[aria-label=Embeddings]').click()");
          await wait("document.querySelector('.feature-error-message')?.textContent === 'Embedding enable failed'");
          assert.equal(await evaluate("document.querySelector('[aria-label=Embeddings]').checked"), true);
          await evaluate("window.__featuresTest.repairFailure = true; window.__featuresTest.remount()");
          await wait("document.querySelector('[role=alert]')?.textContent.includes('Automatic WSL route repair failed: Private WSL route blocked')");
          assert.equal(await evaluate("document.querySelector('[aria-label=Embeddings]').checked"), true);
          assert.equal(await evaluate("document.querySelector('[aria-label=Embeddings]').disabled"), false);
          await evaluate("document.querySelector('[aria-label=Embeddings]').click()");
          await wait("!window.__featuresTest.embeddings && !document.querySelector('[role=alert]')");
          assert.deepEqual(await evaluate("window.__featuresTest.embeddingActions"), ['enable', 'disable']);
          await evaluate("window.__featuresTest.failEmbeddingPoll = true");
          await wait("document.querySelector('.feature-error-message')?.textContent === 'Embedding feature unavailable'");
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
          await wait("document.querySelector('.feature-error-message')?.textContent === 'Feature save failed'");
          assert.equal(await evaluate("document.querySelector('[role=switch]').checked"), false);
          await delay(2200);
          assert.equal(await evaluate("document.querySelector('.feature-error-message').textContent"), 'Feature save failed');
          await evaluate("document.querySelector('[role=switch]').click()");
          await wait("!document.querySelector('[role=alert]') && window.__featuresTest.enabled");
          await evaluate("window.__featuresTest.failPoll = true");
          await wait("document.querySelector('.feature-error-message')?.textContent === 'Feature refresh failed'");
          await evaluate("window.__featuresTest.failPoll = false; window.__featuresTest.enabled = false");
          await wait("!document.querySelector('[role=alert]') && !document.querySelector('[role=switch]').checked");
          assert.equal(await evaluate("window.__featuresTest.maxReads"), 1);
          assert.equal(await evaluate("window.__featuresTest.search"), true);
          await evaluate("window.__featuresTest.observability = false");
          await wait("!document.querySelector('[aria-label=\\"Observability Container App\\"]').checked");
          const inspectionsBeforeTimeout = await evaluate("window.__featuresTest.inspections");
          await evaluate("window.__featuresTest.timeout = true; document.querySelector('[aria-label=\\"Observability Container App\\"]').click()");
          await wait("document.querySelector('.feature-error-message')?.textContent.includes('podman info did not respond')");
          await wait("!document.querySelector('[aria-label=\\"Observability Container App\\"]').disabled");
          assert.equal(await evaluate("window.__featuresTest.inspections"), inspectionsBeforeTimeout);
          assert.equal(await evaluate("document.querySelector('[aria-label=\\"Observability Container App\\"]').checked"), false);
          assert.equal(await evaluate("(()=>{const c=getComputedStyle(document.querySelector('.feature-error')).color.match(/[0-9]+/g).map(Number);return c[0]>c[1]*2&&c[0]>c[2]*2;})()"), true);
          await evaluate("document.querySelector('.feature-error .report-bug-link').click()");
          await wait("document.querySelector('dialog:modal textarea')");
          await evaluate("window.__featuresTest.timeout=false;window.__featuresTest.observability=true;window.__featuresTest.failReport=true;(()=>{const t=document.querySelector('dialog textarea');t.value='Observability is stuck';t.dispatchEvent(new Event('input',{bubbles:true}));})()");
          await evaluate("Array.from(document.querySelectorAll('button')).find(b=>b.textContent.trim()==='Send bug report').click()");
          await wait("document.querySelector('dialog [role=alert]')?.textContent.includes('Report storage unavailable')");
          await evaluate("window.__featuresTest.failReport=false;Array.from(document.querySelectorAll('button')).find(b=>b.textContent.trim()==='Send bug report').click()");
          await wait("document.querySelector('details pre')");
          const report = await evaluate("window.__featuresTest.reports.at(-1)");
          assert.equal(report.failure.error.includes('podman info'), true);
          assert.equal(report.failure.operation, 'instance:set-features');
          assert.equal(report.failure.features.observability, false);
          assert.deepEqual(report.failure.requested, {feature:'observability',enabled:true});
          await wait("window.__featuresTest.sends.length===1 && Array.from(document.querySelectorAll('button')).some(b=>b.textContent.trim()==='Done')");
          await evaluate("Array.from(document.querySelectorAll('button')).find(b=>b.textContent.trim()==='Done').click()");
          await wait("!document.querySelector('dialog')");
          await evaluate("window.__featuresTest.observability=false;window.__featuresTest.remount()");
          await wait("document.querySelector('[aria-label=\\"Observability Container App\\"]')?.disabled===false");
          await evaluate("window.__featuresTest.ownershipConflict = true; document.querySelector('[aria-label=\\"Observability Container App\\"]').click()");
          await wait("Array.from(document.querySelectorAll('button')).some(button => button.textContent === 'Recover…' && !button.disabled)");
          await evaluate("Array.from(document.querySelectorAll('button')).find(button => button.textContent === 'Recover…').click()");
          await wait("window.__featuresTest.recoveries === 1 && Array.from(document.querySelectorAll('[role=status]')).some(e=>e.textContent.includes('Enable Observability'))");
          assert.equal(await evaluate("document.querySelector('.feature-error')"), null);
          assert.equal(await evaluate("window.__featuresTest.observability"), false);
          await evaluate("document.querySelector('[aria-label=\\"Observability Container App\\"]').click()");
          await wait("window.__featuresTest.observability && !document.querySelector('[role=alert]')");
          // Failed initialization is explicit; recovery still allows Search first, then Embeddings.
          const embeddingActionsBeforeRecovery = await evaluate("window.__featuresTest.embeddingActions.length");
          await evaluate("Object.assign(window.__featuresTest, { enabled:false, search:false, embeddings:false, failPoll:true, featurePollError:'Sign in to this instance again.' }); window.__featuresTest.remount()");
          await wait("document.querySelector('.feature-error-message')?.textContent === 'Sign in to this instance again.'");
          assert.equal(await evaluate(search + '.disabled'), true);
          assert.equal(await evaluate(embeddings + '.disabled'), true);
          await evaluate("window.__featuresTest.failPoll=false; window.__featuresTest.failEmbeddingPoll=true");
          await wait("document.querySelector('.feature-error-message')?.textContent === 'Embedding feature unavailable' && !document.querySelector('[aria-label=\\"Working Memory search\\"]').disabled");
          assert.equal(await evaluate(search + '.checked'), false);
          assert.equal(await evaluate(embeddings + '.disabled'), true);
          await evaluate(search + '.click()');
          await wait("window.__featuresTest.search && !document.querySelector('[aria-label=\\"Working Memory search\\"]').disabled");
          assert.equal(await evaluate("window.__featuresTest.embeddingActions.length"), embeddingActionsBeforeRecovery);
          await evaluate("window.__featuresTest.failEmbeddingPoll=false");
          await wait("!document.querySelector('[role=alert]') && !document.querySelector('[aria-label=Embeddings]').disabled");
          await evaluate(embeddings + '.click()');
          await wait("window.__featuresTest.embeddings && !document.querySelector('[aria-label=Embeddings]').disabled");
          assert.equal(await evaluate("window.__featuresTest.embeddingActions.at(-1)"), 'enable');
          await evaluate("window.__featuresTest.failSave=true; window.__featuresTest.featureSaveError='Sign in as the instance owner to change features.'; " + search + '.click()');
          await wait("document.querySelector('.feature-error-message')?.textContent === 'Sign in as the instance owner to change features.'");
          assert.equal(await evaluate(search + '.checked'), true);
          await evaluate("window.__featuresTest.dispose()");
          const finalReads = await evaluate("window.__featuresTest.reads");
          await delay(2200);
          assert.equal(await evaluate("window.__featuresTest.reads"), finalReads);
          console.log('features-browser: automatic refresh, no overlap, stale guards, rollback, errors and cleanup passed');
          window.destroy();
          app.exit(0);
        }).catch(error => { console.error(error); app.exit(1); });
      `);
      const { stdout, stderr } = await promisify(execFile)(executable, [script], {
        timeout: 40_000, env: { ...process.env, ELECTRON_RUN_AS_NODE: '' },
      });
      expect(stdout, stderr).toContain('features-browser: automatic refresh, no overlap, stale guards, rollback, errors and cleanup passed');
    } finally {
      await server.close();
      await rm(directory, { recursive: true, force: true });
    }
  }, 45_000,
);
