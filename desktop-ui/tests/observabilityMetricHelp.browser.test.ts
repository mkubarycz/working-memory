import { expect, it } from 'vitest';
import { build } from 'esbuild';
import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

it.skipIf(process.platform === 'linux' && !process.env.DISPLAY)(
  'preserves safe accessible header help and refreshes the same native view without another login',
  async () => {
    const executable: unknown = createRequire(import.meta.url)('electron');
    if (typeof executable !== 'string') throw new Error('Electron executable is unavailable.');
    const directory = await mkdtemp(join(tmpdir(), 'wm-metric-help-'));
    let revision = 1;
    let logins = 0;
    const server = createServer((request, response) => {
      const path = request.url?.split('?')[0];
      response.setHeader('content-type', 'application/json');
      if (path === '/auth/login') { logins++; response.end(JSON.stringify({ status: true })); }
      else if (path === '/api/default/dashboards') response.end(JSON.stringify({
        dashboards: [{ title: 'Working Memory diagnostics', dashboard_id: 'baseline', folder_id: 'default' }],
      }));
      else if (path === '/api/default/dashboards/baseline') response.end(JSON.stringify({
        version: 8, v8: { tabs: [{ panels: [
          { id: 'queue-depth', title: 'Maximum queue depth', description: `Revision ${revision}: <b>literal text</b>, not markup.` },
          { id: 'other', title: 'Other metric', description: 'Another saved collection explanation.' },
        ] }] },
      }));
      else if (path === '/next-revision') { revision++; response.end('{}'); }
      else if (path === '/live-value') response.end(JSON.stringify({ value: revision }));
      else if (path === '/web/dashboards/view') {
        response.setHeader('content-type', 'text/html');
        response.end(`<!doctype html><body style="height:1400px">
          <button data-test="dashboard-refresh-btn" style="display:none">Refresh</button>
          <output id="latest"></output>
          <div class="grid-stack-item" gs-id="queue-depth" style="width:220px;overflow:hidden">
            <div data-test="dashboard-panel-bar" style="display:flex;align-items:center">
              <span>Maximum queue depth</span>
            </div>
          </div>
          <script>
            window.refreshes = 0;
            document.querySelector('[data-test="dashboard-refresh-btn"]').onclick = async () => {
              window.refreshes++;
              const {value} = await fetch('/live-value').then(response=>response.json());
              document.querySelector('#latest').textContent = value;
            };
            window.switchMetric = () => {
              const item = document.createElement('div');
              item.className = 'grid-stack-item'; item.setAttribute('gs-id', 'other');
              const header = document.createElement('div');
              header.setAttribute('data-test', 'dashboard-panel-bar'); header.textContent = 'Other metric';
              item.append(header); document.querySelector('.grid-stack-item').replaceWith(item);
            };
          </script>`);
      } else response.end('{}');
    });
    try {
      await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
      const address = server.address();
      if (!address || typeof address === 'string') throw new Error('Metric help fixture did not bind.');
      const bundle = join(directory, 'observability.cjs'), script = join(directory, 'check.cjs');
      await build({
        entryPoints: [new URL('../src/main/observabilityWindow.ts', import.meta.url).pathname],
        bundle: true, platform: 'node', format: 'cjs', external: ['electron'], outfile: bundle,
      });
      await writeFile(script, `
        const { app, BrowserWindow, webContents } = require('electron');
        const assert = require('node:assert/strict');
        const { ObservabilitySurface } = require(${JSON.stringify(bundle)});
        const realSetInterval = globalThis.setInterval;
        globalThis.setInterval = (callback, ms, ...args) =>
          realSetInterval(callback, ms === 10000 ? 100 : ms, ...args);
        app.setPath('userData', ${JSON.stringify(join(directory, 'profile'))});
        app.whenReady().then(async () => {
          const surface = new ObservabilitySurface(), parent = new BrowserWindow({ show: false });
          const origin = 'http://localhost:${address.port}';
          await surface.open('qa', parent, {x:0,y:0,width:240,height:180},
            async () => ({url:origin,credentials:{username:'fixture',password:'fixture-only'}}));
          const content = webContents.getAllWebContents().find(item => item.getURL().startsWith(origin));
          content.setBackgroundThrottling(false);
          const evaluate = code => content.executeJavaScript(code);
          async function wait(code) {
            for(let i=0;i<100;i++) {
              if(await evaluate(code)) return;
              await new Promise(resolve=>setTimeout(resolve,25));
            }
            throw new Error('Timed out: '+code);
          }
          const query = '[data-wm-metric-help]', open = '[data-wm-metric-popover]:popover-open';
          assert.equal(new URL(content.getURL()).searchParams.get('tab'),'queue');
          await wait('document.querySelectorAll('+JSON.stringify(query)+').length === 1');
          assert.equal(await evaluate('document.querySelector('+JSON.stringify(query)+').title'),
            'Revision 1: <b>literal text</b>, not markup.');
          await evaluate('document.querySelector('+JSON.stringify(query)+').focus()');
          content.sendInputEvent({type:'keyDown',keyCode:'Space'});
          content.sendInputEvent({type:'keyUp',keyCode:'Space'});
          await wait('Boolean(document.querySelector('+JSON.stringify(open)+'))');
          assert.equal(await evaluate('document.querySelector('+JSON.stringify(open)+').querySelectorAll("b").length'),0);
          assert.equal(await evaluate('document.querySelector('+JSON.stringify(open)+').textContent'),
            'Revision 1: <b>literal text</b>, not markup.');
          assert(await evaluate('(()=>{const r=document.querySelector('+JSON.stringify(open)+').getBoundingClientRect();return r.left>=0 && r.top>=0 && r.right<=innerWidth && r.bottom<=innerHeight})()'));
          content.sendInputEvent({type:'keyDown',keyCode:'Escape'});
          content.sendInputEvent({type:'keyUp',keyCode:'Escape'});
          await wait('!document.querySelector('+JSON.stringify(open)+')');
          await evaluate('document.querySelector('+JSON.stringify(query)+').click()');
          await wait('Boolean(document.querySelector('+JSON.stringify(open)+'))');
          await evaluate('document.querySelector('+JSON.stringify(open)+').dispatchEvent(new Event("scroll"))');
          assert(await evaluate('Boolean(document.querySelector('+JSON.stringify(open)+'))'));
          await evaluate('dispatchEvent(new Event("resize"))');
          await wait('!document.querySelector('+JSON.stringify(open)+')');
          await evaluate('window.switchMetric()');
          await wait('document.querySelector('+JSON.stringify(query)+')?.getAttribute("data-wm-metric-help") === "other"');
          assert.equal(await evaluate('document.querySelectorAll('+JSON.stringify(query)+').length'),1);
          await evaluate('fetch("/next-revision").then(response=>response.json())');
          await content.loadURL(content.getURL());
          await wait('document.querySelector('+JSON.stringify(query)+')?.title.startsWith("Revision 2:")');
          await wait('window.refreshes >= 2 && document.querySelector("#latest").textContent === "2"');
          const currentUrl = content.getURL();
          await evaluate('fetch("/next-revision").then(response=>response.json())');
          await wait('document.querySelector("#latest").textContent === "3"');
          assert.equal(content.getURL(), currentUrl);
          assert.equal(await evaluate('document.querySelector(".grid-stack-item").getAttribute("gs-id")'), 'queue-depth');
          await evaluate('document.querySelector("[data-test=dashboard-refresh-btn]").disabled = true');
          let count = await evaluate('window.refreshes');
          await new Promise(resolve=>setTimeout(resolve,250));
          assert.equal(await evaluate('window.refreshes'), count);
          await evaluate('document.querySelector("[data-test=dashboard-refresh-btn]").disabled = false');
          surface.setVisible('qa', false);
          count = await evaluate('window.refreshes');
          await new Promise(resolve=>setTimeout(resolve,250));
          assert.equal(await evaluate('window.refreshes'), count);
          surface.setVisible('qa', true);
          await wait('window.refreshes > '+count);
          assert.equal(await evaluate('document.querySelectorAll('+JSON.stringify(query)+').length'), 1);
          surface.close('qa'); parent.destroy();
          app.exit(0);
        }).catch(error=>{ console.error(error); app.exit(1); });
      `);
      const result = await promisify(execFile)(executable, [script], {
        env: { ...process.env, ELECTRON_RUN_AS_NODE: '' }, timeout: 20000,
      });
      expect(result.stderr).not.toContain('AssertionError');
      expect(logins).toBe(1);
    } finally {
      await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
      await rm(directory, { recursive: true, force: true });
    }
  }, 30000,
);
