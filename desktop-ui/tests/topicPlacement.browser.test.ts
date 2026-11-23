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
  'lazily suggests one styled placement, guards stale requests, and retains manual retry and explicit CAS apply',
  async () => {
    const executable: unknown = createRequire(import.meta.url)('electron');
    if (typeof executable !== 'string') throw new Error('Electron executable is unavailable.');
    const directory = join(process.cwd(), `.placement-browser-${randomUUID()}`);
    await mkdir(directory);
    const fixture = `
      import { mount } from 'svelte';
      import Harness from '/placement-harness.svelte';
      import '/src/renderer/style.css';
      import '@vscode/codicons/dist/codicon.css';
      mount(Harness, {target: document.getElementById('app')});
    `;
    const harness = `<script>
      import Placement from '/src/renderer/documents/TopicPlacement.svelte';
      import TopicView from '/src/renderer/documents/TopicView.svelte';
      const state = $state({
        phase: 'ready', applied: [], refreshes: 0, calls: 0, autoLoad: true, saved: true,
        id: 'topic', version: 3, environment: 'first', editable: true,
        pause: true, releases: [], failSuggest: false, failApply: false, opened: [], responseVersion: null,
        fullView: false, draft: false, search: true, saves: []
      });
      window.__placementTest = state;
      window.workingMemory = {
        async suggestTopicPlacement(id) {
          state.calls++;
          const value = { state: ['ready', 'fallback', 'empty'].includes(state.phase) ? 'ready' : state.phase,
            sourceVersion: state.responseVersion ?? state.version, limited: false,
            suggestions: state.phase === 'ready' || state.phase === 'fallback' ? [{
              parent: state.phase === 'fallback' ? null : {id: 'parent', title: 'Recommended parent', resourceVersion: 5},
              workstream: {id: 'ws', title: 'Recommended workstream', resourceVersion: 7},
              similarity: 0.8, confidence: {level: 'high', reason: 'Supporting passage agrees'},
              excerpt: 'Matched authored content', evidence: 'parent-membership'
            }, {
              parent: {id: 'second', title: 'Lower-ranked parent', resourceVersion: 8},
              workstream: {id: 'second-ws', title: 'Lower-ranked workstream', resourceVersion: 9},
              similarity: 0.7, confidence: {level: 'medium', reason: 'Less similar'},
              excerpt: 'Second excerpt', evidence: 'parent-membership'
            }] : [] };
          if (state.pause) {
            state.pause = false;
            await new Promise(resolve => state.releases.push(resolve));
          }
          if (state.failSuggest) throw new Error('Placement service unavailable');
          return value;
        },
        async applyTopicPlacement(input) {
          state.applied.push(input);
          if (state.failApply) throw new Error('Conflict: parent changed. Suggest placement again.');
        }
      };
    </script>
    {#if state.fullView}
      <TopicView topic={{
        kind: 'topic', id: state.id, title: 'Saved topic', body: '# Stored source', resourceVersion: state.version,
        editable: state.editable, topicType: 'topic', typeMeta: null, topicTypes: [], status: 'open',
        parents: [], children: [], workstreams: [], focusedWorkstreams: [], agentMessages: [], createdAt: 0, updatedAt: 0
      }} saveState={state.saved ? 'saved' : 'pending'} draft={state.draft}
        placementAutoLoad={state.search && state.autoLoad} placementEnvironment={state.environment}
        onSaveTopic={patch => state.saves.push(patch)}
        onOpenTopic={id => state.opened.push(id)} onOpenWorkstream={id => state.opened.push(id)}
        onSetAgentMessageStatus={() => { throw new Error('Unexpected status mutation'); }}
        onTopicAdded={async () => { state.refreshes++; }} />
    {:else}
    <h1>Saved topic renders immediately</h1>
    <Placement id={state.id} title="New topic" resourceVersion={state.version} editable={state.editable}
      autoLoad={state.autoLoad} environment={state.environment} saved={state.saved}
      onOpenTopic={id => state.opened.push(id)} onOpenWorkstream={id => state.opened.push(id)}
      onApplied={async () => { state.refreshes++; }} />
    {/if}
    `;
    const vite = await createServer({
      configFile: false, root: process.cwd(), logLevel: 'error',
      cacheDir: join(directory, 'vite-cache'), optimizeDeps: { include: [
        'svelte', 'zod', 'markdown-it', 'turndown', 'chrono-node',
        '@codemirror/commands', '@codemirror/lang-markdown', '@codemirror/language',
        '@codemirror/state', '@codemirror/view', '@lezer/highlight', '@lezer/markdown',
      ] },
      plugins: [
        svelte(),
        { name: 'placement-fixture', configureServer(server) {
          server.middlewares.use((req, res, next) => {
            if (req.url !== '/placement-test') { next(); return; }
            res.setHeader('Content-Type', 'text/html');
            res.end('<div id="app"></div><script type="module" src="/placement-fixture.js"></script>');
          });
        }, resolveId(id) {
          if (id === '/placement-fixture.js') return '\0placement-fixture';
          if (id === '/placement-harness.svelte') return id;
        },
        load(id) {
          if (id === '\0placement-fixture') return fixture;
          if (id === '/placement-harness.svelte') return harness;
        } },
      ],
      server: { host: '127.0.0.1', port: 0 }, appType: 'custom',
    });
    try {
      await vite.listen();
      const address = vite.httpServer!.address();
      if (!address || typeof address === 'string') throw new Error('Browser fixture address unavailable.');
      const main = join(directory, 'main.cjs');
      await writeFile(main, `
        const { app, BrowserWindow } = require('electron');
        const assert = require('node:assert/strict');
        app.setPath('userData', ${JSON.stringify(join(directory, 'profile'))});
        app.whenReady().then(async () => {
          const window = new BrowserWindow({show: false, webPreferences: {contextIsolation: false}});
          window.webContents.on('console-message', event => console.error(event.message));
          const evaluate = async text => {
            try { return await window.webContents.executeJavaScript(text); }
            catch (error) { throw new Error('Renderer evaluation failed: ' + text, { cause: error }); }
          };
          const wait = async text => {
            for (let i = 0; i < 400; i++) {
              if (await evaluate(text)) return;
              await new Promise(resolve => setTimeout(resolve, 25));
            }
            throw new Error('Timed out: ' + text + '\\n' + await evaluate('document.body.innerText')
              + '\\n' + await evaluate('JSON.stringify(performance.getEntriesByType("resource").filter(e=>e.responseStatus>=400).map(e=>({name:e.name,status:e.responseStatus})))'));
          };
          const button = label => '[...document.querySelectorAll("button")].find(b => b.textContent.trim() === ' + JSON.stringify(label) + ')';
          try {
            await window.loadURL('http://127.0.0.1:${address.port}/placement-test');
            await wait('window.__placementTest?.calls === 1 && document.querySelector(".topic-placement")');
            assert.equal(await evaluate('document.querySelector("h1").textContent'), 'Saved topic renders immediately');
            assert.equal(await evaluate('document.querySelectorAll("article").length'), 0);
            assert.equal(await evaluate('window.__placementTest.applied.length'), 0);
            await evaluate('window.__placementTest.releases.shift()()');
            await wait('document.querySelector("article")');
            assert.equal(await evaluate('document.querySelectorAll("article").length'), 1);
            assert.equal(await evaluate('document.querySelectorAll("input[type=radio]").length'), 0);
            assert.equal(await evaluate('document.body.innerText.includes("Lower-ranked")'), false);
            assert.equal(await evaluate('!!document.querySelector(".topic-link .codicon-symbol-key")'), true);
            assert.equal(await evaluate('!!document.querySelector(".ws-chip .codicon-briefcase")'), true);
            assert.equal(await evaluate('document.querySelector("article details").open'), false);
            await evaluate('document.querySelector(".topic-link").click(); document.querySelector(".ws-chip").click()');
            assert.deepEqual(await evaluate('[...window.__placementTest.opened]'), ['parent', 'ws']);
            await new Promise(resolve => setTimeout(resolve, 100));
            assert.equal(await evaluate('window.__placementTest.calls'), 1);
            assert.equal(await evaluate('window.__placementTest.applied.length'), 0);
            // Feature-off suppresses automatic requests but not explicit retry.
            await evaluate('window.__placementTest.autoLoad = false');
            await wait('!document.querySelector("article")');
            assert.equal(await evaluate('window.__placementTest.calls'), 1);
            await evaluate('window.__placementTest.phase = "disabled"');
            await evaluate(button('Suggest Placement') + '.click()');
            await wait('document.querySelector(".topic-placement").innerText.includes("disabled")');
            await evaluate('window.__placementTest.phase = "pending"; ' + button('Refresh placement') + '.click()');
            await wait('document.querySelector(".topic-placement").innerText.includes("waiting")');
            assert.equal(await evaluate('document.querySelectorAll("article").length'), 0);
            await evaluate('window.__placementTest.phase = "empty"; ' + button('Refresh placement') + '.click()');
            await wait('document.body.innerText.includes("No sufficiently similar")');
            await evaluate('window.__placementTest.failSuggest = true; ' + button('Refresh placement') + '.click()');
            await wait('document.querySelector("[role=alert]")?.innerText.includes("service unavailable")');
            await evaluate('window.__placementTest.failSuggest = false; window.__placementTest.phase = "ready"; ' + button('Suggest Placement') + '.click()');
            await wait('document.querySelector("article")?.innerText.includes("Recommended parent")');
            await evaluate('window.__placementTest.responseVersion = 2; ' + button('Refresh placement') + '.click()');
            await wait('document.querySelector("[role=alert]")?.innerText.includes("topic changed")');
            assert.equal(await evaluate('document.querySelectorAll("article").length'), 0);
            await evaluate('window.__placementTest.responseVersion = null; ' + button('Suggest Placement') + '.click()');
            await wait('document.querySelector("article")');
            await evaluate('window.__placementTest.editable = false');
            await wait(button('Apply placement') + '.disabled === true');
            await evaluate('window.__placementTest.editable = true');
            await wait(button('Apply placement') + '.disabled === false');
            await evaluate('window.__placementTest.failApply = true; ' + button('Apply placement') + '.click()');
            await wait('document.querySelector("[role=alert]")?.innerText.includes("parent changed")');
            assert.deepEqual(await evaluate('JSON.parse(JSON.stringify(window.__placementTest.applied[0]))'), {
              id: 'topic', expectedResourceVersion: 3,
              parent: {id: 'parent', resourceVersion: 5}, workstream: {id: 'ws', resourceVersion: 7}
            });
            await evaluate(button('Bug Report') + '.click()');
            await wait('document.querySelector("dialog[open]")');
            assert.ok(await evaluate('document.querySelector("dialog").innerText.includes("selected parent and workstream")'));
            await evaluate('document.querySelector("dialog").dispatchEvent(new Event("cancel", {cancelable: true}))');
            await wait('!document.querySelector("dialog")');
            await evaluate('window.__placementTest.failApply = false; ' + button('Apply placement') + '.click()');
            await wait('window.__placementTest.refreshes === 1');
            assert.equal(await evaluate('document.querySelectorAll("article").length'), 0);
            const callsAfterApply = await evaluate('window.__placementTest.calls');
            await new Promise(resolve => setTimeout(resolve, 100));
            assert.equal(await evaluate('window.__placementTest.calls'), callsAfterApply);
            // Workstream-only fallback remains an explicit usable placement.
            await evaluate('window.__placementTest.phase = "fallback"; ' + button('Suggest Placement') + '.click()');
            await wait('document.querySelector("article")?.innerText.includes("No new parent")');
            await evaluate(button('Apply placement') + '.click()');
            await wait('window.__placementTest.refreshes === 2');
            assert.equal(await evaluate('window.__placementTest.applied.at(-1).parent'), null);
            // A saved-source revision, environment or topic change invalidates pending responses.
            for (const change of ['version++', 'environment = "second"', 'id = "other-topic"']) {
              await evaluate('window.__placementTest.phase = "ready"; window.__placementTest.pause = true; ' + button('Suggest Placement') + '.click()');
              await wait('window.__placementTest.releases.length === 1');
              await evaluate('window.__placementTest.' + change);
              await wait('!document.querySelector("article") && !document.querySelector(".topic-placement").innerText.includes("Suggesting")');
              await evaluate('window.__placementTest.releases.shift()()');
              await new Promise(resolve => setTimeout(resolve, 75));
              assert.equal(await evaluate('document.querySelectorAll("article").length'), 0);
            }
            // Switching auto-load off during a request rejects its late result.
            await evaluate('window.__placementTest.pause = true; window.__placementTest.autoLoad = true');
            await wait('window.__placementTest.releases.length === 1');
            await evaluate('window.__placementTest.autoLoad = false');
            await wait('!document.querySelector(".topic-placement").innerText.includes("Suggesting")');
            await evaluate('window.__placementTest.releases.shift()()');
            await new Promise(resolve => setTimeout(resolve, 75));
            assert.equal(await evaluate('document.querySelectorAll("article").length'), 0);
            await evaluate(button('Suggest Placement') + '.click()');
            await wait('document.querySelector("article")');
            // Unsaved edits never auto-fetch or enable Apply.
            const beforeUnsaved = await evaluate('window.__placementTest.calls');
            await evaluate('window.__placementTest.saved = false; window.__placementTest.autoLoad = true');
            await wait(button('Suggest Placement') + '.disabled === true');
            assert.equal(await evaluate('window.__placementTest.calls'), beforeUnsaved);
            await evaluate('window.__placementTest.saved = true');
            await wait('window.__placementTest.calls === ' + (beforeUnsaved + 1) + ' && document.querySelector("article")');
            assert.equal(await evaluate('window.__placementTest.applied.length'), 3);
            // Validate the real saved-topic integration, including readiness gating and draft exclusion.
            const beforeTopicView = await evaluate('window.__placementTest.calls');
            await evaluate('window.__placementTest.pause = true; window.__placementTest.editable = false; window.__placementTest.fullView = true');
            await wait('window.__placementTest.calls === ' + (beforeTopicView + 1) + ' && window.__placementTest.releases.length === 1');
            assert.equal(await evaluate('document.querySelector("h1.title").textContent'), 'Saved topic');
            assert.equal(await evaluate('document.body.innerText.includes("Stored source")'), true);
            assert.equal(await evaluate('window.__placementTest.saves.length'), 0);
            await evaluate('window.__placementTest.releases.shift()()');
            await wait('document.querySelector("article")');
            assert.equal(await evaluate(button('Apply placement') + '.disabled'), true);
            const beforeSearchOff = await evaluate('window.__placementTest.calls');
            await evaluate('window.__placementTest.search = false; window.__placementTest.version++');
            await wait('!document.querySelector("article")');
            assert.equal(await evaluate('window.__placementTest.calls'), beforeSearchOff);
            await evaluate(button('Suggest Placement') + '.click()');
            await wait('window.__placementTest.calls === ' + (beforeSearchOff + 1) + ' && document.querySelector("article")');
            await evaluate('window.__placementTest.draft = true');
            await wait('!document.querySelector(".topic-placement")');
            assert.equal(await evaluate('window.__placementTest.saves.length'), 0);
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
