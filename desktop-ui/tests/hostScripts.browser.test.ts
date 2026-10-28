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
  'edits versioned scripts, prefills JSON, tests directly, publishes explicitly and refreshes without losing edits',
  async () => {
    const executable: unknown = createRequire(import.meta.url)('electron');
    if (typeof executable !== 'string') throw new Error('Electron executable is unavailable.');
    const directory = await mkdtemp(join(tmpdir(), 'working-memory-host-script-browser-'));
    const fixture = `
      import { mount, unmount } from 'svelte';
      import { EditorView } from '@codemirror/view';
      import HostScripts from '/src/renderer/HostScripts.svelte';
      import '/src/renderer/style.css';
      const definition = {
        name: 'Greeting', description: 'Test script', hostId: '00000000-0000-4000-8000-000000000001',
        source: 'module.exports = async function (parameters) {\\n  return { greeting: parameters.name };\\n};\\n',
        parameters: { name: { type: 'string', required: true, maxLength: 80 } }, timeoutMs: 10000,
      };
      const task = {
        ...definition, id: '00000000-0000-4000-8000-000000000002', source: undefined,
        definitionHash: '1'.repeat(64), createdAt: 1000, revokedAt: null, publishedVersion: 1, latestVersion: 1,
      };
      const state = window.__hostTest = {
        task, versions: [{ version: 1, definition, definitionHash: task.definitionHash, createdAt: 1000 }],
        reads: 0, details: 0, activeReads: 0, maxReads: 0, saves: 0, activeSaves: 0, maxSaves: 0,
        tests: [], published: [], runnerCalls: 0, jobs: [], hidden: false,
        pauseRead: false, releaseRead: null, pauseSave: false, releaseSave: null, failSave: false, failPoll: false,
        testError: false, draft: null, credentialReady: true,
      };
      Object.defineProperty(document, 'hidden', { configurable: true, get: () => state.hidden });
      const copy = value => structuredClone(value);
      const ownerTask = () => ({ ...task, draftName: state.versions[0].definition.name,
        draftDescription: state.versions[0].definition.description });
      window.workingMemory = {
        async getHostScripts() {
          state.reads++; state.maxReads = Math.max(state.maxReads, ++state.activeReads);
          const value = { environment: 'http://127.0.0.1:7717', hostId: definition.hostId, credentialReady: state.credentialReady,
            authentication: { passwordConfigured: true, passwordHint: 'Owner hint', setupAvailable: false },
            features: { hostTasks: true }, snapshot: state.credentialReady
              ? { tasks: [copy(ownerTask())], grants: [], apps: [], jobs: copy(state.jobs) } : null };
          try {
            if (state.pauseRead) { state.pauseRead = false; await new Promise(resolve => state.releaseRead = resolve); }
            if (state.failPoll) throw new Error('Task refresh failed');
            return value;
          } finally { state.activeReads--; }
        },
        async getHostScript() { state.details++; return copy({ task: ownerTask(), versions: state.versions }); },
        async saveHostScriptVersion(id, definition) {
          state.saves++; state.maxSaves = Math.max(state.maxSaves, ++state.activeSaves);
          try {
            if (state.pauseSave) { state.pauseSave = false; await new Promise(resolve => state.releaseSave = resolve); }
            if (state.failSave) { state.failSave = false; throw new Error('Draft save failed'); }
            const latest = state.versions[0];
            if (JSON.stringify(latest.definition) === JSON.stringify(definition)) return copy(latest);
            const version = { version: latest.version + 1, definition: copy(definition),
              definitionHash: String(latest.version + 1).padStart(64, '0'), createdAt: Date.now() };
            state.versions.unshift(version); task.latestVersion = version.version;
            return copy(version);
          } finally { state.activeSaves--; }
        },
        async publishHostScriptVersion(id, version, hash) {
          if (hash !== task.definitionHash) throw new Error('Published version changed');
          const item = state.versions.find(item => item.version === version);
          Object.assign(task, item.definition, { source: undefined, definitionHash: item.definitionHash, publishedVersion: version });
          state.published.push(version); return copy(task);
        },
        async testHostScript(id, version, parameters) {
          state.tests.push({ id, version, parameters });
          const job = { id: crypto.randomUUID(), taskId: id, version, appId: null, state: state.testError ? 'failed' : 'succeeded',
            resultJson: state.testError ? null : JSON.stringify(parameters), error: state.testError ? 'Script failed' : null,
            createdAt: Date.now(), expiresAt: Date.now() + 300000 };
          state.jobs.unshift(job); return copy(job);
        },
        async getHostScriptJob(id) { return copy(state.jobs.find(job => job.id === id)); },
        async processNextHostScript() { state.runnerCalls++; return null; },
      };
      const target = document.createElement('main'); target.style.padding = '20px'; document.body.append(target);
      state.mount = (props = {}) => {
        const component = mount(HostScripts, { target, props: { taskId: task.id, onDraftChanged: value => state.draft = value,
          onTaskRead: value => state.lastTask = value, ...props } });
        state.dispose = () => unmount(component);
        state.prepareChat = () => component.prepareChat();
        state.refreshFromChat = () => component.refreshFromChat();
      };
      const editor = label => EditorView.findFromDOM(document.querySelector(label === 'Task description'
        ? '.hybrid-editor .cm-content' : '[data-editor="' + label + '"] .cm-content'));
      state.edit = (label, value) => {
        const view = editor(label);
        view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: value } });
      };
      state.text = label => editor(label).state.doc.toString();
      state.mount();
    `;
    const server = await createServer({
      configFile: false, root: new URL('..', import.meta.url).pathname,
      cacheDir: join(directory, 'vite-cache'),
      optimizeDeps: { include: ['svelte', '@codemirror/view', '@codemirror/state', '@codemirror/commands',
        '@codemirror/language', '@codemirror/lang-javascript', '@codemirror/lang-json',
        '@codemirror/lang-markdown', '@lezer/highlight', 'markdown-it', 'zod'] },
      plugins: [svelte(), {
        name: 'host-script-browser-fixture',
        resolveId: id => id === '/host-fixture.js' ? '\0host-fixture' : undefined,
        load: id => id === '\0host-fixture' ? fixture : undefined,
        configureServer(server) {
          server.middlewares.use((req, res, next) => {
            if (req.url !== '/host-test.html') { next(); return; }
            res.setHeader('content-type', 'text/html');
            res.end('<!doctype html><html><body><script type="module" src="/host-fixture.js"></script></body></html>');
          });
        },
      }],
      server: { host: '127.0.0.1', port: 0 }, appType: 'custom',
    });
    try {
      await server.listen();
      const address = server.httpServer?.address();
      if (!address || typeof address === 'string') throw new Error('Task fixture did not bind a TCP port.');
      const script = join(directory, 'host-test.cjs');
      await writeFile(script, `
        const { app, BrowserWindow } = require('electron');
        const assert = require('node:assert/strict');
        app.setPath('userData', ${JSON.stringify(join(directory, 'profile'))});
        app.whenReady().then(async () => {
          const window = new BrowserWindow({ show: false, width: 1100, height: 1200 });
          const evaluate = async code => {
            try { return await window.webContents.executeJavaScript(code); }
            catch (error) { throw new Error(code + '\\n' + error.message); }
          };
          const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
          async function wait(code) {
            const until = Date.now() + 8000;
            while (Date.now() < until) { if (await evaluate(code)) return; await delay(20); }
            throw new Error('Timed out: ' + code + '\\n' + await evaluate('document.body.innerText'));
          }
          const click = async label => {
            if (label === 'Test') await click('Testing');
            await evaluate("Array.from(document.querySelectorAll('button')).find(button => button.textContent === " + JSON.stringify(label) + ").click()");
          };
          const editorTab = label => click(label === 'Task description' ? 'Settings'
            : label === 'Test input' ? 'Testing' : 'Code and parameters');
          const edit = async (label, value) => {
            await editorTab(label);
            await evaluate("window.__hostTest.edit(" + JSON.stringify(label) + ", " + JSON.stringify(value) + ")");
          };
          const text = async label => {
            await editorTab(label);
            return evaluate("window.__hostTest.text(" + JSON.stringify(label) + ")");
          };
          await window.loadURL('http://127.0.0.1:${address.port}/host-test.html');
          await wait("document.querySelector('[data-editor=\\"Script code\\"] .cm-content')");
          assert.match(await text('Script code'), /module.exports/);
          assert.ok(await evaluate("document.querySelectorAll('[data-editor=\\"Script code\\"] .cm-line span').length > 0"));
          assert.deepEqual(JSON.parse(await text('Test input')), { name: 'World' });
          assert.match(await text('Parameter schema'), /\\n/);
          assert.equal(await evaluate("Array.from(document.querySelectorAll('button')).some(button => /Refresh|Review and queue/.test(button.textContent))"), false);
          assert.equal(await evaluate("document.querySelectorAll('[role=tablist] [role=tab]').length"), 7);
          assert.equal(await evaluate("document.querySelectorAll('details').length"), 0);
          await evaluate("document.querySelector('[role=tab][aria-selected=true]').dispatchEvent(new KeyboardEvent('keydown', { key: 'Home', bubbles: true }))");
          assert.equal(await evaluate("document.activeElement.textContent"), 'Settings');
          await evaluate("document.activeElement.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }))");
          assert.equal(await evaluate("document.activeElement.textContent"), 'Code and parameters');
          await click('Test');
          await wait("window.__hostTest.tests.length === 1 && document.body.innerText.includes('succeeded')");
          assert.equal(await evaluate("window.__hostTest.tests[0].version"), 1);
          assert.equal(await evaluate("window.__hostTest.runnerCalls"), 0);

          await evaluate("window.__hostTest.pauseRead = true");
          await wait("typeof window.__hostTest.releaseRead === 'function'");
          const changed = 'module.exports = parameters => ({ edited: parameters.name });';
          await edit('Script code', changed);
          await edit('Test input', '{"name":"Ada"}');
          await click('Test');
          await wait("window.__hostTest.tests.length === 2 && document.body.innerText.includes('succeeded')");
          assert.equal(await evaluate("window.__hostTest.tests[1].version"), 2);
          assert.equal(await evaluate("window.__hostTest.task.publishedVersion"), 1);
          assert.deepEqual(await evaluate("window.__hostTest.tests[1].parameters"), { name: 'Ada' });
          await evaluate("window.__hostTest.releaseRead()");
          await delay(100);
          assert.equal(await text('Script code'), changed);
          await click('Publish');
          await wait("window.__hostTest.task.publishedVersion === 2 && document.querySelector('[aria-label=\\"Task version\\"]').value === '2'");
          assert.deepEqual(await evaluate("window.__hostTest.published"), [2]);
          await evaluate("{ const select = document.querySelector('[aria-label=\\"Task version\\"]'); select.value = '1'; select.dispatchEvent(new Event('change', { bubbles: true })); }");
          await wait("document.querySelector('[aria-label=\\"Task version\\"]').value === '1'");
          assert.match(await text('Script code'), /async function/);
          assert.deepEqual(JSON.parse(await text('Test input')), { name: 'Ada' });

          await evaluate("window.__hostTest.testError = true");
          await click('Test');
          await wait("document.querySelector('pre[role=alert]')?.textContent === 'Script failed'");
          await evaluate("window.__hostTest.testError = false; window.__hostTest.failSave = true");
          await edit('Script code', changed + '\\n// next draft');
          await wait("document.querySelector('[role=alert]')?.textContent === 'Draft save failed'");
          await delay(2200);
          assert.equal(await evaluate("document.querySelector('[role=alert]').textContent"), 'Draft save failed');
          assert.match(await text('Script code'), /next draft/);
          await edit('Script code', changed + '\\n// retry draft');
          await wait("!document.querySelector('p[role=alert]') && window.__hostTest.draft === null");

          await evaluate("window.__hostTest.pauseSave = true");
          await edit('Script code', changed + '\\n// slow save');
          await wait("typeof window.__hostTest.releaseSave === 'function'");
          await edit('Script code', changed + '\\n// newer edit');
          await delay(1200);
          await evaluate("window.__hostTest.releaseSave()");
          await wait("window.__hostTest.versions[0].definition.source.includes('newer edit') && window.__hostTest.draft === null");
          assert.match(await text('Script code'), /newer edit/);
          assert.equal(await evaluate("window.__hostTest.maxSaves"), 1);

          await edit('Parameter schema', '{');
          await wait("document.querySelector('p[role=alert]')");
          const tests = await evaluate("window.__hostTest.tests.length");
          await click('Test');
          await delay(100);
          assert.equal(await evaluate("window.__hostTest.tests.length"), tests);
          await edit('Parameter schema', '{"name":{"type":"string","required":true,"maxLength":80}}');
          await wait("!document.querySelector('p[role=alert]') && window.__hostTest.draft === null");
          await evaluate("window.__hostTest.hidden = true");
          const reads = await evaluate("window.__hostTest.reads");
          await delay(2200);
          assert.equal(await evaluate("window.__hostTest.reads"), reads);
          await evaluate("window.__hostTest.hidden = false; document.dispatchEvent(new Event('visibilitychange'))");
          await wait("window.__hostTest.reads > " + reads);
          await evaluate("window.__hostTest.failPoll = true");
          await wait("document.querySelector('p[role=alert]')?.textContent === 'Task refresh failed'");
          await evaluate("window.__hostTest.failPoll = false");
          await wait("!document.querySelector('p[role=alert]')");
          await edit('Script code', changed + '\\n// prepared for chat');
          const prepared = await evaluate("window.__hostTest.prepareChat()");
          assert.equal(prepared.version, await evaluate("window.__hostTest.task.latestVersion"));
          assert.equal(await evaluate("window.__hostTest.draft"), null);
          await wait("window.__hostTest.activeReads === 0");
          await evaluate("window.__hostTest.releaseRead = null; window.__hostTest.pauseRead = true; window.dispatchEvent(new Event('focus'))");
          await wait("typeof window.__hostTest.releaseRead === 'function'");
          await evaluate("window.workingMemory.saveHostScriptVersion(window.__hostTest.task.id, { ...window.__hostTest.versions[0].definition, source: 'module.exports = () => ({ changedByChat: true });' })");
          await evaluate("window.workingMemory.testHostScript(window.__hostTest.task.id, window.__hostTest.task.latestVersion, { chatTestResult: 42 })");
          await evaluate("window.__hostTest.chatRefresh = window.__hostTest.refreshFromChat(); void 0");
          await delay(50);
          await evaluate("window.__hostTest.releaseRead()");
          await evaluate("window.__hostTest.chatRefresh");
          assert.match(await text('Script code'), /changedByChat/);
          await click('Testing');
          assert.ok(await evaluate("document.body.innerText.includes('chatTestResult')"));
          await click('Recent runs');
          await click('Inspect result');
          await wait("document.querySelector('[role=tab][aria-selected=true]').textContent === 'Testing'");
          assert.ok(await evaluate("document.body.innerText.includes('chatTestResult')"));
          await evaluate("{ const select = document.querySelector('[aria-label=\\"Task version\\"]'); select.value = '1'; select.dispatchEvent(new Event('change', { bubbles: true })); }");
          await wait("document.querySelector('[aria-label=\\"Task version\\"]').value === '1'");
          assert.equal((await evaluate("window.__hostTest.prepareChat()")).version, 1);
          await evaluate("window.__hostTest.refreshFromChat()");
          assert.equal(await evaluate("document.querySelector('[aria-label=\\"Task version\\"]').value"), '1');
          assert.match(await text('Script code'), /async function/);
          await evaluate("{ const input = document.querySelector('[aria-label=\\"Task title\\"]'); input.value = 'Renamed task'; input.dispatchEvent(new Event('input', { bubbles: true })); }");
          assert.equal(await evaluate("window.__hostTest.draft.name"), 'Renamed task');
          const description = '# Task notes\\n\\n**Markdown description**\\n\\n- One\\n- Two';
          await edit('Task description', description);
          await wait("document.querySelector('.hybrid-editor .cm-live-heading-1')");
          assert.equal(await text('Task description'), description);
          assert.equal(await evaluate("document.querySelector('[role=tabpanel] textarea')"), null);
          await evaluate("{ const input = document.querySelector('[role=tabpanel] input[type=number]'); input.value = '3000'; input.dispatchEvent(new Event('input', { bubbles: true })); }");
          await click('Code and parameters');
          await wait("window.__hostTest.versions[0].definition.name === 'Renamed task' && window.__hostTest.draft === null");
          assert.equal(await evaluate("window.__hostTest.versions[0].definition.description"), description);
          assert.equal(await evaluate("window.__hostTest.versions[0].definition.timeoutMs"), 3000);
          assert.equal(await evaluate("window.__hostTest.lastTask.draftName"), 'Renamed task');
          await click('Settings');
          assert.equal(await evaluate("document.querySelector('[aria-label=\\"Task title\\"]').value"), 'Renamed task');
          assert.equal(await text('Task description'), description);
          assert.equal(await evaluate("window.__hostTest.task.publishedVersion"), 2);
          await click('App access');
          assert.ok(await evaluate("document.body.innerText.includes('Start runner')"));
          await click('Add a caller');
          assert.ok(await evaluate("document.body.innerText.includes('Caller label')"));
          await click('Integration details');
          assert.ok(await evaluate("document.body.innerText.includes('/host-tasks/v1/scripts/mcp')"));
          assert.equal(await evaluate("window.__hostTest.maxReads"), 1);
          assert.equal(await evaluate("window.__hostTest.runnerCalls"), 0);
          await evaluate("window.__hostTest.dispose()");
          const finalReads = await evaluate("window.__hostTest.reads");
          await delay(2200);
          assert.equal(await evaluate("window.__hostTest.reads"), finalReads);
          await evaluate("window.__hostTest.mount({ chatBusy: true })");
          await wait("document.querySelector('[data-editor=\\"Script code\\"] .cm-content')");
          assert.equal(await evaluate("document.querySelector('[data-editor=\\"Script code\\"] .cm-content').contentEditable"), 'false');
          assert.equal(await evaluate("document.querySelector('[aria-label=\\"Task title\\"]').disabled"), true);
          await click('Settings');
          assert.equal(await evaluate("document.querySelector('.hybrid-editor .cm-content').contentEditable"), 'false');
          const saves = await evaluate("window.__hostTest.saves");
          await evaluate("window.workingMemory.saveHostScriptVersion(window.__hostTest.task.id, { ...window.__hostTest.versions[0].definition, description: '**Changed by chat**' })");
          await evaluate("window.__hostTest.refreshFromChat()");
          assert.equal(await text('Task description'), '**Changed by chat**');
          await delay(1100);
          assert.equal(await evaluate("window.__hostTest.saves"), saves + 1);
          assert.equal(await evaluate("window.__hostTest.draft"), null);
          await click('Testing');
          assert.equal(await evaluate("Array.from(document.querySelectorAll('button')).find(button => button.textContent === 'Test').disabled"), true);
          await evaluate("window.__hostTest.dispose()");
          await evaluate("window.__hostTest.credentialReady = false; window.__hostTest.mount()");
          await wait("document.querySelector('input[type=password]')");
          assert.ok(await evaluate("document.body.innerText.includes('Connect to your Working Memory instance')"));
          assert.ok(await evaluate("document.body.innerText.includes('does not approve a script')"));
          assert.ok(await evaluate("document.querySelector('#instance-password-hint').textContent.includes('Owner hint')"));
          assert.equal(await evaluate("document.querySelector('[aria-label=\\"Task title\\"]')"), null);
          assert.equal(await evaluate("Array.from(document.querySelectorAll('button')).some(button => button.textContent === 'Test')"), false);
          await evaluate("window.__hostTest.dispose()");
          console.log('host-editor-browser: code, JSON, drafts, test, publish, stale guards, errors and cleanup passed');
          window.destroy(); app.exit(0);
        }).catch(error => { console.error(error); app.exit(1); });
      `);
      const { stdout } = await promisify(execFile)(executable, [script], {
        timeout: 60_000, env: { ...process.env, ELECTRON_RUN_AS_NODE: '' },
      });
      expect(stdout).toContain('host-editor-browser: code, JSON, drafts, test, publish, stale guards, errors and cleanup passed');
    } finally {
      await server.close();
      await rm(directory, { recursive: true, force: true });
    }
  }, 65_000,
);
