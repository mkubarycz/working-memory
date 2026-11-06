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

function fixtureModuleSpecifier(filename: string): string {
  return JSON.stringify(`/@fs/${filename.replaceAll('\\', '/')}`);
}

it.each([
  ['C:\\Working Memory\\shared\\panelData.ts', '/@fs/C:/Working Memory/shared/panelData.ts'],
  ['C:\\quoted"name\\workstreamViewModel.ts', '/@fs/C:/quoted"name/workstreamViewModel.ts'],
  ['/Users/test/shared/panelData.ts', '/@fs//Users/test/shared/panelData.ts'],
])('quotes portable Vite filesystem imports for %s', (filename, expected) => {
  expect(fixtureModuleSpecifier(filename)).toBe(JSON.stringify(expected));
  expect(JSON.parse(fixtureModuleSpecifier(filename))).toBe(expected);
});

it.skipIf(process.platform === 'linux' && !process.env.DISPLAY)(
  'delivers pinned navigation, scoped autosaves, closed-parent filtering and workstream-view moves in the actual App',
  async () => {
    const executable: unknown = createRequire(import.meta.url)('electron');
    if (typeof executable !== 'string') throw new Error('Electron executable is unavailable.');
    const directory = await mkdtemp(join(tmpdir(), 'working-memory-preferences-browser-'));
    const fixture = `
      import { mount } from 'svelte';
      import App from '/src/renderer/App.svelte';
      import { buildWorkstreamPanels } from ${fixtureModuleSpecifier(fileURLToPath(new URL('../../shared/panelData.ts', import.meta.url)))};
      import { loadWorkstreamViewModel } from ${fixtureModuleSpecifier(fileURLToPath(new URL('../../shared/viewModels/workstreamViewModel.ts', import.meta.url)))};
      import '/src/renderer/style.css';
      const ws = (id, title, status) => ({ id, title, status, position: 0, closure: null,
        opened_at: 1, updated_at: 1, closed_at: null, resourceVersion: 1 });
      const topic = (id, title, status, parents = []) => ({ id, title, status, parents,
        body: '', topicType: 'type', workstreams: ['inbox', 'first'], focusedWorkstreams: [],
        created_at: 1, updated_at: 1, resourceVersion: 1 });
      const state = window.__preferences = { saves: [], transfers: [], reparents: [], nativeDrags: [],
        workstreams: [ws('first', 'First', 'progress'), ws('inbox', 'Inbox', 'backlog'),
          ws('target', 'Target', 'progress'), ws('later', 'Later', 'backlog')],
        topics: [topic('closed', 'Closed parent', 'closed'),
          topic('child', 'Open child', 'open', ['closed']), topic('copy', 'Copy me', 'open'),
          { ...topic('reparent', 'Reparent me', 'open'), workstreams: ['target'] }],
      };
      const client = {
        wsRead: async ({ id } = {}) => state.workstreams.filter(ws => !id || ws.id === id),
        topicRead: async ({ workstream } = {}) => state.topics.filter(topic => !workstream || topic.workstreams.includes(workstream)),
        topicTypeRead: async () => [], agentMessageRead: async () => [],
      };
      const load = id => loadWorkstreamViewModel(client, id);
      const environment = { id: 'preferences-test', port: 7717, displayName: 'Preferences test',
        mcpUrl: 'http://127.0.0.1:7717/mcp', source: 'sandbox' };
      localStorage.setItem('working-memory.desktop.document-tabs:v1:preferences-test', JSON.stringify({
        version: 1, tabs: [{ kind: 'workstream', identifier: 'first' }], selectedKey: 'workstream:first',
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
        openResource: async (_kind, id) => load(id),
        onDocumentChanges: () => () => {},
        onResourceDragResult: () => () => {},
        prepareResourceDrag: async () => ({ filename: 'context.md', filePath: '/tmp/context.md', fileUrl: 'file:///tmp/context.md' }),
        startResourceDrag: prepared => state.nativeDrags.push(prepared),
        getBackendHealth: async () => ({ state: 'healthy', endpoint: environment.mcpUrl,
          result: 'OK', observedAt: Date.now(), source: 'sandbox' }),
        getActivePanel: async () => buildWorkstreamPanels({ available: true, workstreams: state.workstreams, topics: state.topics }).active,
        getChatHistory: async input => { state.scope = input; return { journals: [] }; },
        getAgentMessages: async () => [], listContainerApps: async () => [],
        getInstanceFeatures: async () => ({ hostTasks: false, search: false }),
        getInstanceAccess: async () => ({ requests: [], clients: [] }),
        startDocumentChanges: async () => {},
        saveWorkstream: async (id, patch) => {
          state.saves.push({ id, patch });
          if (patch.title === 'Inbox' && id !== 'inbox') throw new Error('Inbox is reserved for the Inbox workstream.');
          if (state.delayNextSave) {
            state.delayNextSave = false;
            await new Promise(resolve => state.finishSave = resolve);
          }
          if (state.failNextSave) {
            state.failNextSave = false;
            throw new Error('Test save failed');
          }
          const ws = state.workstreams.find(ws => ws.id === id);
          Object.assign(ws, patch); ws.resourceVersion++;
          return load(id);
        },
        reparentTopic: async (id, parent) => {
          state.reparents.push({ id, parent });
          state.topics.find(topic => topic.id === id).parents = parent ? [parent] : [];
        },
        invokeAction: async (target, command, args) => {
          if (command !== 'workingMemory.topic.transfer') throw new Error('Unexpected action: ' + command);
          const request = { target, ...args[0] };
          state.transfers.push(request);
          const topic = state.topics.find(topic => topic.id === request.topicId);
          topic.workstreams = [...new Set([...topic.workstreams.filter(id => !request.move || id !== request.sourceWorkstream), target])];
          return load(target);
        },
      };
      mount(App, { target: document.body });
    `;
    const server = await createServer({
      configFile: false, root: fileURLToPath(new URL('..', import.meta.url)), cacheDir: join(directory, 'vite-cache'),
      optimizeDeps: { include: [
        'svelte', '@codemirror/commands', '@codemirror/lang-markdown', '@codemirror/language',
        '@lezer/highlight', '@lezer/markdown', '@codemirror/state', '@codemirror/view',
        '@codemirror/lang-javascript', '@codemirror/lang-json', 'chrono-node', 'markdown-it', 'turndown', 'zod',
      ] },
      plugins: [svelte(), {
        name: 'preferences-browser-fixture',
        resolveId: id => id === '/preferences-fixture.js' ? '\0preferences-fixture' : undefined,
        load: id => id === '\0preferences-fixture' ? fixture : undefined,
        configureServer(server) {
          server.middlewares.use((req, res, next) => {
            if (req.url !== '/preferences-test.html') { next(); return; }
            res.setHeader('content-type', 'text/html');
            res.end('<!doctype html><html><body><script type="module" src="/preferences-fixture.js"></script></body></html>');
          });
        },
      }],
      server: { host: '127.0.0.1', port: 0 }, appType: 'custom',
    });
    try {
      await server.listen();
      const address = server.httpServer?.address();
      if (!address || typeof address === 'string') throw new Error('Preferences fixture did not bind a TCP port.');
      const script = join(directory, 'preferences-test.cjs');
      await writeFile(script, `
        const { app, BrowserWindow } = require('electron');
        const assert = require('node:assert/strict');
        app.setPath('userData', ${JSON.stringify(join(directory, 'profile'))});
        app.whenReady().then(async () => {
          const window = new BrowserWindow({ show: false, width: 1400, height: 900 });
          window.webContents.on('console-message', event => console.error(event.message));
          const evaluate = code => window.webContents.executeJavaScript(code).catch(error => {
            throw new Error('Renderer execution failed: ' + code + '\\n' + error.message);
          });
          const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
          async function wait(code) {
            const until = Date.now() + 10_000;
            while (Date.now() < until) { if (await evaluate(code)) return; await delay(20); }
            throw new Error('Timed out: ' + code + '\\n' + await evaluate('document.body.innerText'));
          }
          async function preference(label) {
            await evaluate(\`[...document.querySelectorAll('.workstream-preferences label')].find(label => label.textContent.includes(\${JSON.stringify(label)})).querySelector('input').click()\`);
          }
          async function subtab(label) {
            await evaluate(\`[...document.querySelectorAll('[aria-label="Workstreams"] [role=tab]')].find(tab => tab.textContent === \${JSON.stringify(label)}).click()\`);
          }
          async function dragTopic(id, ctrlKey = false) {
            return evaluate(\`(() => {
              const from = [...document.querySelectorAll('.tree-link')].find(row => row.textContent.includes(\${JSON.stringify(id)}));
              const target = document.querySelector('.active-rail [data-workstream=target] .active-card-header');
              const dataTransfer = new DataTransfer();
              from.dispatchEvent(new DragEvent('dragstart', { bubbles: true, cancelable: true, dataTransfer }));
              const event = new DragEvent('dragover', { bubbles: true, cancelable: true, dataTransfer, ctrlKey: \${ctrlKey} });
              target.dispatchEvent(event);
              target.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer, ctrlKey: \${ctrlKey} }));
              from.dispatchEvent(new DragEvent('dragend', { bubbles: true, dataTransfer }));
              return { accepted: event.defaultPrevented, markdown: dataTransfer.getData('text/markdown') };
            })()\`);
          }
          await window.loadURL('http://127.0.0.1:${address.port}/preferences-test.html');
          await wait('document.querySelector(".title-input")?.value === "First"');
          for (const title of ['I', 'In', 'Inb', 'Inbo', 'Inbox']) {
            await evaluate(\`{
              const input = document.querySelector('.title-input');
              input.focus();
              input.value = \${JSON.stringify(title)};
              input.dispatchEvent(new Event('input', { bubbles: true }));
            }\`);
            await wait(\`document.querySelector('.title-input')?.value === \${JSON.stringify(title)} && document.activeElement === document.querySelector('.title-input')\`);
          }
          await wait('[...document.querySelectorAll("[role=alert]")].some(node => node.textContent.includes("Inbox is reserved"))');
          await evaluate(\`{
            const input = document.querySelector('.title-input');
            input.value += ' cleanup';
            input.dispatchEvent(new Event('input', { bubbles: true }));
          }\`);
          await wait('window.__preferences.workstreams[0].title === "Inbox cleanup" && document.querySelector(".title-input")?.value === "Inbox cleanup"');
          await evaluate(\`{
            const input = document.querySelector('.title-input');
            input.value = 'First';
            input.dispatchEvent(new Event('input', { bubbles: true }));
          }\`);
          await wait('window.__preferences.workstreams[0].title === "First" && ![...document.querySelectorAll("[role=alert]")].some(node => node.textContent.includes("Inbox is reserved"))');
          await preference('Pin workstream');
          await wait('window.__preferences.workstreams[0].pinned === true');
          await evaluate('document.querySelector(".topic-backlog-button").click()');
          await wait('document.querySelector("h1.title")?.textContent === "Inbox"');
          assert.deepEqual(await evaluate('[...document.querySelectorAll("[aria-label=Workstreams] [role=tab]")].map(tab => tab.textContent)'), ['Inbox', 'First', 'Backlog']);
          assert.equal(await evaluate('document.querySelector(".title-input")'), null);
          assert.equal(await evaluate('document.querySelector("[aria-label=Status]")'), null);
          assert.equal(await evaluate('document.querySelector(".workstream-preferences input").disabled'), true);
          await preference('Hide closed topics');
          await wait('window.__preferences.workstreams[1].includeClosedTopics === false && !document.querySelector(".tree-link.closed")');
          await wait('[...document.querySelectorAll(".tree-label")].some(row => row.textContent === "Open child")');
          await wait('document.querySelector(".composer-context")?.textContent.includes("Inbox")');
          assert.equal(await evaluate('window.__preferences.saves.at(-1).id'), 'inbox');
          await subtab('Backlog');
          await wait('document.querySelector(".backlog-workstreams")');
          assert.equal(await evaluate('document.querySelector("[data-workstream=inbox]")'), null);
          assert.equal(await evaluate('document.querySelector("[data-workstream=first]")'), null);
          await subtab('First');
          await wait('document.querySelector(".title-input")?.value === "First"');
          await preference('Pin workstream');
          await wait('window.__preferences.workstreams[0].pinned === false');
          await wait('document.querySelector("h1.title")?.textContent === "Inbox"');
          await wait('document.querySelector(".active-rail [data-workstream=first] .active-row.closed")');
          assert.equal(await evaluate('document.querySelector(".tree-link.closed")'), null);
          const moved = await dragTopic('Open child');
          assert.equal(moved.accepted, true);
          assert.equal(moved.markdown, '[Open child](http://127.0.0.1:7718/open/topic/child)');
          await wait('window.__preferences.transfers.length === 1 && ![...document.querySelectorAll(".tree-label")].some(row => row.textContent === "Open child")');
          assert.deepEqual(await evaluate('window.__preferences.transfers[0]'), { target: 'target', topicId: 'child', sourceWorkstream: 'inbox', move: true });
          await dragTopic('Copy me', true);
          await wait('window.__preferences.transfers.length === 2');
          assert.equal(await evaluate('window.__preferences.transfers[1].move'), false);
          assert.equal(await evaluate('window.__preferences.nativeDrags.length > 0'), true);
          assert.equal(await evaluate('window.__preferences.topics.find(topic => topic.id === "copy").workstreams.includes("inbox")'), true);
          assert.equal(await evaluate(\`(() => {
            const from = [...document.querySelectorAll('.active-rail [data-workstream=first] .active-row .active-open')].find(row => row.textContent.includes('Copy me'));
            const to = document.querySelector('.tree[aria-label="Topics tree"]');
            const dataTransfer = new DataTransfer();
            from.dispatchEvent(new DragEvent('dragstart', { bubbles: true, cancelable: true, dataTransfer }));
            const event = new DragEvent('dragover', { bubbles: true, cancelable: true, dataTransfer });
            to.dispatchEvent(event);
            to.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer }));
            from.dispatchEvent(new DragEvent('dragend', { bubbles: true, dataTransfer }));
            return event.defaultPrevented;
          })()\`), true);
          await wait('window.__preferences.transfers.length === 3');
          assert.deepEqual(await evaluate('window.__preferences.transfers[2]'), { target: 'inbox', topicId: 'copy', sourceWorkstream: 'first', move: true });
          async function dropRailTopicOnTopic(sourceLabel, parentLabel) {
            return evaluate(\`(() => {
              const from = [...document.querySelectorAll('.active-rail [data-workstream=target] .active-open')].find(row => row.textContent.includes(\${JSON.stringify(sourceLabel)}));
              const to = [...document.querySelectorAll('.tree-link')].find(row => row.textContent.includes(\${JSON.stringify(parentLabel)})).closest('.row-wrap');
              const dataTransfer = new DataTransfer();
              from.dispatchEvent(new DragEvent('dragstart', { bubbles: true, cancelable: true, dataTransfer }));
              const event = new DragEvent('dragover', { bubbles: true, cancelable: true, dataTransfer });
              to.dispatchEvent(event);
              to.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer }));
              from.dispatchEvent(new DragEvent('dragend', { bubbles: true, dataTransfer }));
              return event.defaultPrevented;
            })()\`);
          }
          assert.equal(await dropRailTopicOnTopic('Reparent me', 'Copy me'), true);
          await wait('window.__preferences.reparents.length === 1');
          assert.deepEqual(await evaluate('window.__preferences.reparents[0]'), { id: 'reparent', parent: 'copy' });
          assert.deepEqual(await evaluate('window.__preferences.topics.find(topic => topic.id === "reparent").workstreams'), ['target']);
          assert.equal(await evaluate('window.__preferences.transfers.length'), 3);
          assert.equal(await dropRailTopicOnTopic('Copy me', 'Copy me'), false);
          assert.equal(await evaluate('window.__preferences.reparents.length'), 1);
          assert.equal(await evaluate('window.__preferences.transfers.length'), 3);
          await evaluate('[...document.querySelectorAll(".document-tab-select")].find(tab => tab.textContent.trim() === "First").click()');
          await wait('document.querySelector(".title-input")?.value === "First"');
          await preference('Hide closed topics');
          await wait('window.__preferences.workstreams[0].includeClosedTopics === false && !document.querySelector(".active-rail [data-workstream=first] .active-row.closed")');
          await wait('!document.querySelector(".tree-link.closed") && [...document.querySelectorAll(".tree-label")].some(row => row.textContent === "Open child")');
          assert.equal(await evaluate('window.__preferences.topics.find(topic => topic.id === "closed").status'), 'closed');
          await preference('Pin workstream');
          await wait('window.__preferences.workstreams[0].pinned === true');
          await evaluate('document.querySelector(".topic-backlog-button").click()');
          await subtab('First');
          await wait('document.querySelector(".title-input")?.value === "First"');
          await evaluate(\`{
            window.__preferences.delayNextSave = true;
            const title = document.querySelector('.title-input');
            title.value = 'First edited';
            title.dispatchEvent(new Event('input', { bubbles: true }));
          }\`);
          await wait('typeof window.__preferences.finishSave === "function"');
          await subtab('Inbox');
          await wait('document.querySelector("h1.title")?.textContent === "Inbox"');
          await subtab('First');
          await evaluate('window.__preferences.finishSave()');
          await wait('document.querySelector(".title-input")?.value === "First edited" && document.querySelector(".composer-context")?.textContent.includes("First edited")');
          await evaluate(\`{
            window.__preferences.finishSave = null;
            window.__preferences.delayNextSave = true;
            window.__preferences.failNextSave = true;
            const title = document.querySelector('.title-input');
            title.value = 'First draft';
            title.dispatchEvent(new Event('input', { bubbles: true }));
          }\`);
          await wait('typeof window.__preferences.finishSave === "function"');
          await subtab('Inbox');
          await wait('document.querySelector("h1.title")?.textContent === "Inbox"');
          await subtab('First edited');
          await evaluate('window.__preferences.finishSave()');
          await wait('document.querySelector(".title-input")?.value === "First draft" && [...document.querySelectorAll("[role=alert]")].some(node => node.textContent.includes("Test save failed"))');
          await evaluate(\`{
            const title = document.querySelector('.title-input');
            title.value = 'First retried';
            title.dispatchEvent(new Event('input', { bubbles: true }));
          }\`);
          await wait('window.__preferences.workstreams[0].title === "First retried" && ![...document.querySelectorAll("[role=alert]")].some(node => node.textContent.includes("Test save failed"))');
          console.log('preferences-browser: pinning, Inbox, scoped saves, visibility and native move/copy passed');
          window.destroy(); app.exit(0);
        }).catch(error => { console.error(error); app.exit(1); });
      `);
      const { stdout, stderr } = await promisify(execFile)(executable, [script], {
        timeout: 60_000, env: { ...process.env, ELECTRON_RUN_AS_NODE: '' },
      });
      expect(stdout, stderr).toContain('preferences-browser: pinning, Inbox, scoped saves, visibility and native move/copy passed');
    } finally {
      await server.close();
      await rm(directory, { recursive: true, force: true });
    }
  }, 90_000,
);
