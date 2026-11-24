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
  'organizes System settings, caches instances, polls only while visible, and preserves actions',
  async () => {
    const executable: unknown = createRequire(import.meta.url)('electron');
    if (typeof executable !== 'string') throw new Error('Electron executable is unavailable.');
    const directory = await mkdtemp(join(tmpdir(), 'wm-updates-settings-'));
    const harness = join(directory, 'UpdatesHarness.svelte');
    await writeFile(harness, `
      <script>
        import Settings from '/src/renderer/documents/SettingsView.svelte';
        import '/src/renderer/style.css';
        let tab = $state('system');
        let systemTab = $state('back-end');
        let selectedMcpUrl = $state('http://127.0.0.1:7717/mcp');
        const probe = window.__updatesTest = {
          backendReads: 0, backendChannels: [], operations: [], changes: 0,
          frontendReads: 0, frontendChannels: [], frontendActions: [],
          subscriptions: 0, unsubscriptions: 0, listener: null, provider: 'docker', providerChanges: [],
          hidden: false, failRefresh: false, holdRefresh: false, releaseRefresh: null, polls: new Map(),
          failUpgrade: true, failReport: true, reports: [], preparations: [], sends: [],
        };
        Object.defineProperty(document, 'hidden', { get: () => probe.hidden });
        const realNow = Date.now;
        let elapsed = 0;
        Date.now = () => realNow() + elapsed;
        const realSetInterval = window.setInterval;
        const realClearInterval = window.clearInterval;
        let timerId = -1;
        window.setInterval = (callback, delay, ...args) => {
          if (delay !== 15000) return realSetInterval(callback, delay, ...args);
          const id = timerId--;
          probe.polls.set(id, callback);
          return id;
        };
        window.clearInterval = id => {
          if (!probe.polls.delete(id)) realClearInterval(id);
        };
        probe.advance = () => {
          elapsed += 15000;
          for (const poll of probe.polls.values()) poll();
        };
        const backend = {
          appVersion: '1.4.1', backendChannel: 'off',
          backendTarget: { version: '1.4.2', image: 'working-memory-control-plane:1.4.2' },
          backendTargetError: null, dockerError: 'Container image inspection is unavailable', selfHosted: [],
          instances: [
            { port: 7717, name: 'Current', createdAt: '', mcpUrl: 'http://127.0.0.1:7717/mcp',
              container: 'working-memory-control-plane', state: 'running', version: '1.4.1', updateAvailable: false },
            { port: 7719, name: 'Test', createdAt: '', mcpUrl: 'http://127.0.0.1:7719/mcp',
              container: 'working-memory-control-plane-7719', state: 'stopped', version: '1.4.0', updateAvailable: true },
            { port: 7721, name: 'Unavailable', createdAt: '', mcpUrl: 'http://127.0.0.1:7721/mcp',
              container: 'working-memory-control-plane-7721', state: 'unknown', version: null, updateAvailable: false },
          ],
        };
        const frontend = {
          supported: true, unsupportedReason: null, currentVersion: '1.4.1', channel: 'stable', phase: 'available',
          available: { version: '1.4.2', publishedAt: null, releaseUrl: 'https://example.invalid/release' },
          progress: null, error: null, checkedAt: null,
        };
        probe.openInstances = () => { systemTab = 'back-end'; tab = 'system'; };
        probe.changeBackend = change => Object.assign(backend, change);
        probe.restoreUpgrade = () => {
          probe.failUpgrade = false;
          Object.assign(backend.instances[1], { state: 'running', version: '1.4.0', updateAvailable: true });
        };
        probe.emit = change => {
          Object.assign(frontend, change);
          probe.listener?.(structuredClone(frontend));
        };
        window.workingMemory = {
          async getContainerProvider() { return probe.provider; },
          async setContainerProvider(provider) {
            probe.providerChanges.push(provider); probe.provider = provider;
            backend.dockerError = provider === 'podman' ? 'Podman is unavailable. Start it, then Retry.' : null;
          },
          async listInstances() {
            probe.backendReads++;
            if (probe.failRefresh) throw new Error('Backend refresh unavailable');
            const result = structuredClone(backend);
            if (probe.holdRefresh) await new Promise(resolve => {
              probe.releaseRefresh = () => { probe.holdRefresh = false; resolve(); };
            });
            return result;
          },
          async recoverInstances() {
            probe.operations.push('recover');
            backend.dockerError = null;
            backend.recoveryAvailable = false;
            return structuredClone(backend);
          },
          async setBackendUpdateChannel(channel) {
            probe.backendChannels.push(channel); backend.backendChannel = channel;
            return structuredClone(backend);
          },
          async startInstance(port) {
            probe.operations.push('start:' + port);
            backend.instances.find(instance => instance.port === port).state = 'running';
            return structuredClone(backend);
          },
          async upgradeInstance(port) {
            probe.operations.push('upgrade:' + port);
            const instance = backend.instances.find(instance => instance.port === port);
            if (probe.failUpgrade) {
              instance.state = 'missing'; instance.version = null;
              throw new Error("Error invoking remote method 'instances:upgrade': Error: bind: address already in use");
            }
            instance.version = backend.backendTarget.version; instance.updateAvailable = false;
            return structuredClone(backend);
          },
          async createBackendBugReport(input) {
            probe.reports.push(structuredClone(input));
            if (probe.failReport) { probe.failReport = false; throw new Error('Report capture failed. Retry.'); }
            return { id: 'report-id', title: 'Backend settings bug', body: JSON.stringify(input), sessionOnly: true };
          },
          async getPublicFeedbackSettings() {
            const state = probe.feedbackState ?? 'connected';
            return { enabled: state === 'connected', state, destination: 'https://feedback.example/api',
              ...(state === 'pending' ? { pairingCode: 'ABCDEF123456', expiresAt: '2099-01-01T00:00:00Z' } : {}) };
          },
          async connectPublicFeedback() { probe.feedbackState = 'pending'; return this.getPublicFeedbackSettings(); },
          async clearPublicFeedbackSettings() {
            if (probe.failDisconnect) throw new Error('Revocation unavailable. Retry disconnect.');
            probe.feedbackState = 'disconnected'; return this.getPublicFeedbackSettings();
          },
          async prepareFeedback(id, requestId) {
            probe.preparations.push({ id, requestId });
            return { destination: 'feedback.example',
              context: { desktop: { version: '1.4.1', build: 'fixture' }, backend: { version: '1.4.0' } } };
          },
          async sendFeedback(id, requestId) {
            probe.sends.push({ id, requestId });
            return { status: 'queued', requestId, destination: 'feedback.example', uploadedAt: new Date().toISOString() };
          },
          onDesktopUpdate(listener) {
            probe.subscriptions++; probe.listener = listener;
            return () => { probe.unsubscriptions++; probe.listener = null; };
          },
          async getDesktopUpdate() { probe.frontendReads++; return structuredClone(frontend); },
          async setDesktopUpdateChannel(channel) {
            probe.frontendChannels.push(channel); frontend.channel = channel;
            return structuredClone(frontend);
          },
          async checkDesktopUpdate() { probe.frontendActions.push('check'); return structuredClone(frontend); },
          async downloadDesktopUpdate() {
            probe.frontendActions.push('download'); frontend.phase = 'ready'; return structuredClone(frontend);
          },
        };
      </script>
      <Settings profiles={[]} routing={{}} humanName="Test" credentialStorage="secure"
        settingsStatus="" saving={false} testingProfileId={null} bind:tab bind:systemTab {selectedMcpUrl}
        onHumanName={() => {}} onAddProfile={() => {}} onRemoveProfile={() => {}} onTestProfile={async () => {}}
        onChange={() => {}} onFlush={() => {}}
        onMakeCurrent={async url => { selectedMcpUrl = url; probe.operations.push('current:' + url); }}
        onInstancesChanged={async () => { probe.changes++; }} onFeaturesChanged={() => {}} />
    `);
    const server = await createServer({
      configFile: false, root: fileURLToPath(new URL('..', import.meta.url)), cacheDir: join(directory, 'vite-cache'),
      resolve: { dedupe: ['svelte', 'zod'] }, optimizeDeps: { include: ['svelte', 'zod'] },
      plugins: [svelte(), {
        name: 'updates-settings-fixture',
        resolveId: id => id === '/updates-fixture.js' ? '\0updates-fixture' : undefined,
        load: id => id === '\0updates-fixture'
          ? `import { mount } from 'svelte'; import Harness from ${JSON.stringify(harness)}; mount(Harness, { target: document.body });`
          : undefined,
        configureServer(server) {
          server.middlewares.use((req, res, next) => {
            if (req.url !== '/updates-test.html') { next(); return; }
            res.setHeader('content-type', 'text/html');
            res.end('<!doctype html><html><body><script type="module" src="/updates-fixture.js"></script></body></html>');
          });
        },
      }],
      server: { host: '127.0.0.1', port: 0, fs: { allow: [fileURLToPath(new URL('../..', import.meta.url)), directory] } },
      appType: 'custom',
    });
    try {
      await server.listen();
      const address = server.httpServer?.address();
      if (!address || typeof address === 'string') throw new Error('Updates fixture did not bind.');
      const script = join(directory, 'updates-test.cjs');
      await writeFile(script, `
        const { app, BrowserWindow } = require('electron');
        const assert = require('node:assert/strict');
        app.setPath('userData', ${JSON.stringify(join(directory, 'profile'))});
        app.whenReady().then(async () => {
          const window = new BrowserWindow({ show: false, width: 1000, height: 900 });
          const evaluate = code => window.webContents.executeJavaScript(code);
          const button = text => "Array.from(document.querySelectorAll('button')).find(button => button.textContent.trim() === " + JSON.stringify(text) + ")";
          async function wait(code) {
            const deadline = Date.now() + 7000;
            while (Date.now() < deadline) {
              if (await evaluate(code)) return;
              await new Promise(resolve => setTimeout(resolve, 20));
            }
            throw new Error('Timed out: ' + code + '\\n' + await evaluate('document.body.innerText'));
          }
          await window.loadURL('http://127.0.0.1:${address.port}/updates-test.html');
          await wait("document.querySelectorAll('.instance').length === 3");
          assert.deepEqual(await evaluate("Array.from(document.querySelectorAll('.instance-version strong')).map(version => version.textContent)"), ['1.4.1', '1.4.0', 'Unknown']);
          assert.equal(await evaluate("Array.from(document.querySelectorAll('.instance-version')).every(version => version.textContent.includes('Current version'))"), true);
          assert.equal(await evaluate("document.querySelectorAll('.instance-version')[2].textContent.includes('Update availability cannot be determined.')"), true);
          assert.equal(await evaluate("document.querySelector('.instances-note[role=alert]').textContent.includes('Container image inspection is unavailable')"), true);
          assert.equal(await evaluate("Array.from(document.querySelectorAll('.instance')[0].querySelectorAll('button')).find(button => button.textContent.trim() === 'Back up…').disabled"), false);
          assert.equal(await evaluate(button('Instances') + ' === undefined'), true);
          assert.equal(await evaluate("document.querySelector('[aria-label=Settings] [aria-selected=true]').textContent"), 'System');
          assert.equal(await evaluate("document.querySelector('[aria-label=System] [aria-selected=true]').textContent"), 'Backend');
          assert.deepEqual(await evaluate("Array.from(document.querySelectorAll('[aria-label=System] button')).map(button => button.textContent)"), ['Front End', 'Backend', 'Container Provider']);
          assert.equal(await evaluate("document.querySelector('.container-provider')"), null);
          assert.equal(await evaluate("window.__updatesTest.backendReads"), 1);
          await evaluate(button('Models') + '.click()');
          await wait("window.__updatesTest.polls.size === 0");
          await evaluate(button('System') + '.click()');
          await wait("document.querySelectorAll('.instance').length === 3");
          assert.equal(await evaluate("window.__updatesTest.backendReads"), 1);
          assert.equal(await evaluate("document.body.innerText.includes('Loading instances')"), false);
          await evaluate("window.__updatesTest.changeBackend({ dockerError: null }); window.__updatesTest.advance()");
          await wait("window.__updatesTest.backendReads === 2 && !document.querySelector('.instances-note[role=alert]')");
          await evaluate("window.__updatesTest.failRefresh = true; window.__updatesTest.advance()");
          await wait("document.querySelector('.instances-note[role=alert]')?.textContent.includes('Backend refresh unavailable')");
          assert.equal(await evaluate("document.querySelectorAll('.instance').length"), 3);
          await evaluate("window.__updatesTest.failRefresh = false; " + button('Retry') + '.click()');
          await wait("window.__updatesTest.backendReads === 4 && !document.querySelector('.instances-note[role=alert]')");
          await evaluate("window.__updatesTest.hidden = true; window.__updatesTest.advance()");
          assert.equal(await evaluate("window.__updatesTest.backendReads"), 4);
          await evaluate("window.__updatesTest.hidden = false; document.dispatchEvent(new Event('visibilitychange'))");
          await wait("window.__updatesTest.backendReads === 5");
          assert.equal(await evaluate("window.__updatesTest.frontendReads"), 0);
          await evaluate("window.__updatesTest.holdRefresh = true; window.__updatesTest.advance()");
          await wait("window.__updatesTest.releaseRefresh !== null");
          await evaluate("window.__updatesTest.advance()");
          assert.equal(await evaluate("window.__updatesTest.backendReads"), 6);
          await evaluate("(() => { const channel = document.querySelector('.backend-channel select'); channel.value = 'canary'; channel.dispatchEvent(new Event('change', { bubbles: true })); })()");
          await wait("window.__updatesTest.backendChannels[0] === 'canary' && !document.querySelector('.backend-channel select').disabled");
          await evaluate("window.__updatesTest.releaseRefresh(); new Promise(resolve => setTimeout(resolve, 0))");
          assert.equal(await evaluate("document.querySelector('.backend-channel select').value"), 'canary');
          await evaluate(button('Start') + '.click()');
          await wait("window.__updatesTest.operations.includes('start:7719') && " + button('Make current') + "?.disabled === false");
          assert.equal(await evaluate("Array.from(document.querySelectorAll('.instance')[1].querySelectorAll('button')).find(button => button.textContent.trim() === 'Back up…').disabled"), false);
          assert.equal(await evaluate(button('Update to 1.4.2') + '.disabled'), false);
          await evaluate(button('Make current') + '.click()');
          await wait("document.querySelectorAll('.instance')[1].classList.contains('current')");
          assert.equal(await evaluate("Array.from(document.querySelectorAll('.instance')[1].querySelectorAll('button')).find(button => button.textContent.trim() === 'Stop').disabled"), true);
          await evaluate(button('Update to 1.4.2') + '.click()');
          await wait("document.querySelector('.operation-error[role=alert]')?.textContent.includes('bind: address already in use') && document.querySelectorAll('.instance-version strong')[1].textContent === 'Unknown'");
          assert.equal(await evaluate("getComputedStyle(document.querySelector('.operation-error')).backgroundColor"), 'rgb(255, 237, 237)');
          assert.equal(await evaluate("document.querySelector('.instances-status')"), null);
          await evaluate("document.querySelector('.operation-error button').click()");
          await wait("document.querySelector('#bug-description')");
          await evaluate("document.querySelector('.report-details summary').click()");
          assert.equal(await evaluate("document.querySelector('dialog').innerText.includes('even when the backend is offline')"), true);
          await evaluate("(() => { const input = document.querySelector('#bug-description'); input.value = 'Upgrade fails with a port conflict'; input.dispatchEvent(new Event('input', { bubbles: true })); })()");
          await evaluate(button('Send bug report') + '.click()');
          await wait("document.querySelector('dialog [role=alert]')?.textContent.includes('Report capture failed')");
          await evaluate(button('Send bug report') + '.click()');
          await wait(button('Done') + ' !== undefined');
          assert.deepEqual(await evaluate("window.__updatesTest.reports[1].failure.instance"), {
            port: 7719, name: 'Test', createdAt: '', mcpUrl: 'http://127.0.0.1:7719/mcp',
            container: 'working-memory-control-plane-7719', state: 'running', version: '1.4.0', updateAvailable: true,
          });
          assert.equal(await evaluate("window.__updatesTest.reports[1].failure.backendTarget.version"), '1.4.2');
          assert.equal(await evaluate("document.querySelector('dialog pre').textContent.includes('bind: address already in use')"), true);
          assert.equal(await evaluate("window.__updatesTest.sends.length"), 1);
          assert.equal(await evaluate("window.__updatesTest.sends[0].requestId === window.__updatesTest.preparations[0].requestId"), true);
          assert.equal(await evaluate("document.querySelector('dialog a')"), null);
          assert.equal(await evaluate("document.querySelector('dialog [role=status]').textContent.includes('Queued for the Feedback receiver')"), true);
          assert.equal(await evaluate("document.querySelector('dialog').innerText.includes('No topic was created')"), true);
          await evaluate(button('Done') + '.click()');
          await evaluate("window.__updatesTest.restoreUpgrade(); window.__updatesTest.advance()");
          await wait(button('Update to 1.4.2') + "?.disabled === false");
          await evaluate(button('Update to 1.4.2') + '.click()');
          await wait("window.__updatesTest.operations.includes('upgrade:7719') && " + button('Update to 1.4.2') + " === undefined");
          assert.equal(await evaluate("document.querySelector('.operation-error')"), null);
          assert.equal(await evaluate("document.querySelectorAll('.instance-version strong')[1].textContent"), '1.4.2');
          assert.equal(await evaluate("window.__updatesTest.changes"), 3);
          await evaluate(button('Container Provider') + '.click()');
          await wait("document.querySelector('.container-provider select') !== null");
          assert.equal(await evaluate("document.querySelector('.instance-list')"), null);
          await evaluate("(() => { const provider = document.querySelector('.container-provider select'); provider.value = 'podman'; provider.dispatchEvent(new Event('change', { bubbles: true })); })()");
          await wait("window.__updatesTest.providerChanges[0] === 'podman' && " + button('Retry') + "?.disabled === false");
          assert.equal(await evaluate("document.querySelector('.instances-note[role=alert]').textContent.includes('Podman is unavailable')"), true);
          await evaluate(button('Retry') + '.click()');
          await wait("!document.querySelector('.container-provider select').disabled");
          assert.equal(await evaluate("document.querySelector('.container-provider select').value"), 'podman');
          await evaluate(button('Front End') + '.click()');
          await wait("document.querySelector('.update-channels') && window.__updatesTest.frontendReads === 1");
          assert.equal(await evaluate("document.querySelector('.instances') === null"), true);
          const readsWhileAway = await evaluate("window.__updatesTest.backendReads");
          assert.equal(await evaluate("window.__updatesTest.polls.size"), 0);
          await evaluate("window.__updatesTest.advance()");
          assert.equal(await evaluate("window.__updatesTest.backendReads"), readsWhileAway);
          await evaluate("document.querySelector('input[name=desktop-update-channel][value=off]').click()");
          await wait("window.__updatesTest.frontendChannels[0] === 'off'");
          await evaluate("document.querySelector('input[name=desktop-update-channel][value=stable]').click()");
          await wait("document.querySelector('.update-status').textContent.includes('1.4.2')");
          await evaluate("window.__updatesTest.emit({ phase: 'downloading', progress: 0.25 })");
          await wait("document.querySelector('progress')?.value === 0.25");
          assert.equal(await evaluate("document.querySelector('input[name=desktop-update-channel]').disabled"), true);
          await evaluate("window.__updatesTest.emit({ phase: 'available', progress: null })");
          await evaluate(button('Check now') + '.click()');
          await wait("window.__updatesTest.frontendActions.includes('check')");
          await evaluate(button('Download 1.4.2') + '.click()');
          await wait(button('Restart and install') + ' !== undefined');
          await evaluate(button('Models') + '.click()');
          await wait("window.__updatesTest.unsubscriptions === 1");
          await evaluate(button('System') + '.click()');
          await wait("document.querySelector('[aria-label=System] [aria-selected=true]').textContent === 'Front End' && window.__updatesTest.frontendReads === 2");
          await evaluate("window.__updatesTest.openInstances()");
          await wait("document.querySelector('.instances') && window.__updatesTest.unsubscriptions === 2");
          assert.equal(await evaluate("document.querySelector('[aria-label=System] [aria-selected=true]').textContent"), 'Backend');
          assert.equal(await evaluate("document.querySelector('.backend-channel select').value"), 'canary');
          assert.equal(await evaluate("document.querySelectorAll('.instance-version strong')[1].textContent"), '1.4.2');
          assert.equal(await evaluate("window.__updatesTest.subscriptions"), 2);
          const readsBeforeDestroyedRefresh = await evaluate("window.__updatesTest.backendReads");
          await evaluate("window.__updatesTest.releaseRefresh = null; window.__updatesTest.holdRefresh = true; window.__updatesTest.advance()");
          await wait("window.__updatesTest.releaseRefresh !== null");
          await evaluate(button('Models') + '.click()');
          await wait("window.__updatesTest.polls.size === 0");
          await evaluate("window.__updatesTest.holdRefresh = false; window.__updatesTest.changeBackend({ backendChannel: 'stable', dockerError: null }); window.__updatesTest.advance()");
          await evaluate(button('System') + '.click()');
          await wait("window.__updatesTest.backendReads === " + (readsBeforeDestroyedRefresh + 2) + " && document.querySelector('.backend-channel select')?.value === 'stable'");
          await evaluate("window.__updatesTest.hidden = true; window.__updatesTest.advance(); window.__updatesTest.releaseRefresh(); new Promise(resolve => setTimeout(resolve, 0))");
          await evaluate(button('Models') + '.click()');
          await wait("window.__updatesTest.polls.size === 0");
          await evaluate(button('System') + '.click()');
          await wait("document.querySelector('.backend-channel select') !== null");
          assert.equal(await evaluate("document.querySelector('.backend-channel select').value"), 'stable');
          assert.equal(await evaluate("window.__updatesTest.backendReads"), readsBeforeDestroyedRefresh + 2);
          await evaluate("window.__updatesTest.hidden = false; document.dispatchEvent(new Event('visibilitychange'))");
          await wait("window.__updatesTest.backendReads === " + (readsBeforeDestroyedRefresh + 3));
          await evaluate("window.__updatesTest.changeBackend({ recoveryAvailable: true, dockerError: 'Ownership conflict' }); window.__updatesTest.advance()");
          await wait(button('Recover…') + "?.disabled === false");
          await evaluate(button('Recover…') + '.click()');
          await wait("window.__updatesTest.operations.includes('recover') && !document.querySelector('.instances-note[role=alert]')");
          assert.equal(await evaluate(button('Recover…') + ' === undefined'), true);
          await evaluate("window.__updatesTest.feedbackState = 'disconnected'; " + button('Feedback') + '.click()');
          await wait(button('Connect this computer') + "?.disabled === false");
          assert.equal(await evaluate("document.querySelector('section[aria-label^=Feedback] textarea')"), null);
          await evaluate(button('Connect this computer') + '.click()');
          await wait("document.querySelector('section[aria-label^=Feedback]').textContent.includes('ABCDEF123456')");
          assert.equal(await evaluate(button('Connect this computer') + '.disabled'), true);
          assert.equal(await evaluate("document.querySelector('section[aria-label^=Feedback]').textContent.includes('Approval pending')"), true);
          assert.equal(await evaluate("document.querySelector('section[aria-label^=Feedback]').textContent.includes('Feedback app > Device approvals')"), true);
          assert.equal(await evaluate("document.querySelector('section[aria-label^=Feedback]').textContent.includes('receiving Working Memory owner password')"), true);
          await evaluate("window.__updatesTest.feedbackState = 'connected'; " + button('Check approval') + '.click()');
          await wait("document.querySelector('section[aria-label^=Feedback] [role=status]').textContent.includes('Connected.')");
          await evaluate("window.__updatesTest.feedbackState = 'revoked'; " + button('Check approval') + '.click()');
          await wait("document.querySelector('section[aria-label^=Feedback]').textContent.includes('approval was revoked')");
          await evaluate(button('Connect this computer') + '.click()');
          await wait("document.querySelector('section[aria-label^=Feedback]').textContent.includes('Approval pending')");
          await evaluate("window.__updatesTest.failDisconnect = true; " + button('Disconnect and revoke') + '.click()');
          await wait("document.querySelector('section[aria-label^=Feedback] [role=alert]').textContent.includes('Revocation unavailable')");
          assert.equal(await evaluate("document.querySelector('section[aria-label^=Feedback]').textContent.includes('Approval pending')"), true);
          await evaluate("window.__updatesTest.failDisconnect = false; " + button('Disconnect and revoke') + '.click()');
          await wait(button('Connect this computer') + "?.disabled === false");
          assert.equal(await evaluate("document.querySelector('section[aria-label^=Feedback]').textContent.includes('no local-network delivery fallback')"), true);
          console.log('updates-settings-browser: subtabs, actions, selection and subscriptions passed');
          window.destroy(); app.exit(0);
        }).catch(error => { console.error(error); app.exit(1); });
      `);
      const { stdout } = await promisify(execFile)(executable, [script], {
        timeout: 25000, env: { ...process.env, ELECTRON_RUN_AS_NODE: '' },
      });
      expect(stdout).toContain('updates-settings-browser: subtabs, actions, selection and subscriptions passed');
    } finally { await server.close(); await rm(directory, { recursive: true, force: true }); }
  }, 30000,
);
