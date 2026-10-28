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
  'recovers model discovery without changing providers, routes, selected models or the last successful catalog',
  async () => {
    const executable: unknown = createRequire(import.meta.url)('electron');
    if (typeof executable !== 'string') throw new Error('Electron executable is unavailable.');
    const directory = await mkdtemp(join(tmpdir(), 'working-memory-model-settings-'));
    const fixture = `
      import { mount } from 'svelte';
      import Settings from '/src/renderer/documents/SettingsView.svelte';
      import '/src/renderer/style.css';
      const state = window.__modelsTest = {
        fail: true, calls: 0, saves: 0,
        profiles: [
          { id: 'copilot', name: 'Copilot', provider: 'copilot', endpoint: '', model: 'saved-model', apiKey: '' },
          { id: 'foundry', name: 'Foundry', provider: 'openai-compatible', endpoint: 'https://example.invalid', model: 'foundry-model', apiKey: '' },
        ],
        routing: Object.fromEntries(['simple', 'complex', 'deep'].flatMap(depth =>
          ['slow', 'medium', 'fast'].map(speed => [depth + ':' + speed, 'copilot']))),
      };
      window.workingMemory = {
        async listCopilotModels() {
          state.calls++;
          if (state.fail) throw new Error("Error invoking remote method 'config:copilot-models': Error: GitHub Copilot: Not signed in.");
          return { account: 'test-account', models: [
            { id: 'saved-model', name: 'Saved model' }, { id: 'other-model', name: 'Other model' },
          ] };
        },
      };
      mount(Settings, { target: document.body, props: {
        profiles: state.profiles, routing: state.routing, humanName: 'Test', credentialStorage: 'secure',
        settingsStatus: '', saving: false, testingProfileId: null, tab: 'models', selectedMcpUrl: null,
        onHumanName() {}, onAddProfile() {}, onRemoveProfile() {}, async onTestProfile() {},
        async onSave() { state.saves++; }, async onMakeCurrent() {}, async onInstancesChanged() {},
        onFeaturesChanged() {},
      } });
    `;
    const server = await createServer({
      configFile: false, root: new URL('..', import.meta.url).pathname,
      cacheDir: join(directory, 'vite-cache'), optimizeDeps: { include: ['svelte'] },
      plugins: [svelte(), {
        name: 'model-settings-fixture',
        resolveId: id => id === '/models-fixture.js' ? '\0models-fixture' : undefined,
        load: id => id === '\0models-fixture' ? fixture : undefined,
        configureServer(server) {
          server.middlewares.use((req, res, next) => {
            if (req.url !== '/models-test.html') { next(); return; }
            res.setHeader('content-type', 'text/html');
            res.end('<!doctype html><html><body><script type="module" src="/models-fixture.js"></script></body></html>');
          });
        },
      }],
      server: { host: '127.0.0.1', port: 0 }, appType: 'custom',
    });
    try {
      await server.listen();
      const address = server.httpServer?.address();
      if (!address || typeof address === 'string') throw new Error('Model fixture did not bind a TCP port.');
      const script = join(directory, 'models-test.cjs');
      await writeFile(script, `
        const { app, BrowserWindow } = require('electron');
        const assert = require('node:assert/strict');
        app.setPath('userData', ${JSON.stringify(join(directory, 'profile'))});
        app.whenReady().then(async () => {
          const window = new BrowserWindow({ show: false });
          const evaluate = code => window.webContents.executeJavaScript(code);
          async function wait(code) {
            const until = Date.now() + 7000;
            while (Date.now() < until) {
              if (await evaluate(code)) return;
              await new Promise(resolve => setTimeout(resolve, 20));
            }
            throw new Error('Timed out: ' + code + '\\n' + await evaluate('document.body.innerText'));
          }
          await window.loadURL('http://127.0.0.1:${address.port}/models-test.html');
          await wait("document.querySelector('.copilot-status')?.textContent.includes('Not signed in')");
          assert.equal(await evaluate("document.querySelector('.copilot-status').textContent.includes('remote method')"), false);
          assert.equal(await evaluate("document.querySelectorAll('.model-profile select')[1].value"), 'saved-model');
          assert.equal(await evaluate("document.querySelector('.model-profile-actions button').disabled"), false);
          assert.equal(await evaluate("document.querySelector('.model-profile-actions button').getBoundingClientRect().height < 50"), true);
          assert.equal(await evaluate("document.querySelector('.model-profile-actions button').getBoundingClientRect().width < 220"), true);
          await evaluate("window.__modelsTest.fail = false; document.querySelector('.model-profile-actions button').click()");
          await wait("document.querySelector('.copilot-status').textContent.includes('2 models available')");
          assert.equal(await evaluate("document.querySelectorAll('.model-profile select')[1].value"), 'saved-model');
          await evaluate(\`{
            const model = document.querySelectorAll('.model-profile select')[1];
            model.value = 'other-model';
            model.dispatchEvent(new Event('change', { bubbles: true }));
            window.__modelsTest.fail = true;
            document.querySelector('.model-profile-actions button').click();
          }\`);
          await wait("document.querySelector('.copilot-status').textContent.includes('Not signed in')");
          assert.equal(await evaluate("document.querySelectorAll('.model-profile select')[1].value"), 'other-model');
          assert.equal(await evaluate("document.querySelectorAll('.model-profile select')[1].options.length"), 3);
          assert.equal(await evaluate("Object.values(window.__modelsTest.routing).every(id => id === 'copilot')"), true);
          assert.equal(await evaluate("window.__modelsTest.profiles[0].provider"), 'copilot');
          assert.equal(await evaluate("window.__modelsTest.profiles[1].model"), 'foundry-model');
          await evaluate("document.querySelector('.settings-actions button').click()");
          assert.equal(await evaluate("window.__modelsTest.saves"), 1);
          assert.equal(await evaluate("window.__modelsTest.calls"), 3);
          console.log('model-settings-browser: retry, selection, routes, catalog, save and compact layout passed');
          app.quit();
        }).catch(error => { console.error(error); app.exit(1); });
      `);
      const { stdout } = await promisify(execFile)(executable, [script], {
        timeout: 25_000, env: { ...process.env, ELECTRON_RUN_AS_NODE: '' },
      });
      expect(stdout).toContain('model-settings-browser: retry, selection, routes, catalog, save and compact layout passed');
    } finally {
      await server.close();
      await rm(directory, { recursive: true, force: true });
    }
  }, 30_000,
);
