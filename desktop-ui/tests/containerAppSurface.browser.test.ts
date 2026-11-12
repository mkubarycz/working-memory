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
  'opens authenticated container surfaces in app tabs, preserves menus, and closes them on navigation',
  async () => {
    const executable: unknown = createRequire(import.meta.url)('electron');
    if (typeof executable !== 'string') throw new Error('Electron executable is unavailable.');
    const directory = await mkdtemp(join(tmpdir(), 'wm-container-surface-'));
    const fixture = `
      import { mount, unmount } from 'svelte';
      import Detail from '/src/renderer/ContainerAppDetail.svelte';
      import '/src/renderer/style.css';
      const state = window.__surfaceTest = { mounts: [], closes: [], resizes: [], visibility: [], fail: false,
        opens: 0, sources: [], failOpen: false, releaseOpen: null };
      window.workingMemory = {
        async getAppMcpStatus() { return { state: 'disconnected' }; },
        async mountContainerAppSurface(...args) {
          state.mounts.push(args);
          if (state.fail) throw new Error('OpenObserve automatic sign-in failed (HTTP 401).');
        },
        async closeContainerAppSurface(id) { state.closes.push(id); },
        async resizeContainerAppSurface(...args) { state.resizes.push(args); },
        async setContainerAppSurfaceVisible(...args) { state.visibility.push(args); },
        async openObservability(source) {
          state.opens++;
          state.sources.push(source);
          await new Promise(resolve => state.releaseOpen = resolve);
          if (state.failOpen) throw new Error('OpenObserve window sign-in failed');
        },
      };
      const target = document.createElement('main');
      target.style.cssText = 'height: 600px; width: 900px';
      document.body.append(target);
      const app = { id: 'claim-id', displayName: 'Working Memory Observability', icon: 'pulse',
        embeddable: true, nativeSurface: 'observability' };
      const status = { ready: true, url: 'http://localhost:5080/web/' };
      let component;
      state.open = async (view = 'app', native = true) => {
        if (component) await unmount(component);
        component = mount(Detail, { target, props: {
          app: { ...app, nativeSurface: native ? 'observability' : undefined },
          status, view, reloadVersion: 0, onAttachResource() {},
        } });
      };
      state.dispose = () => unmount(component);
      state.open();
    `;
    const server = await createServer({
      configFile: false, root: new URL('..', import.meta.url).pathname,
      cacheDir: join(directory, 'vite-cache'), optimizeDeps: { include: ['svelte'] },
      plugins: [svelte(), {
        name: 'container-surface-fixture',
        resolveId: id => id === '/surface-fixture.js' ? '\0surface-fixture' : undefined,
        load: id => id === '\0surface-fixture' ? fixture : undefined,
        configureServer(server) {
          server.middlewares.use((req, res, next) => {
            if (req.url !== '/surface-test.html') { next(); return; }
            res.setHeader('content-type', 'text/html');
            res.end('<!doctype html><body><script type="module" src="/surface-fixture.js"></script>');
          });
        },
      }], server: { host: '127.0.0.1', port: 0 }, appType: 'custom',
    });
    try {
      await server.listen();
      const address = server.httpServer?.address();
      if (!address || typeof address === 'string') throw new Error('Container surface fixture did not bind.');
      const script = join(directory, 'surface-test.cjs');
      await writeFile(script, `
        const { app, BrowserWindow } = require('electron');
        const assert = require('node:assert/strict');
        app.setPath('userData', ${JSON.stringify(join(directory, 'profile'))});
        app.whenReady().then(async () => {
          const window = new BrowserWindow({ show: false });
          const evaluate = code => window.webContents.executeJavaScript(code);
          async function wait(code) {
            for (let i = 0; i < 200; i++) {
              if (await evaluate(code)) return;
              await new Promise(resolve => setTimeout(resolve, 25));
            }
            throw new Error('Timed out: ' + code + '\\n' + await evaluate('document.body.innerText'));
          }
          await window.loadURL('http://127.0.0.1:${address.port}/surface-test.html');
          await wait('window.__surfaceTest?.mounts.length === 1');
          assert.equal(await evaluate('document.querySelectorAll("iframe").length'), 0);
          const mounted = await evaluate('window.__surfaceTest.mounts[0]');
          assert.equal(mounted[0], 'claim-id');
          assert(mounted[2].width > 0 && mounted[2].height > 0);
          assert(mounted[2].y > await evaluate('document.querySelector(".container-app-dashboard-toolbar").getBoundingClientRect().y'));
          await evaluate('document.querySelector("[data-open=full]").click()');
          await wait('window.__surfaceTest.opens === 1');
          assert.equal(await evaluate('document.querySelector("[data-open=full]").disabled'), true);
          await evaluate('window.__surfaceTest.releaseOpen()');
          await wait('!document.querySelector("[data-open=full]").disabled');
          await evaluate('document.querySelector("[data-open=http]").click()');
          await wait('window.__surfaceTest.opens === 2');
          await evaluate('window.__surfaceTest.releaseOpen()');
          await wait('!document.querySelector("[data-open=queue]").disabled');
          await evaluate('document.querySelector("[data-open=queue]").click()');
          await wait('window.__surfaceTest.opens === 3');
          await evaluate('window.__surfaceTest.releaseOpen()');
          await wait('!document.querySelector("[data-open=full]").disabled');
          await evaluate('document.querySelector("[data-open=embeddings]").click()');
          await wait('window.__surfaceTest.opens === 4');
          await evaluate('window.__surfaceTest.releaseOpen()');
          await wait('!document.querySelector("[data-open=full]").disabled');
          assert.deepEqual(await evaluate('window.__surfaceTest.sources.slice(1)'), ['http', 'queue', 'embeddings']);
          await evaluate('window.__surfaceTest.failOpen = true; document.querySelector("[data-open=full]").click()');
          await wait('window.__surfaceTest.opens === 5');
          await evaluate('window.__surfaceTest.releaseOpen()');
          await wait('document.querySelector("[role=alert]")?.textContent.includes("window sign-in failed")');
          assert.equal(await evaluate('window.__surfaceTest.closes.length'), 0);
          await evaluate('document.body.insertAdjacentHTML("beforeend", "<div class=document-tab-menu>App Info</div>")');
          await wait('window.__surfaceTest.visibility.at(-1)?.[1] === false');
          await evaluate('document.querySelector(".document-tab-menu").remove()');
          await wait('window.__surfaceTest.visibility.at(-1)?.[1] === true');
          await evaluate('window.__surfaceTest.open("info")');
          await wait('window.__surfaceTest.closes.length === 1');
          assert.equal(await evaluate('window.__surfaceTest.closes[0]'), mounted[1]);
          assert.equal(await evaluate('window.__surfaceTest.mounts.length'), 1);
          await evaluate('window.__surfaceTest.open()');
          await wait('window.__surfaceTest.mounts.length === 2');
          await evaluate('window.__surfaceTest.fail = true; window.__surfaceTest.open()');
          await wait('document.querySelector("[role=alert]")?.textContent.includes("HTTP 401")');
          await evaluate('window.__surfaceTest.open("app", false)');
          await wait('!!document.querySelector("iframe")');
          assert.equal(await evaluate('document.querySelector("iframe").src'), 'http://localhost:5080/web/');
          await evaluate('window.__surfaceTest.dispose()');
          console.log('container-surface-browser-ok');
          app.exit(0);
        }).catch(error => { console.error(error); app.exit(1); });
      `);
      const { stdout } = await promisify(execFile)(executable, [script], {
        env: { ...process.env, ELECTRON_RUN_AS_NODE: '' }, timeout: 30000,
      });
      expect(stdout).toContain('container-surface-browser-ok');
    } finally {
      await server.close();
      await rm(directory, { recursive: true, force: true });
    }
  }, 60000,
);
