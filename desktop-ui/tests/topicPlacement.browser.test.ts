import { it } from 'vitest';
import { createServer } from 'vite';
import { svelte } from '@sveltejs/vite-plugin-svelte';
import { createRequire } from 'node:module';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';

it.skipIf(process.platform === 'linux' && !process.env.DISPLAY)(
  'offers explicit placement selection, applies captured versions, and exposes shared bug reporting',
  async () => {
    const executable: unknown = createRequire(import.meta.url)('electron');
    if (typeof executable !== 'string') throw new Error('Electron executable is unavailable.');
    const directory = join(process.cwd(), `.placement-browser-${randomUUID()}`);
    await mkdir(directory);
    const fixture = `
      import { mount } from 'svelte';
      import Placement from '/src/renderer/documents/TopicPlacement.svelte';
      const state = window.__placementTest = { phase: 'disabled', applied: [], refreshes: 0 };
      window.workingMemory = {
        async suggestTopicPlacement(id) {
          return { state: state.phase, sourceVersion: 3, limited: false,
            suggestions: state.phase === 'ready' ? [{
              parent: {id: 'parent', title: 'Recommended parent', resourceVersion: 5},
              workstream: {id: 'ws', title: 'Recommended workstream', resourceVersion: 7},
              similarity: 0.8, confidence: {level: 'high', reason: 'Supporting passage agrees'},
              excerpt: 'Matched authored content', evidence: 'parent-membership'
            }] : [] };
        },
        async applyTopicPlacement(input) {
          state.applied.push(input);
          if (state.failApply) throw new Error('Conflict: parent changed. Suggest placement again.');
        }
      };
      mount(Placement, {target: document.getElementById('app'), props: {
        id: 'topic', title: 'New topic', resourceVersion: 3, editable: true,
        onOpenTopic() {}, onOpenWorkstream() {}, async onApplied() { state.refreshes++; }
      }});
    `;
    const vite = await createServer({
      configFile: false, root: process.cwd(), logLevel: 'error',
      plugins: [
        svelte(),
        { name: 'placement-fixture', configureServer(server) {
          server.middlewares.use('/placement-fixture.js', async (_req, res, next) => {
            try {
              const transformed = await server.transformRequest('/@placement-fixture');
              res.setHeader('Content-Type', 'application/javascript');
              res.end(transformed?.code);
            } catch (error) { next(error); }
          });
          server.middlewares.use('/placement-test', (_req, res) => {
            res.setHeader('Content-Type', 'text/html');
            res.end('<div id="app"></div><script type="module" src="/placement-fixture.js"></script>');
          });
        }, resolveId(id) { if (id === '/@placement-fixture') return id; },
        load(id) { if (id === '/@placement-fixture') return fixture; } },
      ],
      server: { host: '127.0.0.1', port: 0 },
    });
    try {
      await vite.listen();
      const address = vite.httpServer!.address();
      if (!address || typeof address === 'string') throw new Error('Browser fixture address unavailable.');
      const main = join(directory, 'main.cjs');
      await writeFile(main, `
        const { app, BrowserWindow } = require('electron');
        const assert = require('node:assert/strict');
        app.whenReady().then(async () => {
          const window = new BrowserWindow({show: false, webPreferences: {contextIsolation: false}});
          const evaluate = text => window.webContents.executeJavaScript(text);
          const wait = async text => {
            for (let i = 0; i < 200; i++) {
              if (await evaluate(text)) return;
              await new Promise(resolve => setTimeout(resolve, 25));
            }
            throw new Error('Timed out: ' + text);
          };
          const button = label => '[...document.querySelectorAll("button")].find(b => b.textContent.trim() === ' + JSON.stringify(label) + ')';
          try {
            await window.loadURL('http://127.0.0.1:${address.port}/placement-test');
            await wait('document.querySelector(".topic-placement")');
            assert.equal(await evaluate('window.__placementTest.applied.length'), 0);
            await evaluate(button('Suggest Placement') + '.click()');
            await wait('document.querySelector(".topic-placement").innerText.includes("disabled")');
            await evaluate('window.__placementTest.phase = "pending"; ' + button('Suggest Placement') + '.click()');
            await wait('document.querySelector(".topic-placement").innerText.includes("waiting")');
            assert.equal(await evaluate('document.querySelectorAll("article").length'), 0);
            await evaluate('window.__placementTest.phase = "ready"; ' + button('Suggest Placement') + '.click()');
            await wait('document.querySelector("article")?.innerText.includes("Recommended parent")');
            assert.equal(await evaluate(button('Apply selected placement') + '.disabled'), true);
            await evaluate('document.querySelector("input[type=radio]").click()');
            await wait(button('Apply selected placement') + '.disabled === false');
            await evaluate('window.__placementTest.failApply = true; ' + button('Apply selected placement') + '.click()');
            await wait('document.querySelector("[role=alert]")?.innerText.includes("parent changed")');
            assert.deepEqual(await evaluate('window.__placementTest.applied[0]'), {
              id: 'topic', expectedResourceVersion: 3,
              parent: {id: 'parent', resourceVersion: 5}, workstream: {id: 'ws', resourceVersion: 7}
            });
            await evaluate(button('Bug Report') + '.click()');
            await wait('document.querySelector("dialog[open]")');
            assert.ok(await evaluate('document.querySelector("dialog").innerText.includes("selected parent and workstream")'));
            await evaluate('document.querySelector("dialog").dispatchEvent(new Event("cancel", {cancelable: true}))');
            await wait('!document.querySelector("dialog")');
            await evaluate('window.__placementTest.failApply = false; ' + button('Apply selected placement') + '.click()');
            await wait('window.__placementTest.refreshes === 1');
            assert.equal(await evaluate('document.querySelectorAll("article").length'), 0);
            window.destroy(); app.exit(0);
          } catch (error) { console.error(error); window.destroy(); app.exit(1); }
        });
      `);
      const env = { ...process.env };
      delete env.ELECTRON_RUN_AS_NODE;
      await promisify(execFile)(executable, [main], { env, timeout: 45000 });
    } finally { await vite.close(); await rm(directory, { recursive: true, force: true }); }
  }, 60000,
);
