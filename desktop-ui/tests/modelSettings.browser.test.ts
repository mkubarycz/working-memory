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
      <script>
      import Settings from '/src/renderer/documents/SettingsView.svelte';
      import '/src/renderer/style.css';
      import { createDocumentSaveQueue } from '/src/renderer/documentSaveQueue';
      const state = $state({
        fail: true, calls: 0, saves: 0, writes: [], stored: null,
        humanName: 'Test', settingsStatus: '', settingsError: false, saving: false,
        pauseSave: false, releaseSave: null, failSave: false, inFlight: 0, maxInFlight: 0,
        profiles: [
          { id: 'copilot', name: 'Copilot', provider: 'copilot', endpoint: '', model: 'saved-model', apiKey: '', hasApiKey: false },
          { id: 'foundry', name: 'Foundry', provider: 'openai-compatible', endpoint: 'https://example.invalid', model: 'foundry-model', apiKey: '', hasApiKey: false },
        ],
        routing: Object.fromEntries(['simple', 'complex', 'deep'].flatMap(depth =>
          ['slow', 'medium', 'fast'].map(speed => [depth + ':' + speed, 'copilot']))),
      });
      window.__modelsTest = state;
      const capture = () => ({
        profiles: state.profiles.map(profile => ({ ...profile })),
        routing: { ...state.routing }, humanName: state.humanName,
      });
      const queue = createDocumentSaveQueue({
        delayMs: 400,
        async save(_key, input) {
          state.saving = true; state.inFlight++;
          state.maxInFlight = Math.max(state.maxInFlight, state.inFlight);
          state.saves++; state.writes.push(structuredClone(input));
          try {
            if (state.pauseSave) {
              state.pauseSave = false;
              await new Promise(resolve => state.releaseSave = resolve);
            }
            if (state.failSave) { state.failSave = false; throw new Error('Configuration write failed'); }
            if (input.profiles.some(profile => !profile.name.trim() || !profile.model.trim())) {
              throw new Error('Every model profile needs a name and model.');
            }
            state.stored = structuredClone(input);
            return { ...input, profiles: input.profiles.map(({ apiKey, ...profile }) => ({
              ...profile, hasApiKey: Boolean(apiKey || profile.hasApiKey),
            })) };
          } finally { state.saving = false; state.inFlight--; }
        },
        onPending() { state.settingsError = false; state.settingsStatus = 'Waiting to save...'; },
        onSaving() { state.settingsError = false; state.settingsStatus = 'Saving...'; },
        onSaved(_key, result) {
          state.profiles = result.profiles.map(profile => ({ ...profile, apiKey: '' }));
          state.routing = { ...result.routing }; state.humanName = result.humanName;
          state.settingsStatus = 'Saved automatically.';
        },
        onError(_key, error) { state.settingsError = true; state.settingsStatus = 'Not saved: ' + error.message; },
      });
      const changed = () => queue.schedule('settings', capture());
      const flush = () => {
        if (state.settingsError) changed();
        void queue.flushAll().catch(error => {
          state.settingsError = true; state.settingsStatus = 'Not saved: ' + error.message;
        });
      };
      function add() {
        state.profiles = [...state.profiles, { id: 'new', name: 'Model 3', provider: 'openai-compatible',
          endpoint: 'http://localhost:11434/v1', model: '', apiKey: '', hasApiKey: false }];
      }
      function remove(id) {
        state.profiles = state.profiles.filter(profile => profile.id !== id);
        state.routing = Object.fromEntries(Object.entries(state.routing)
          .map(([key, value]) => [key, value === id ? state.profiles[0].id : value]));
      }
      window.workingMemory = {
        async listCopilotModels() {
          state.calls++;
          if (state.fail) throw new Error("Error invoking remote method 'config:copilot-models': Error: GitHub Copilot: Not signed in.");
          return { account: 'test-account', models: [
            { id: 'saved-model', name: 'Saved model' }, { id: 'other-model', name: 'Other model' },
          ] };
        },
      };
      </script>
      <Settings profiles={state.profiles} routing={state.routing} humanName={state.humanName}
        credentialStorage="secure" settingsStatus={state.settingsStatus} settingsError={state.settingsError}
        saving={state.saving} testingProfileId={null} tab="models" selectedMcpUrl={null}
        onHumanName={value => state.humanName = value} onAddProfile={add} onRemoveProfile={remove}
        onTestProfile={async () => {}} onChange={changed} onFlush={flush}
        onMakeCurrent={async () => {}} onInstancesChanged={async () => {}} onFeaturesChanged={() => {}} />
    `;
    const harness = join(directory, 'ModelsHarness.svelte');
    await writeFile(harness, fixture);
    const server = await createServer({
      configFile: false, root: new URL('..', import.meta.url).pathname,
      cacheDir: join(directory, 'vite-cache'), optimizeDeps: { include: ['svelte'] },
      plugins: [svelte(), {
        name: 'model-settings-fixture',
        resolveId: id => id === '/models-fixture.js' ? '\0models-fixture' : undefined,
        load: id => id === '\0models-fixture'
          ? `import { mount, unmount } from 'svelte'; import Harness from ${JSON.stringify(harness)};
             const component = mount(Harness, { target: document.body });
             window.__modelsTest.unmount = () => unmount(component);`
          : undefined,
        configureServer(server) {
          server.middlewares.use((req, res, next) => {
            if (req.url !== '/models-test.html') { next(); return; }
            res.setHeader('content-type', 'text/html');
            res.end('<!doctype html><html><body><script type="module" src="/models-fixture.js"></script></body></html>');
          });
        },
      }],
      resolve: { dedupe: ['svelte'] },
      server: { host: '127.0.0.1', port: 0, fs: { allow: [new URL('../..', import.meta.url).pathname, directory] } },
      appType: 'custom',
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
          assert.equal(await evaluate("Array.from(document.querySelectorAll('[role=tab]')).some(tab => tab.textContent === 'Routing matrix')"), false);
          assert.equal(await evaluate("document.querySelectorAll('.routing-matrix select').length"), 9);
          assert.equal(await evaluate("Array.from(document.querySelectorAll('button')).some(button => button.textContent.trim() === 'Save')"), false);
          assert.equal(await evaluate("window.__modelsTest.saves"), 0);
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
          await wait("document.querySelector('.settings-actions').textContent === 'Saved automatically.'");
          assert.equal(await evaluate("window.__modelsTest.saves"), 1);
          assert.equal(await evaluate("window.__modelsTest.calls"), 3);
          const field = (profile, input) => "document.querySelectorAll('.model-profile')[" + profile + "].querySelectorAll('input')[" + input + "]";
          const edit = (selector, value) => evaluate("(() => { const input = " + selector + "; input.value = "
            + JSON.stringify(value) + "; input.dispatchEvent(new Event('input', { bubbles: true })); })()");
          const button = text => "Array.from(document.querySelectorAll('button')).find(button => button.textContent.trim() === " + JSON.stringify(text) + ")";
          for (const name of ['Foundry A', 'Foundry B', 'Foundry C']) await edit(field(1, 0), name);
          await evaluate("(() => { const route = document.querySelector('.routing-matrix select'); route.value = 'foundry'; route.dispatchEvent(new Event('change', { bubbles: true })); })()");
          await wait("window.__modelsTest.stored?.profiles[1].name === 'Foundry C' && document.querySelector('.settings-actions').textContent === 'Saved automatically.'");
          assert.equal(await evaluate("window.__modelsTest.saves"), 2);
          assert.equal(await evaluate("window.__modelsTest.stored.routing['simple:slow']"), 'foundry');
          await evaluate("window.__modelsTest.pauseSave = true");
          await edit(field(1, 0), 'Pending');
          await wait("typeof window.__modelsTest.releaseSave === 'function'");
          await edit(field(1, 0), 'Newer');
          await new Promise(resolve => setTimeout(resolve, 600));
          await edit(field(1, 0), 'Newest');
          await new Promise(resolve => setTimeout(resolve, 600));
          assert.equal(await evaluate(field(1, 0) + '.value'), 'Newest');
          assert.equal(await evaluate("window.__modelsTest.saves"), 3);
          await evaluate("window.__modelsTest.releaseSave()");
          await wait("window.__modelsTest.stored.profiles[1].name === 'Newest' && document.querySelector('.settings-actions').textContent === 'Saved automatically.'");
          assert.equal(await evaluate("window.__modelsTest.saves"), 4);
          assert.equal(await evaluate("window.__modelsTest.maxInFlight"), 1);
          assert.equal(await evaluate(field(1, 0) + '.value'), 'Newest');
          await evaluate("window.__modelsTest.failSave = true");
          await edit(field(1, 0), 'Retry me');
          await wait("document.querySelector('.settings-actions[role=alert]')?.textContent.includes('Configuration write failed')");
          assert.equal(await evaluate(field(1, 0) + '.value'), 'Retry me');
          await evaluate(field(1, 0) + ".dispatchEvent(new FocusEvent('focusout', { bubbles: true }))");
          await wait("window.__modelsTest.stored.profiles[1].name === 'Retry me' && document.querySelector('.settings-actions').textContent === 'Saved automatically.'");
          await evaluate(button('Add model profile') + '.click()');
          await wait("document.querySelector('.settings-actions[role=alert]')?.textContent.includes('name and model')");
          assert.equal(await evaluate("window.__modelsTest.stored.profiles.length"), 2);
          await edit(field(2, 2), 'qa-model');
          await wait("window.__modelsTest.stored.profiles.length === 3 && document.querySelector('.settings-actions').textContent === 'Saved automatically.'");
          await edit(field(2, 3), 'synthetic-key');
          await wait("window.__modelsTest.profiles[2].hasApiKey === true && " + field(2, 3) + ".value === ''");
          assert.equal(await evaluate("window.__modelsTest.stored.profiles[2].apiKey"), 'synthetic-key');
          await evaluate("(() => { const route = document.querySelector('.routing-matrix select'); route.value = 'new'; route.dispatchEvent(new Event('change', { bubbles: true })); })()");
          await wait("window.__modelsTest.stored.routing['simple:slow'] === 'new' && document.querySelector('.settings-actions').textContent === 'Saved automatically.'");
          await evaluate("document.querySelectorAll('.remove-model')[2].click()");
          await wait("window.__modelsTest.stored.profiles.length === 2 && document.querySelector('.settings-actions').textContent === 'Saved automatically.'");
          assert.equal(await evaluate("window.__modelsTest.stored.routing['simple:slow']"), 'copilot');
          await evaluate(button('Human') + '.click()');
          await edit("document.querySelector('input[placeholder=\\"Flesh Bag\\"]')", 'QA Human');
          await wait("window.__modelsTest.stored.humanName === 'QA Human' && document.querySelector('.settings-actions').textContent === 'Saved automatically.'");
          assert.equal(await evaluate(button('Save') + ' === undefined'), true);
          await evaluate(button('Models') + '.click()');
          await edit(field(1, 0), 'Leaving view');
          await evaluate("window.__modelsTest.unmount()");
          await wait("window.__modelsTest.stored.profiles[1].name === 'Leaving view'");
          console.log('model-settings-browser: retry, selection, routes, catalog, autosave, queue, errors and compact layout passed');
          app.quit();
        }).catch(error => { console.error(error); app.exit(1); });
      `);
      const { stdout } = await promisify(execFile)(executable, [script], {
        timeout: 25_000, env: { ...process.env, ELECTRON_RUN_AS_NODE: '' },
      });
      expect(stdout).toContain('model-settings-browser: retry, selection, routes, catalog, autosave, queue, errors and compact layout passed');
    } finally {
      await server.close();
      await rm(directory, { recursive: true, force: true });
    }
  }, 30_000,
);
