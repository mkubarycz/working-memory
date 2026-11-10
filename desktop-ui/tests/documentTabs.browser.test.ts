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
  'reorders actual desktop tabs, persists order and preserves selection, previews and close actions',
  async () => {
    const executable: unknown = createRequire(import.meta.url)('electron');
    if (typeof executable !== 'string') throw new Error('Electron executable is unavailable.');
    const directory = await mkdtemp(join(tmpdir(), 'working-memory-tabs-browser-'));
    const fixture = `
      import { mount } from 'svelte';
      import App from '/src/renderer/App.svelte';
      import '/src/renderer/style.css';
      const state = window.__tabsTest = {};
      const model = (kind, id) => ({ kind, id, title: state.titles?.[id] ?? id, status: 'open',
        createdAt: 1, updatedAt: 1, closure: null, resourceVersion: state.version ?? 1, editable: !!state.editable,
        topics: [], tree: [], agentMessages: [] });
      const environment = { id: 'tab-test', port: 7717, displayName: 'Tab test',
        mcpUrl: 'http://127.0.0.1:7717/mcp', source: 'sandbox' };
      const storageKey = 'working-memory.desktop.document-tabs:v1:tab-test';
      if (!localStorage.getItem(storageKey)) localStorage.setItem(storageKey, JSON.stringify({
        version: 1, tabs: ['first', 'second', 'third', 'fourth'].map(identifier => ({ kind: 'workstream', identifier })),
        selectedKey: 'workstream:second',
      }));
      window.workingMemory = {
        getDesktopBuildInfo: async () => null,
        getConfig: async () => ({ endpoint: '', model: '', hasApiKey: false,
          credentialStorage: 'session', humanName: '', profiles: [], routing: {} }),
        getOpenAiHealth: async () => ({ state: 'unreachable', result: 'Not configured', observedAt: Date.now() }),
        discoverEnvironments: async () => ({ environments: [environment], selected: environment }),
        getInstanceIdentity: async () => ({ environment: 'http://127.0.0.1:7717',
          passwordConfigured: true, passwordHint: '', setupAvailable: true, authenticated: true }),
        onInstanceAuthenticationChanged: () => () => {},
        onOpenResource: listener => { state.open = listener; return () => {}; },
        openResource: async (kind, id) => {
          (state.reads ??= []).push(id);
          if (state.hold === id) await new Promise(resolve => { state.release = () => { state.hold = null; resolve(); }; });
          if (state.fail === id) { state.fail = null; throw new Error('Synthetic refresh failure'); }
          return model(kind, id);
        },
        saveWorkstream: async (id, patch) => {
          await new Promise(resolve => { state.finishSave = resolve; });
          (state.titles ??= {})[id] = patch.title;
          state.version = 2;
          return model('workstream', id);
        },
        onDocumentChanges: listener => { state.change = listener; return () => {}; },
        onResourceDragResult: () => () => {},
        getBackendHealth: async () => ({ state: 'healthy', endpoint: environment.mcpUrl,
          result: 'OK', observedAt: Date.now(), source: 'sandbox' }),
        getActivePanel: async () => ({ tab: 'active', items: [], emptyMessage: 'No workstreams.' }),
        getChatHistory: async () => ({ journals: [] }),
        getAgentMessages: async () => [],
        listContainerApps: async () => [],
        getInstanceFeatures: async () => ({ hostTasks: false, search: false }),
        getInstanceAccess: async () => ({ requests: [], clients: [] }),
        startDocumentChanges: async () => {},
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
        name: 'tabs-browser-fixture',
        resolveId: id => id === '/tabs-fixture.js' ? '\0tabs-fixture' : undefined,
        load: id => id === '\0tabs-fixture' ? fixture : undefined,
        configureServer(server) {
          server.middlewares.use((req, res, next) => {
            if (req.url !== '/tabs-test.html') { next(); return; }
            res.setHeader('content-type', 'text/html');
            res.end('<!doctype html><html><body><script type="module" src="/tabs-fixture.js"></script></body></html>');
          });
        },
      }],
      server: { host: '127.0.0.1', port: 0 }, appType: 'custom',
    });
    try {
      await server.listen();
      const address = server.httpServer?.address();
      if (!address || typeof address === 'string') throw new Error('Tab fixture did not bind a TCP port.');
      const script = join(directory, 'tabs-test.cjs');
      await writeFile(script, `
        const { app, BrowserWindow } = require('electron');
        const assert = require('node:assert/strict');
        app.setPath('userData', ${JSON.stringify(join(directory, 'profile'))});
        app.whenReady().then(async () => {
          const window = new BrowserWindow({ show: false, width: 1400, height: 900 });
          window.webContents.on('console-message', event => console.error(event.message));
          const evaluate = code => window.webContents.executeJavaScript(code);
          const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
          async function wait(code) {
            const until = Date.now() + 10_000;
            while (Date.now() < until) {
              if (await evaluate(code)) return;
              await delay(20);
            }
            throw new Error('Timed out: ' + code + '\\n' + await evaluate('document.body.innerText'));
          }
          const order = () => evaluate('Array.from(document.querySelectorAll(".document-tab-select")).map(tab => tab.textContent.trim())');
          const selected = () => evaluate('document.querySelector(".document-tab.selected .document-tab-select").textContent.trim()');
          const persisted = () => evaluate('JSON.parse(localStorage.getItem("working-memory.desktop.document-tabs:v1:tab-test"))');
          async function drag(source, target, after, cancel = false) {
            await evaluate(\`(() => {
              const headers = [...document.querySelectorAll('.document-tab-select')];
              const source = headers.find(tab => tab.textContent.trim() === \${JSON.stringify(source)});
              window.__tabDragSource = source;
              const target = headers.find(tab => tab.textContent.trim() === \${JSON.stringify(target)});
              const bounds = target.closest('.document-tab').getBoundingClientRect();
              const dataTransfer = window.__tabDrag = new DataTransfer();
              source.dispatchEvent(new DragEvent('dragstart', { bubbles: true, cancelable: true, dataTransfer }));
              const clientX = \${after} ? bounds.right - 2 : bounds.left + 2;
              window.__tabDropX = clientX;
              target.dispatchEvent(new DragEvent('dragover', { bubbles: true, cancelable: true, dataTransfer, clientX }));
            })()\`);
            await wait('document.querySelector(".document-tab.drop-before, .document-tab.drop-after") !== null');
            await evaluate(\`(() => {
              const strip = document.querySelector('.document-tabs');
              if (!\${cancel}) strip.dispatchEvent(new DragEvent('drop', {
                bubbles: true, cancelable: true, dataTransfer: window.__tabDrag, clientX: window.__tabDropX,
              }));
              window.__tabDragSource.dispatchEvent(new DragEvent('dragend', { bubbles: true, dataTransfer: window.__tabDrag }));
            })()\`);
            await wait('document.querySelector(".document-tab.dragging, .document-tab.drop-before, .document-tab.drop-after") === null');
          }
          const url = 'http://127.0.0.1:${address.port}/tabs-test.html';
          await window.loadURL(url);
          await wait('document.querySelectorAll(".document-tab").length === 4');
          assert.equal(await selected(), 'second');
          assert.equal(await evaluate('document.querySelector(".document-tab-select").draggable'), true);
          assert.equal(await evaluate('document.querySelector(".document-tab-close").draggable'), false);

          await drag('first', 'fourth', true);
          assert.deepEqual(await order(), ['second', 'third', 'fourth', 'first']);
          assert.equal(await selected(), 'second');
          assert.deepEqual((await persisted()).tabs.map(tab => tab.identifier), ['second', 'third', 'fourth', 'first']);
          await drag('first', 'third', false);
          assert.deepEqual(await order(), ['second', 'first', 'third', 'fourth']);
          await drag('fourth', 'second', false, true);
          assert.deepEqual(await order(), ['second', 'first', 'third', 'fourth']);
          assert.equal(await selected(), 'second');

          assert.equal(await evaluate(\`(() => {
            const dataTransfer = new DataTransfer();
            dataTransfer.setData('text/uri-list', 'working-memory://open/topic/foreign');
            const event = new DragEvent('dragover', { bubbles: true, cancelable: true, dataTransfer });
            document.querySelector('.document-tabs').dispatchEvent(event);
            return event.defaultPrevented;
          })()\`), false);
          await window.loadURL(url);
          await wait('document.querySelectorAll(".document-tab").length === 4');
          assert.deepEqual(await order(), ['second', 'first', 'third', 'fourth']);
          assert.equal(await selected(), 'second');

          await evaluate('window.__tabsTest.open("workstream", "preview")');
          await wait('document.querySelector(".document-tab.preview") !== null');
          await drag('preview', 'fourth', true);
          assert.deepEqual(await order(), ['second', 'first', 'third', 'fourth', 'preview']);
          assert.equal(await selected(), 'preview');
          assert.equal(await evaluate('document.querySelector(".document-tab.preview .document-tab-select").textContent.trim()'), 'preview');
          assert.equal((await persisted()).tabs.length, 4);
          await evaluate('window.__tabsTest.open("workstream", "next-preview")');
          await wait('document.querySelector(".document-tab.preview .document-tab-select")?.textContent.trim() === "next-preview"');
          assert.deepEqual(await order(), ['second', 'first', 'third', 'fourth', 'next-preview']);

          await evaluate('document.querySelectorAll(".document-tab-select")[1].dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: 400, clientY: 40 }))');
          await wait('document.querySelector(".document-tab-menu") !== null');
          await evaluate('Array.from(document.querySelectorAll(".document-tab-menu button")).find(button => button.textContent.includes("Close to the Right")).click()');
          await wait('document.querySelectorAll(".document-tab").length === 2');
          assert.deepEqual(await order(), ['second', 'first']);
          assert.equal(await selected(), 'first');
          await evaluate('document.querySelector(".document-tab-close").click()');
          await wait('document.querySelectorAll(".document-tab").length === 1');
          assert.deepEqual(await order(), ['first']);
          await evaluate('window.__tabsTest.open("workstream", "second")');
          await wait('document.querySelector(".document-tab.selected .document-tab-select").textContent.trim() === "second"');
          const change = () => evaluate('window.__tabsTest.change({mcpUrl:"http://127.0.0.1:7717/mcp",change:{resourceVersion:2,reset:false,changes:[{kind:"Workstream",id:"first",resourceVersion:2,deleted:false}]}})');
          const select = id => evaluate(\`Array.from(document.querySelectorAll(".document-tab-select")).find(tab => tab.textContent.trim() === \${JSON.stringify(id)}).click()\`);
          await evaluate('window.__tabsTest.reads = []');
          await change();
          await wait('window.__tabsTest.reads.length === 1');
          await delay(150);
          assert.deepEqual(await evaluate('window.__tabsTest.reads'), ['second']);
          await evaluate('window.__tabsTest.hold = "first"');
          await select('first');
          await wait('document.querySelector(".document-refresh-status") !== null');
          assert.equal(await selected(), 'first');
          assert.deepEqual(await evaluate('window.__tabsTest.reads'), ['second', 'first']);
          await evaluate('window.__tabsTest.release()');
          await wait('document.querySelector(".document-refresh-status") === null');
          await select('second');
          await delay(150);
          assert.deepEqual(await evaluate('window.__tabsTest.reads'), ['second', 'first']);
          await evaluate('window.__tabsTest.reads = []');
          await change();
          await wait('window.__tabsTest.reads.length === 1');
          assert.deepEqual(await evaluate('window.__tabsTest.reads'), ['second']);
          await evaluate('window.__tabsTest.fail = "first"');
          await select('first');
          await wait('document.querySelector(".live-update-error")?.textContent.includes("Synthetic refresh failure")');
          await select('second');
          await select('first');
          await wait('window.__tabsTest.reads.filter(id => id === "first").length === 2');
          await wait('document.querySelector(".document-refresh-status") === null');
          await wait('document.querySelector(".live-update-error") === null');
          assert.equal(await selected(), 'first');
          await evaluate('window.__tabsTest.editable = true');
          await change();
          await wait('document.querySelector(".document-host .title-input") !== null');
          await evaluate(\`(() => {
            window.__tabsTest.reads = [];
            const input = document.querySelector('input[aria-label="Workstream title"]');
            input.value = 'Local draft';
            input.dispatchEvent(new Event('input', { bubbles: true }));
          })()\`);
          await wait('typeof window.__tabsTest.finishSave === "function"');
          await change();
          await delay(250);
          assert.deepEqual(await evaluate('window.__tabsTest.reads'), []);
          assert.equal(await evaluate('document.querySelector(".document-host .title-input").value'), 'Local draft');
          await select('second');
          await evaluate('window.__tabsTest.finishSave()');
          await delay(150);
          assert.deepEqual(await evaluate('window.__tabsTest.reads'), ['second']);
          await evaluate('window.__tabsTest.open("workstream", "first")');
          await wait('window.__tabsTest.reads.includes("first")');
          await wait('document.querySelector(".document-refresh-status") === null');
          assert.equal(await evaluate('document.querySelector(".document-host .title-input").value'), 'Local draft');
          console.log('tabs-browser: reorder, cancellation, persistence, previews and close actions passed');
          console.log('tabs-browser: activation refresh, cached content and retry passed');
          console.log('tabs-browser: unsaved edits and inactive save completion passed');
          window.destroy();
          app.exit(0);
        }).catch(error => { console.error(error); app.exit(1); });
      `);
      const { stdout, stderr } = await promisify(execFile)(executable, [script], {
        timeout: 60_000, env: { ...process.env, ELECTRON_RUN_AS_NODE: '' },
      });
      expect(stdout, stderr).toContain('tabs-browser: reorder, cancellation, persistence, previews and close actions passed');
      expect(stdout, stderr).toContain('tabs-browser: activation refresh, cached content and retry passed');
      expect(stdout, stderr).toContain('tabs-browser: unsaved edits and inactive save completion passed');
    } finally {
      await server.close();
      await rm(directory, { recursive: true, force: true });
    }
  }, 90_000,
);
