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
  'autosaves and rolls back permission edits, ignores stale polls, and follows a request into one active client row',
  async () => {
    const require = createRequire(import.meta.url);
    const executable: unknown = require('electron');
    if (typeof executable !== 'string') throw new Error('Electron executable is unavailable.');
    const directory = await mkdtemp(join(tmpdir(), 'working-memory-access-browser-'));
    const fixture = `
      import { mount } from 'svelte';
      import Access from '/src/renderer/documents/AccessView.svelte';
      import '/src/renderer/style.css';
      const crud = { create: false, read: true, update: false, delete: false };
      const state = window.__accessTest = {
        snapshot: {
          requests: [{ id: '11111111-1111-4111-8111-111111111111', label: 'Browser test', clientId: null,
            access: 'read', source: 'test', state: 'pending', createdAt: Date.now(), expiresAt: Date.now() + 600000,
            permissions: { content: { ...crud }, settings: { ...crud }, tools: { ...crud, read: false, run: false } } }],
          clients: [],
        }, fail: false, pausePoll: false, releasePoll: null, calls: [],
      };
      window.workingMemory = {
        async getInstanceAccess() {
          const result = structuredClone(state.snapshot);
          if (state.pausePoll) {
            state.pausePoll = false;
            await new Promise(resolve => state.releasePoll = resolve);
          }
          return result;
        },
        async reviewInstanceAccess(action) {
          state.calls.push(structuredClone(action));
          if (state.fail) { state.fail = false; throw new Error('Permission update failed'); }
          const collection = action.target === 'client' ? state.snapshot.clients : state.snapshot.requests;
          const row = collection.find(row => row.id === action.id);
          if (action.action === 'permissions') row.permissions = structuredClone(action.permissions);
          else if (action.action === 'approve' && row.purpose === 'permissions') {
            const client = state.snapshot.clients.find(client => client.id === row.clientId);
            for (const [category, permissions] of Object.entries(row.permissions)) {
              for (const [operation, allowed] of Object.entries(permissions)) {
                if (allowed) client.permissions[category][operation] = true;
              }
            }
            state.snapshot.requests = state.snapshot.requests.filter(request => request.id !== row.id);
          }
          else if (action.action === 'approve') row.state = 'approved';
          else if (action.action === 'deny') row.state = 'denied';
          return structuredClone(state.snapshot);
        },
      };
      const target = document.createElement('main');
      target.className = 'settings';
      document.body.append(target);
      mount(Access, { target });
    `;
    const server = await createServer({
      configFile: false, root: new URL('..', import.meta.url).pathname,
      plugins: [
        svelte(),
        {
          name: 'access-browser-fixture',
          resolveId: id => id === '/access-browser-fixture.js' ? '\0access-browser-fixture' : undefined,
          load: id => id === '\0access-browser-fixture' ? fixture : undefined,
          configureServer(server) {
            server.middlewares.use((req, res, next) => {
              if (req.url !== '/access-browser-test.html') { next(); return; }
              res.setHeader('content-type', 'text/html');
              res.end('<!doctype html><html><body><script type="module" src="/access-browser-fixture.js"></script></body></html>');
            });
          },
        },
      ],
      server: { host: '127.0.0.1', port: 0 }, appType: 'custom',
    });
    try {
      await server.listen();
      const address = server.httpServer?.address();
      if (!address || typeof address === 'string') throw new Error('Browser fixture did not bind a TCP port.');
      const script = join(directory, 'access-test.cjs');
      await writeFile(script, `
        const { app, BrowserWindow } = require('electron');
        const assert = require('node:assert/strict');
        app.setPath('userData', ${JSON.stringify(join(directory, 'profile'))});
        app.whenReady().then(async () => {
          const window = new BrowserWindow({ show: false, webPreferences: { contextIsolation: true } });
          const errors = [];
          window.webContents.on('console-message', (_event, level, message) => { if (level >= 3) errors.push(message); });
          const evaluate = code => window.webContents.executeJavaScript(code);
          async function wait(code) {
            const until = Date.now() + 7000;
            while (Date.now() < until) {
              if (await evaluate(code)) return;
              await new Promise(resolve => setTimeout(resolve, 20));
            }
            throw new Error('Timed out: ' + code + '\\n' + await evaluate('document.body.innerText') + '\\n' + errors.join('\\n'));
          }
          await window.loadURL('http://127.0.0.1:${address.port}/access-browser-test.html');
          await wait("document.querySelector('section tbody tr')?.textContent.includes('Pending')");
          assert.equal(await evaluate("document.querySelectorAll('section table').length"), 1);
          assert.equal(await evaluate("Array.from(document.querySelectorAll('button')).some(b => /Refresh|Save|Sign out/.test(b.textContent))"), false);
          await evaluate("document.querySelector('button.link').click()");
          await wait("document.querySelector('dialog').open && document.querySelectorAll('dialog input').length === 13");
          for (const width of [800, 1040]) {
            window.setSize(width, 760);
            const layout = await evaluate(\`Array.from(document.querySelectorAll('dialog input')).map(input => {
              const box = input.getBoundingClientRect();
              const cell = input.closest('td').getBoundingClientRect();
              const heading = document.querySelector('dialog thead tr').children[input.closest('td').cellIndex];
              const column = heading.getBoundingClientRect();
              return {
                x: Math.abs(box.x + box.width / 2 - cell.x - cell.width / 2),
                y: Math.abs(box.y + box.height / 2 - cell.y - cell.height / 2),
                column: Math.abs(box.x + box.width / 2 - column.x - column.width / 2),
                width: box.width, height: box.height, padding: getComputedStyle(input).padding,
                headingAlignment: getComputedStyle(heading).textAlign,
              };
            })\`);
            for (const box of layout) {
              assert.ok(box.x <= 0.5 && box.y <= 0.5 && box.column <= 0.5, JSON.stringify(box));
              assert.equal(box.width, 16);
              assert.equal(box.height, 16);
              assert.equal(box.padding, '0px');
              assert.equal(box.headingAlignment, 'center');
            }
          }
          await evaluate("document.querySelector('[aria-label=\\"Content create\\"]').click()");
          await wait("window.__accessTest.snapshot.requests[0].permissions.content.create && !document.querySelector('[aria-label=\\"Content create\\"]').disabled");
          await evaluate("window.__accessTest.fail = true; document.querySelector('[aria-label=\\"Content read\\"]').click()");
          await wait("document.querySelector('dialog [role=alert]')?.textContent === 'Permission update failed'");
          assert.equal(await evaluate("document.querySelector('[aria-label=\\"Content read\\"]').checked"), true);
          await evaluate("window.__accessTest.pausePoll = true");
          await wait("typeof window.__accessTest.releasePoll === 'function'");
          await evaluate("document.querySelector('[aria-label=\\"Tools run\\"]').click()");
          await wait("window.__accessTest.snapshot.requests[0].permissions.tools.run && !document.querySelector('[aria-label=\\"Tools run\\"]').disabled");
          await evaluate("window.__accessTest.releasePoll()");
          await new Promise(resolve => setTimeout(resolve, 100));
          assert.equal(await evaluate("document.querySelector('[aria-label=\\"Tools run\\"]').checked"), true);
          await evaluate("document.querySelector('dialog footer button').click()");
          await evaluate("Array.from(document.querySelectorAll('section button')).find(b => b.textContent === 'Approve').click()");
          await wait("document.querySelector('section tbody').textContent.includes('Awaiting claim')");
          await evaluate(\`{
            const state = window.__accessTest;
            const request = state.snapshot.requests[0];
            state.snapshot = { requests: [], clients: [{ ...request, id: '22222222-2222-4222-8222-222222222222', revokedAt: null }] };
          }\`);
          await wait("document.querySelector('section tbody').textContent.includes('Active')");
          assert.equal(await evaluate("document.querySelectorAll('section tbody tr').length"), 1);
          assert.equal(await evaluate("Array.from(document.querySelectorAll('section button')).some(b => b.textContent === 'Revoke')"), true);
          await evaluate(\`{
            const state = window.__accessTest;
            state.snapshot.clients[0].permissions.content.create = false;
            const none = { create: false, read: false, update: false, delete: false };
            state.snapshot.requests = [{
              ...state.snapshot.clients[0], id: '44444444-4444-4444-8444-444444444444',
              clientId: state.snapshot.clients[0].id, state: 'pending', purpose: 'permissions',
              permissions: { content: { ...none, create: true }, settings: { ...none }, tools: { ...none, run: false } },
            }];
          }\`);
          await wait("document.querySelector('.permission-request')?.textContent.includes('Create (Content)')");
          assert.equal(await evaluate("document.querySelector('.permission-request').getBoundingClientRect().top < document.querySelector('section h2').getBoundingClientRect().top"), true);
          assert.equal(await evaluate("document.querySelectorAll('section tbody tr').length"), 1);
          assert.equal(await evaluate("document.querySelector('section tbody').textContent.includes('Active')"), true);
          await evaluate("window.__accessTest.fail = true; document.querySelector('.permission-request button').click()");
          await wait("document.querySelector('section [role=alert]')?.textContent === 'Permission update failed'");
          assert.equal(await evaluate("window.__accessTest.snapshot.clients[0].permissions.content.create"), false);
          await evaluate("document.querySelector('.permission-request button').click()");
          await wait("!document.querySelector('.permission-request')");
          assert.equal(await evaluate("window.__accessTest.snapshot.clients[0].permissions.content.create"), true);
          assert.equal(await evaluate("window.__accessTest.snapshot.clients.length"), 1);
          assert.equal(await evaluate("window.__accessTest.snapshot.clients[0].permissions.tools.run"), true);
          await evaluate(\`{
            const state = window.__accessTest;
            state.snapshot.requests = [{ ...state.snapshot.clients[0], id: '33333333-3333-4333-8333-333333333333',
              clientId: state.snapshot.clients[0].id, state: 'pending', purpose: 'access' }];
          }\`);
          await wait("document.querySelector('section tbody').textContent.includes('Renewal pending')");
          assert.equal(await evaluate("document.querySelectorAll('section tbody tr').length"), 1);
          assert.deepEqual(errors, []);
          console.log('access-browser: autosave, rollback, stale polling, claim transition and renewal deduplication passed');
          window.destroy();
          app.exit(0);
        }).catch(error => { console.error(error); app.exit(1); });
      `);
      const { stdout } = await promisify(execFile)(executable, [script], {
        timeout: 25000, env: { ...process.env, ELECTRON_RUN_AS_NODE: '' },
      });
      expect(stdout).toContain('access-browser: autosave, rollback, stale polling, claim transition and renewal deduplication passed');
    } finally {
      await server.close();
      await rm(directory, { recursive: true, force: true });
    }
  }, 30000,
);
