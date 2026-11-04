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
  'autosaves session limits without a button, preserves queued edits, validates input, and protects stale responses',
  async () => {
    const executable: unknown = createRequire(import.meta.url)('electron');
    if (typeof executable !== 'string') throw new Error('Electron executable is unavailable.');
    const directory = await mkdtemp(join(tmpdir(), 'working-memory-sessions-browser-'));
    const fixture = `
      import { mount, unmount } from 'svelte';
      import Settings from '/src/renderer/documents/SettingsView.svelte';
      import '/src/renderer/style.css';
      const event = sequence => ({ sequence, type: 'rate_limited', clientId: 'client', clientLabel: 'Feedback',
        application: 'working-memory-feedback', sessionId: null, firstAt: Date.now(), lastAt: Date.now(),
        count: 15, detail: 'New-session attempts exceeded the per-minute limit.' });
      const state = window.__sessionsTest = {
        snapshot: {
          startedAt: Date.now(),
          policy: { idleMinutes: 60, maxPerClient: 100, maxTotal: 500, handshakesPerMinute: 1000, retentionDays: 10 },
          memory: { heapUsedBytes: 128 * 1048576, heapLimitBytes: 512 * 1048576,
            admissionThresholdBytes: 307.2 * 1048576, admissionBlocked: false },
          active: [{ id: 'diagnostic-id', clientId: 'client', clientLabel: 'Feedback', application: 'working-memory-feedback',
            state: 'active', createdAt: Date.now(), lastActivityAt: Date.now(), requests: 3, activeRequests: 1 }],
          events: [event(200)], nextCursor: 200,
        },
        calls: [], saves: [], failRead: false, failSave: false, pause: false, release: null,
        pauseSave: false, releaseSave: null, inFlight: 0, maxInFlight: 0,
      };
      let policySave = Promise.resolve();
      window.workingMemory = {
        async getSessionDiagnostics(cursor) {
          const currentUrl = state.currentUrl;
          const read = async () => {
            if (currentUrl !== state.currentUrl) throw new Error('The selected instance changed.');
            state.calls.push(cursor ?? 'latest');
            if (state.failRead) { state.failRead = false; throw new Error('Session refresh failed'); }
            const result = structuredClone(state.snapshot);
            if (cursor) { result.events = [event(199)]; result.nextCursor = null; }
            if (state.pause) { state.pause = false; await new Promise(resolve => state.release = resolve); }
            return result;
          };
          return policySave.then(read, read);
        },
        async updateSessionPolicy(policy, mcpUrl) {
          if (mcpUrl !== state.currentUrl) throw new Error('The selected instance changed.');
          const save = async () => {
            if (mcpUrl !== state.currentUrl) throw new Error('The selected instance changed.');
            state.saves.push(structuredClone(policy));
            state.inFlight += 1;
            state.maxInFlight = Math.max(state.maxInFlight, state.inFlight);
            try {
              if (state.pauseSave) { state.pauseSave = false; await new Promise(resolve => state.releaseSave = resolve); }
              if (state.failSave) { state.failSave = false; throw new Error('Session policy save failed'); }
              state.snapshot.policy = structuredClone(policy);
              return structuredClone(state.snapshot);
            } finally { state.inFlight -= 1; }
          };
          const pending = policySave.then(save, save);
          policySave = pending;
          return pending;
        },
      };
      const target = document.createElement('main'); document.body.append(target);
      let component;
      state.mount = async url => {
        state.currentUrl = url;
        if (component) await unmount(component);
        component = mount(Settings, { target, props: {
          profiles: [], routing: {}, humanName: 'Test', credentialStorage: 'secure', settingsStatus: '',
          saving: false, testingProfileId: null, onHumanName() {}, onAddProfile() {}, onRemoveProfile() {},
          async onTestProfile() {}, async onSave() {}, selectedMcpUrl: url, async onMakeCurrent() {},
          async onInstancesChanged() {}, onFeaturesChanged() {}, tab: 'sessions',
        } });
      };
      await state.mount('http://127.0.0.1:7717/mcp');
    `;
    const server = await createServer({
      configFile: false, root: fileURLToPath(new URL('..', import.meta.url)),
      cacheDir: join(directory, 'vite-cache'),
      resolve: { dedupe: ['svelte', 'zod'] },
      optimizeDeps: { include: ['svelte', 'zod'] },
      plugins: [svelte(), {
        name: 'sessions-browser-fixture',
        resolveId: id => id === '/sessions-browser-fixture.js' ? '\0sessions-browser-fixture' : undefined,
        load: id => id === '\0sessions-browser-fixture' ? fixture : undefined,
        configureServer(server) {
          server.middlewares.use((req, res, next) => {
            if (req.url !== '/sessions-browser-test.html') { next(); return; }
            res.setHeader('content-type', 'text/html');
            res.end('<!doctype html><html><body><script type="module" src="/sessions-browser-fixture.js"></script></body></html>');
          });
        },
      }],
      server: { host: '127.0.0.1', port: 0, fs: { allow: [fileURLToPath(new URL('../..', import.meta.url))] } },
      appType: 'custom',
    });
    try {
      await server.listen();
      const address = server.httpServer?.address();
      if (!address || typeof address === 'string') throw new Error('Browser fixture did not bind a TCP port.');
      const script = join(directory, 'sessions-test.cjs');
      await writeFile(script, `
        const { app, BrowserWindow } = require('electron');
        const assert = require('node:assert/strict');
        app.setPath('userData', ${JSON.stringify(join(directory, 'profile'))});
        app.whenReady().then(async () => {
          const window = new BrowserWindow({ show: false, width: 1000, height: 900, webPreferences: { contextIsolation: true } });
          const errors = [];
          window.webContents.on('console-message', (_event, level, message) => { if (level >= 3) errors.push(message); });
          const evaluate = async code => {
            try { return await window.webContents.executeJavaScript(code); }
            catch (error) { throw new Error(code + '\\n' + error + '\\n' + errors.join('\\n')); }
          };
          async function wait(code) {
            const until = Date.now() + 7000;
            while (Date.now() < until) {
              if (await evaluate(code)) return;
              await new Promise(resolve => setTimeout(resolve, 20));
            }
            throw new Error('Timed out: ' + code + '\\n' + await evaluate('document.body.innerText') + '\\n' + errors.join('\\n'));
          }
          const button = text => "Array.from(document.querySelectorAll('button')).find(b => b.textContent.trim() === " + JSON.stringify(text) + ")";
          const setIdle = value => evaluate("(() => { const input = document.querySelector('input'); input.value = " + value + "; input.dispatchEvent(new Event('input', { bubbles: true })); })()");
          await window.loadURL('http://127.0.0.1:${address.port}/sessions-browser-test.html');
          await wait("document.querySelector('[aria-label=\\"Active MCP sessions\\"] tbody')?.textContent.includes('Feedback')");
          assert.equal(await evaluate("document.querySelector('[role=tab][aria-selected=true]').textContent"), 'Sessions');
          assert.equal(await evaluate("document.querySelectorAll('.session-limits input').length"), 5);
          assert.equal(await evaluate(button('Save limits') + ' === undefined'), true);
          assert.equal(await evaluate("document.querySelector('button[type=submit]') === null"), true);
          assert.equal(await evaluate("document.querySelector('[aria-label=\\"Session event log\\"] tbody').textContent.includes('15')"), true);
          await evaluate("window.__sessionsTest.pause = true; " + button('Refresh') + ".click()");
          await wait("typeof window.__sessionsTest.release === 'function'");
          for (const value of [71, 72, 75]) await setIdle(value);
          await wait("document.querySelector('[role=status]')?.textContent === 'Saved automatically.'");
          await evaluate("window.__sessionsTest.release()");
          await wait("document.querySelector('input').value === '75' && !" + button('Refresh') + ".disabled");
          assert.equal(await evaluate("window.__sessionsTest.saves[0].idleMinutes"), 75);
          assert.equal(await evaluate("window.__sessionsTest.saves.length"), 1);
          await setIdle(0);
          await wait("document.querySelector('[role=alert]')?.textContent.includes('whole numbers')");
          await evaluate(button('Refresh') + '.click()');
          await wait("!" + button('Refresh') + ".disabled");
          await new Promise(resolve => setTimeout(resolve, 600));
          assert.equal(await evaluate("document.querySelector('input').value"), '0');
          assert.equal(await evaluate("window.__sessionsTest.saves.length"), 1);
          await evaluate("window.__sessionsTest.failSave = true");
          await setIdle(80);
          await wait("document.querySelector('[role=alert]')?.textContent === 'Session policy save failed'");
          assert.equal(await evaluate("document.querySelector('input').value"), '80');
          await evaluate("document.querySelector('input').dispatchEvent(new FocusEvent('blur'))");
          await wait("document.querySelector('[role=status]')?.textContent === 'Saved automatically.'");
          await evaluate("window.__sessionsTest.pauseSave = true");
          await setIdle(85);
          await wait("typeof window.__sessionsTest.releaseSave === 'function'");
          assert.equal(await evaluate("document.querySelector('input').disabled"), false);
          await setIdle(86);
          await new Promise(resolve => setTimeout(resolve, 600));
          assert.equal(await evaluate("window.__sessionsTest.saves.at(-1).idleMinutes"), 85);
          await evaluate("window.__sessionsTest.releaseSave()");
          await wait("document.querySelector('[role=status]')?.textContent === 'Saved automatically.' && window.__sessionsTest.snapshot.policy.idleMinutes === 86");
          assert.equal(await evaluate("document.querySelector('input').value"), '86');
          assert.equal(await evaluate("window.__sessionsTest.maxInFlight"), 1);
          assert.deepEqual(await evaluate("window.__sessionsTest.saves.slice(-2).map(policy => policy.idleMinutes)"), [85, 86]);
          await evaluate(\`const inputs = document.querySelectorAll('.session-limits input');
            for (const [index, value] of [[1, 101], [2, 501], [3, 999], [4, 11]]) {
              inputs[index].value = value; inputs[index].dispatchEvent(new Event('input', { bubbles: true }));
            }\`);
          await wait("window.__sessionsTest.snapshot.policy.retentionDays === 11 && document.querySelector('[role=status]')?.textContent === 'Saved automatically.'");
          assert.deepEqual(await evaluate("window.__sessionsTest.snapshot.policy"),
            { idleMinutes: 86, maxPerClient: 101, maxTotal: 501, handshakesPerMinute: 999, retentionDays: 11 });
          await evaluate("window.__sessionsTest.pauseSave = true");
          await setIdle(87);
          await wait("window.__sessionsTest.saves.at(-1).idleMinutes === 87");
          await setIdle(88);
          await evaluate("document.querySelector('input').dispatchEvent(new FocusEvent('blur')); " + button('Models') + ".click()");
          await wait("!document.querySelector('.session-settings')");
          await evaluate("window.__sessionsTest.releaseSave()");
          await wait("window.__sessionsTest.snapshot.policy.idleMinutes === 88");
          assert.deepEqual(await evaluate("window.__sessionsTest.saves.slice(-2).map(policy => policy.idleMinutes)"), [87, 88]);
          await evaluate(button('Sessions') + ".click()");
          await wait("document.querySelector('input')?.value === '88'");
          await evaluate("window.__sessionsTest.pauseSave = true");
          await setIdle(91);
          await wait("window.__sessionsTest.saves.at(-1).idleMinutes === 91");
          await setIdle(92);
          await evaluate("window.__sessionsTest.mount('http://127.0.0.1:7717/mcp')");
          await new Promise(resolve => setTimeout(resolve, 100));
          assert.equal(await evaluate("document.querySelector('.session-limits input') === null"), true);
          await evaluate("window.__sessionsTest.releaseSave()");
          await wait("document.querySelector('input')?.value === '92'");
          await evaluate(\`(() => { const input = document.querySelectorAll('.session-limits input')[4];
            input.value = 12; input.dispatchEvent(new Event('input', { bubbles: true })); })()\`);
          await wait("window.__sessionsTest.snapshot.policy.retentionDays === 12 && document.querySelector('[role=status]')?.textContent === 'Saved automatically.'");
          assert.deepEqual(await evaluate("window.__sessionsTest.saves.slice(-3).map(policy => policy.idleMinutes)"), [91, 92, 92]);
          assert.equal(await evaluate("window.__sessionsTest.snapshot.policy.idleMinutes"), 92);
          assert.equal(await evaluate("window.__sessionsTest.maxInFlight"), 1);
          await evaluate(button('Load older events') + '.click()');
          await wait("document.querySelectorAll('[aria-label=\\"Session event log\\"] tbody tr').length === 2");
          assert.equal(await evaluate("window.__sessionsTest.calls.includes(200)"), true);
          assert.equal(await evaluate("document.body.innerText.includes('History is paused')"), true);
          await evaluate("window.__sessionsTest.failRead = true; " + button('Refresh') + ".click()");
          await wait("document.querySelector('[role=alert]')?.textContent === 'Session refresh failed'");
          await evaluate(button('Refresh') + '.click()');
          await wait("!document.querySelector('[role=alert]') && document.querySelectorAll('[aria-label=\\"Session event log\\"] tbody tr').length === 1");
          await evaluate("window.__sessionsTest.pause = true; " + button('Refresh') + ".click()");
          await wait("typeof window.__sessionsTest.release === 'function' && " + button('Refreshing...') + "?.disabled");
          const savesBeforeSwitch = await evaluate("window.__sessionsTest.saves.length");
          await setIdle(90);
          await evaluate(\`window.__sessionsTest.snapshot.policy.idleMinutes = 22;
            window.__sessionsTest.snapshot.active = [];
            window.__sessionsTest.snapshot.memory.admissionBlocked = true;
            window.__sessionsTest.mount('http://127.0.0.1:7719/mcp');\`);
          await wait("document.querySelector('input')?.value === '22' && document.body.innerText.includes('No active MCP sessions')");
          await evaluate("window.__sessionsTest.release()");
          await new Promise(resolve => setTimeout(resolve, 600));
          assert.equal(await evaluate("document.querySelector('input').value"), '22');
          assert.equal(await evaluate("window.__sessionsTest.saves.length"), savesBeforeSwitch);
          assert.equal(await evaluate("document.body.innerText.includes('New sessions are currently paused')"), true);
          for (const width of [620, 1000]) {
            window.setSize(width, 900);
            const layout = await evaluate("({ scroll: document.documentElement.scrollWidth, viewport: window.innerWidth })");
            assert.ok(layout.scroll <= layout.viewport, JSON.stringify(layout));
          }
          assert.deepEqual(errors, []);
          console.log('sessions-browser: tab, heap, edits, saves, pagination, errors and stale responses passed');
          window.destroy(); app.exit(0);
        }).catch(error => { console.error(error); app.exit(1); });
      `);
      const { stdout } = await promisify(execFile)(executable, [script], {
        timeout: 25000, env: { ...process.env, ELECTRON_RUN_AS_NODE: '' },
      });
      expect(stdout).toContain('sessions-browser: tab, heap, edits, saves, pagination, errors and stale responses passed');
    } finally { await server.close(); await rm(directory, { recursive: true, force: true }); }
  }, 30000,
);
