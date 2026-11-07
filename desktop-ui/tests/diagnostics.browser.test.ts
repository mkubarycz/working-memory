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
  'renders Diagnostics telemetry and keeps locally queued reports visible when the backend is unavailable',
  async () => {
    const executable: unknown = createRequire(import.meta.url)('electron');
    if (typeof executable !== 'string') throw new Error('Electron executable is unavailable.');
    const directory = await mkdtemp(join(tmpdir(), 'wm-diagnostics-browser-'));
    const fixture = `
      import { mount, unmount } from 'svelte';
      import { getInstanceByDom } from 'echarts/core';
      import '/src/renderer/style.css';
      import Settings from '/src/renderer/documents/SettingsView.svelte';
      import RelatedTopics from '/src/renderer/documents/RelatedTopics.svelte';
      const minute = Math.floor(Date.now() / 60000) * 60000;
      const queueAt = minute + 30000;
      const instance = {
        version: '1.4.1', startedAt: Date.now(), observedAt: Date.now(),
        runtime: { heapUsedBytes: 60 * 1048576, heapLimitBytes: 100 * 1048576, rssBytes: 80 * 1048576,
          eventLoopMaxMs: 1100, activeSessions: 2, activeRequests: 1, admissionBlocked: true },
        samples: [
          { at: minute - 10000, bootId: '00000000-0000-4000-8000-000000000002',
            heapUsedBytes: 100 * 1048576, heapLimitBytes: 200 * 1048576, rssBytes: 160 * 1048576,
            externalBytes: 40 * 1048576, arrayBufferBytes: 0, cpuPercent: 20,
            eventLoopMaxMs: 1100, gcCount: 4, gcDurationMs: 20, queueDepth: 8, runningTools: 4, operations: [] },
          { at: minute - 20000, bootId: '00000000-0000-4000-8000-000000000002',
            heapUsedBytes: 50 * 1048576, heapLimitBytes: 200 * 1048576, rssBytes: 80 * 1048576,
            externalBytes: 20 * 1048576, arrayBufferBytes: 0, cpuPercent: 80,
            eventLoopMaxMs: 550, gcCount: 2, gcDurationMs: 10, queueDepth: 4, runningTools: 2, operations: [] },
        ],
        minutes: [
          { at: minute, transactions: 42, errors: 3, averageMs: 100, maxMs: 3500 },
          { at: minute - 60000, transactions: 21, errors: 0, averageMs: 25, maxMs: 2000 },
        ],
        callers: [{ caller: 'client:approved-id', route: '/mcp', status: 503, transactions: 3 }],
        events: [{ sequence: 1, at: Date.now(), code: 'mcp_admission_rejected', route: '/mcp',
          status: 503, durationMs: 10, count: 3, requestId: 'correlated-request-id' }],
      };
      const requestId = '00000000-0000-4000-8000-000000000001';
      const completedId = '00000000-0000-4000-8000-000000000003';
      const completedAt = Date.now() - 1000;
      const state = window.__diagnosticsTest = { offline: false, calls: 0, queueCalls: 0, inspections: 0, queueGone: false, hidden: true, noRuntimeSamples: false, noToolHistory: false };
      state.chart = label => getInstanceByDom(document.querySelector('.diagnostics-time-series[aria-label="' + label + '"] .diagnostics-chart'));
      Object.defineProperty(document, 'hidden', { get: () => state.hidden });
      window.__setDiagnosticsVisible = visible => {
        state.hidden = !visible;
        document.dispatchEvent(new Event('visibilitychange'));
      };
      window.workingMemory = {
        async prepareResourceDrag() { return { filename: 'related.md', filePath: '/tmp/related.md', fileUrl: 'file:///tmp/related.md' }; },
        startResourceDrag(prepared) { state.nativeDrag = prepared; },
        onResourceDragResult(listener) { state.dragResult = listener; return () => { state.dragResult = null; }; },
        async openResource() {
          if (state.parentFailure) throw new Error(state.parentFailure);
          return { kind: 'topic', workstreams: state.parentWorkstreams || [{ id: 'one', title: 'One' }] };
        },
        async listSearchWorkstreams() {
          if (state.workstreamFailure) throw new Error(state.workstreamFailure);
          return [{ id: 'one', title: 'One' }, { id: 'two', title: 'Two' }];
        },
        async addSearchTopicToWorkstream(id, workstream) {
          if (state.membershipFailure) throw new Error(state.membershipFailure);
          state.addedTopic = { id, workstream };
        },
        async getInstanceFeatures() { return { hostTasks: false, search: true }; },
        async getRelatedTopics(id) {
          state.relatedReads = (state.relatedReads || 0) + 1;
          state.relatedRequestId = id;
          if (state.relatedFailure) throw new Error(state.relatedFailure);
          if (!state.embeddingEnabled) return { state: 'disabled', limited: false, results: [] };
          return { state: state.relatedPending ? 'pending' : 'ready', limited: false, results: [{
            id: 'related-topic', title: 'Connectivity recovery',
            excerpt: 'Restore **routing** and investigate dropped packets.\\n\\n- Check the gateway\\n- [Open the source](working-memory://open/topic/source-topic)\\n\\n<script>window.__unsafeExcerpt = true</script>',
            similarity: 0.8, alreadyLinked: true, evidence: 'semantic',
            confidence: { level: 'high', reason: 'Strong passage and document evidence agree.' },
          }, {
            id: 'keyword-topic', title: 'Unrelated keyword substitute', excerpt: 'Not a semantic match.',
            similarity: null, alreadyLinked: false, evidence: 'keyword',
          }] };
        },
        async getEmbeddingDashboard() {
          state.embeddingReads = (state.embeddingReads || 0) + 1;
          return { endpoint: 'http://127.0.0.1:7719/mcp', enabled: !!state.embeddingEnabled, paused: !!state.embeddingPaused,
            phase: state.embeddingPaused ? 'paused' : state.embeddingEnabled ? 'indexing' : 'disabled',
            model: 'minilm-l6-v2:1110a243:384:v1', downloadBytes: 0, downloadTotal: 90871461,
            backend: state.embeddingPaused ? null : 'OpenVINO / NPU', warning: null, error: state.embeddingFailure || null,
            rssBytes: state.embeddingPaused ? null : 512 * 1048576, lastInferenceMs: 42, lastSuccessAtMs: Date.now(),
            idleTimeoutMinutes: state.retention ?? null,
            stats: { total: 100, indexed: 80, pending: 20, limited: 1, vectorBytes: 123456, lastIndexedAt: Math.floor(Date.now() / 1000) },
          };
        },
        async setEmbeddingAction(action) {
          state.embeddingActions = [...(state.embeddingActions || []), action];
          if (action === 'enable' || action === 'resume' || action === 'retry') {
            state.embeddingEnabled = true; state.embeddingPaused = false; state.embeddingFailure = null;
          }
          if (action === 'pause') state.embeddingPaused = true;
          if (action === 'disable') state.embeddingEnabled = false;
          return this.getEmbeddingDashboard();
        },
        async setEmbeddingRetention(minutes) {
          if (state.retentionFailure) throw new Error('Retention save failed');
          state.retention = minutes;
          return this.getEmbeddingDashboard();
        },
        async getToolQueue() {
          state.queueCalls++;
          const settings = state.queueSettings ?? { maxConcurrency: 4, maxQueueSize: 16, queueTimeoutMs: 5000, heapDispatchPausePercent: 60 };
          return { endpoint: 'http://127.0.0.1:7719/mcp', error: null, snapshot: {
            bootId: '00000000-0000-4000-8000-000000000002', observedAt: queueAt,
            settings: state.noQueueSettings ? undefined : settings,
            limits: { running: settings.maxConcurrency, waiting: settings.maxQueueSize, waitMs: settings.queueTimeoutMs }, memoryBlocked: true,
            processing: { processedPerSecond: 2.5, processedLastMinute: 30, averageWaitMs: 12.5, averageRunMs: 40 },
            requestsByTool: state.noToolHistory ? undefined : { 'wm-document-query': 13, 'wm-document-read': 12 },
            timingsByTool: {
              'wm-document-query': { finished: 13, executed: 13, waitMs: 145, runMs: 320 },
              'wm-document-read': { finished: 12, executed: 12, waitMs: 24, runMs: 190 },
            },
            running: 0, waiting: state.queueGone ? 0 : 1,
            items: state.queueGone ? [] : [{ requestId, operation: 'wm-document-query', caller: 'owner', queuedAt: Date.now() - 1500 }],
            history: [{ at: queueAt - 10000, bootId: '00000000-0000-4000-8000-000000000002', queueDepth: 2, peakQueueDepth: 6,
              requestsByTool: state.noToolHistory ? undefined : { 'wm-document-query': 10, 'wm-document-read': 5 },
              timingsByTool: {
                'wm-document-query': { finished: 10, executed: 10, waitMs: 100, runMs: 200 },
                'wm-document-read': { finished: 5, executed: 5, waitMs: 10, runMs: 50 },
              },
              processing: { processedPerSecond: 1.25, processedLastMinute: 20, averageWaitMs: 10, averageRunMs: 30 } }],
            events: [
              { sequence: 5, at: Date.now(), requestId, operation: 'wm-document-query', caller: 'owner',
                event: 'queued', waiting: 1, running: 0, waitMs: 0, runMs: 0 },
              { sequence: 4, at: completedAt, requestId: completedId, operation: 'wm-document-read', caller: 'client:approved-id',
                event: 'completed', waiting: 0, running: 0, waitMs: 2, runMs: 32 },
              { sequence: 3, at: completedAt - 32, requestId: completedId, operation: 'wm-document-read', caller: 'client:approved-id',
                event: 'started', waiting: 0, running: 1, waitMs: 2, runMs: 0 },
              { sequence: 2, at: completedAt - 34, requestId: completedId, operation: 'wm-document-read', caller: 'client:approved-id',
                event: 'queued', waiting: 1, running: 0, waitMs: 0, runMs: 0 },
            ],
          } };
        },
        async updateToolQueueSettings(update, endpoint) {
          state.queueSettingsUpdates = [...(state.queueSettingsUpdates ?? []), { update, endpoint }];
          if (state.queueSettingsFailure) throw new Error('Queue settings save failed');
          state.queueSettings = update.settings;
          return (await this.getToolQueue()).snapshot;
        },
        async inspectQueuedRequest(id, endpoint) {
          state.inspections++;
          if (id !== requestId || endpoint !== 'http://127.0.0.1:7719/mcp') throw new Error('Wrong request scope');
          return { requestId, body: { jsonrpc: '2.0', id: 123, method: 'tools/call',
            params: { name: 'wm-document-query', arguments: { query: 'PRIVATE_LIVE_QUERY' } } } };
        },
        async getInstanceDiagnostics() {
          state.calls++;
          return { instance: state.offline ? null : { ...instance, samples: state.noRuntimeSamples ? undefined : instance.samples }, error: state.offline ? 'Backend unavailable' : null,
            incidents: [{ id: 'incident-id', at: Date.now(), kind: 'outage', evidence: 'Three health probes failed.',
              topicId: state.offline ? null : 'topic-id', deliveryError: state.offline ? 'Waiting for recovery' : null }] };
        },
      };
      const target = document.createElement('main'); document.body.append(target);
      state.mountRelated = () => {
        const relatedTarget = document.createElement('div'); document.body.append(relatedTarget);
        const component = mount(RelatedTopics, { target: relatedTarget, props: {
          id: 'source-topic', resourceVersion: 1, onOpenTopic: id => { state.openedTopic = id; },
          onAddChild: async (parent, workstream) => { state.childRequest = { parent, workstream }; },
        } });
        state.disposeRelated = async () => { await unmount(component); relatedTarget.remove(); };
      };
      mount(Settings, { target, props: {
        profiles: [], routing: {}, humanName: 'Test', credentialStorage: 'secure', settingsStatus: '', saving: false,
        testingProfileId: null, onHumanName() {}, onAddProfile() {}, onRemoveProfile() {},
        async onTestProfile() {}, onChange() {}, onFlush() {}, selectedMcpUrl: 'http://127.0.0.1:7719/mcp',
        async onMakeCurrent() {}, async onInstancesChanged() {}, onFeaturesChanged() {}, tab: 'diagnostics',
      } });
    `;
    const server = await createServer({
      configFile: false, root: fileURLToPath(new URL('..', import.meta.url)), cacheDir: join(directory, 'vite-cache'),
      resolve: { dedupe: ['svelte', 'zod', 'echarts'] },
      optimizeDeps: { include: ['svelte', 'zod', 'markdown-it', 'echarts/core', 'echarts/charts', 'echarts/components', 'echarts/renderers'] },
      plugins: [svelte(), {
        name: 'diagnostics-fixture',
        resolveId: id => id === '/diagnostics-fixture.js' ? '\0diagnostics-fixture' : undefined,
        load: id => id === '\0diagnostics-fixture' ? fixture : undefined,
        configureServer(server) {
          server.middlewares.use((req, res, next) => {
            if (req.url !== '/diagnostics-test.html') { next(); return; }
            res.setHeader('content-type', 'text/html');
            res.end('<!doctype html><html><body><script type="module" src="/diagnostics-fixture.js"></script></body></html>');
          });
        },
      }],
      server: { host: '127.0.0.1', port: 0, fs: { allow: [fileURLToPath(new URL('../..', import.meta.url))] } },
      appType: 'custom',
    });
    try {
      await server.listen();
      const address = server.httpServer?.address();
      if (!address || typeof address === 'string') throw new Error('Browser fixture did not bind.');
      const script = join(directory, 'diagnostics-test.cjs');
      await writeFile(script, `
        const { app, BrowserWindow } = require('electron');
        const assert = require('node:assert/strict');
        app.setPath('userData', ${JSON.stringify(join(directory, 'profile'))});
        app.whenReady().then(async () => {
          const window = new BrowserWindow({ show: false, width: 1200, height: 1600, webPreferences: { contextIsolation: true } });
          window.webContents.on('console-message', event => { if (event.level === 'error') console.error(event.message); });
          const evaluate = async code => {
            try { return await window.webContents.executeJavaScript(code); }
            catch (error) { throw new Error('Evaluating ' + code + ': ' + error.message
              + '\\n' + await window.webContents.executeJavaScript('document.body.innerText')); }
          };
          async function wait(code) {
            const deadline = Date.now() + 7000;
            while (Date.now() < deadline) {
              if (await evaluate(code)) return;
              await new Promise(resolve => setTimeout(resolve, 20));
            }
            throw new Error('Timed out: ' + code + '\\n' + await evaluate('document.body.innerText'));
          }
          await window.loadURL('http://127.0.0.1:${address.port}/diagnostics-test.html');
          await wait("document.body.innerText.includes('MCP tool queue')");
          assert.equal(await evaluate("document.querySelector('[aria-label=\\"Refresh interval\\"]').value"), '15000');
          assert.equal(await evaluate("window.__diagnosticsTest.queueCalls"), 0);
          await evaluate("window.__setDiagnosticsVisible(true)");
          await wait("document.body.innerText.includes('1 waiting / 16')");
          assert.equal((await evaluate('document.body.innerText')).includes('Live list refreshes'), false);
          assert.equal((await evaluate('document.body.innerText')).includes('Depth history is sampled'), false);
          assert.ok((await evaluate('document.body.innerText')).includes('Queue Processing'));
          assert.equal(await evaluate("document.querySelector('[aria-label=\\"Queue bucket size\\"]').value"), '60000');
          assert.ok(await evaluate("Boolean(document.querySelector('[aria-label=\\"Refresh interval\\"]').closest('.chart-controls'))"));
          assert.ok(await evaluate("document.querySelector('.chart-controls').getBoundingClientRect().bottom <= document.querySelector('[aria-label=\\"Queue processing history\\"] .diagnostics-chart').getBoundingClientRect().top"));
          assert.ok(await evaluate("document.querySelector('.chart-controls').getBoundingClientRect().right > document.querySelector('.graph-header h4').getBoundingClientRect().right"));
          assert.deepEqual(await evaluate("['Max Concurrency','Max Queue Size','Queue Timeout','Heap Dispatch Pause Threshold'].map(label=>document.querySelector('input[aria-label=\\"'+label+'\\"]').value)"), ['4','16','5','60']);
          assert.ok(!(await evaluate('document.body.innerText')).includes('One-minute buckets'));
          assert.ok(!(await evaluate('document.body.innerText')).includes('without smoothing'));
          await wait("window.__diagnosticsTest.chart('Queue processing history')?.getOption().series.length === 3");
          assert.deepEqual(await evaluate("window.__diagnosticsTest.chart('Queue processing history').getOption().series[2].data.map(point => point[1])"), [100]);
          assert.equal(await evaluate("window.__diagnosticsTest.chart('Queue processing history').getOption().xAxis[0].max - window.__diagnosticsTest.chart('Queue processing history').getOption().xAxis[0].min"), 60000);
          await wait("window.__diagnosticsTest.chart('Tool request history')?.getOption().series.length === 4");
          assert.ok(!(await evaluate("document.querySelector('[aria-label=\\"Queue processing history\\"] svg').textContent")).includes('%'));
          assert.deepEqual(await evaluate("Array.from(document.querySelectorAll('details summary')).map(item=>item.textContent)"),
            ['Top 50 by wait time', 'Top 50 by runtime', 'Queue log']);
          assert.ok(await evaluate("Array.from(document.querySelectorAll('details')).every(item=>!item.open)"));
          assert.equal(await evaluate("document.querySelector('[aria-label=\\"Queue request log\\"]')"), null);
          await evaluate("(() => { const select = document.querySelector('[aria-label=\\"Queue bucket size\\"]'); select.value = '120000'; select.dispatchEvent(new Event('change', { bubbles: true })); })()");
          await wait("['Queue processing history','Tool request history'].every(label=>window.__diagnosticsTest.chart(label).getOption().xAxis[0].minInterval===120000)");
          assert.equal(await evaluate("window.__diagnosticsTest.chart('Queue processing history').getOption().xAxis[0].max - window.__diagnosticsTest.chart('Queue processing history').getOption().xAxis[0].min"), 120000);
          await evaluate("(() => { const select = document.querySelector('[aria-label=\\"Queue bucket size\\"]'); select.value = '60000'; select.dispatchEvent(new Event('change', { bubbles: true })); })()");
          await wait("window.__diagnosticsTest.chart('Tool request history').getOption().xAxis[0].minInterval===60000");
          if (process.env.WM_DIAGNOSTICS_SCREENSHOT) {
            require('node:fs').writeFileSync(process.env.WM_DIAGNOSTICS_SCREENSHOT, (await window.webContents.capturePage()).toPNG());
          }
          assert.equal((await evaluate('document.body.innerText')).includes('Live requests'), false);
          assert.deepEqual(await evaluate("window.__diagnosticsTest.chart('Tool request history').getOption().series.map(series => series.data[0][1])"), [3, 7, 100, 100]);
          assert.deepEqual(await evaluate("['Queue processing history', 'Tool request history'].map(label => { const chart = window.__diagnosticsTest.chart(label); return chart.convertToPixel({xAxisIndex: 0}, chart.getOption().xAxis[0].min); })"),
            [64, 64], 'Both plots must start at the same horizontal pixel');
          const originalWidth = await evaluate("window.__diagnosticsTest.chart('Queue processing history').getWidth()");
          window.setSize(650, 1000);
          await wait("window.__diagnosticsTest.chart('Queue processing history').getWidth() < " + originalWidth);
          const matchesContainer = "['Queue processing history', 'Tool request history'].every(label => { const element = document.querySelector('.diagnostics-time-series[aria-label=\\"' + label + '\\"] .diagnostics-chart'); return window.__diagnosticsTest.chart(label).getWidth() === element.clientWidth && Number(element.querySelector('svg').getAttribute('width')) === element.clientWidth; })";
          await wait(matchesContainer);
          const windowWidth = await evaluate("window.__diagnosticsTest.chart('Queue processing history').getWidth()");
          await evaluate("document.querySelector('main').style.width = '420px'");
          await wait("window.__diagnosticsTest.chart('Queue processing history').getWidth() < " + windowWidth);
          await wait(matchesContainer);
          await evaluate("document.querySelector('main').style.width = ''");
          window.setSize(1200, 1600);
          await wait("window.__diagnosticsTest.chart('Queue processing history').getWidth() === " + originalWidth);
          await wait(matchesContainer);
          await evaluate("window.__diagnosticsTest.chart('Queue processing history').dispatchAction({type:'showTip',seriesIndex:0,dataIndex:0})");
          await wait("document.body.innerText.includes('Average queue depth: 1.5 waiting')");
          await evaluate("window.__diagnosticsTest.chart('Tool request history').dispatchAction({type:'showTip',seriesIndex:0,dataIndex:0})");
          await wait("document.body.innerText.includes('wm-document-query: 3 requests')");
          await wait("document.body.innerText.includes('Total wait time: 59 ms') && document.body.innerText.includes('Average runtime: 26 ms')");
          await evaluate("document.querySelector('[aria-label=\\"Tool request history\\"] .chart-legend button').click()");
          await wait("window.__diagnosticsTest.chart('Tool request history').getOption().series.length === 3");
          assert.equal(await evaluate("document.querySelector('[aria-label=\\"Tool request history\\"] .chart-legend button').getAttribute('aria-pressed')"), 'true');
          await evaluate("window.__diagnosticsTest.chart('Tool request history').dispatchAction({type:'showTip',seriesIndex:0,dataIndex:0})");
          await wait("document.body.innerText.includes('Total wait time: 45 ms') && document.body.innerText.includes('Average runtime: 40 ms')");
          await evaluate("document.querySelector('[aria-label=\\"Tool request history\\"] .chart-legend button').click()");
          await wait("window.__diagnosticsTest.chart('Tool request history').getOption().series.length === 4");
          await evaluate("document.querySelector('[aria-label=\\"Queue processing history\\"] .chart-legend button').click()");
          await wait("window.__diagnosticsTest.chart('Queue processing history').getOption().series.length === 1");
          const defaultCalls = await evaluate("window.__diagnosticsTest.queueCalls");
          await new Promise(resolve => setTimeout(resolve, 2200));
          assert.equal(await evaluate("window.__diagnosticsTest.queueCalls"), defaultCalls);
          await evaluate("(() => { const select = document.querySelector('[aria-label=\\"Refresh interval\\"]'); select.value = '2000'; select.dispatchEvent(new Event('change', { bubbles: true })); })()");
          await wait("window.__diagnosticsTest.queueCalls > " + defaultCalls);
          const fastCalls = await evaluate("window.__diagnosticsTest.queueCalls");
          await new Promise(resolve => setTimeout(resolve, 2200));
          assert.ok(await evaluate("window.__diagnosticsTest.queueCalls") > fastCalls);
          assert.equal(await evaluate("window.__diagnosticsTest.chart('Queue processing history').getOption().series.length"), 1, 'Selection must survive refresh');
          await evaluate("Array.from(document.querySelectorAll('[aria-label=\\"Queue processing history\\"] .chart-legend button')).find(button => button.textContent === 'Show all').click()");
          await wait("window.__diagnosticsTest.chart('Queue processing history').getOption().series.length === 3");
          await evaluate("Array.from(document.querySelectorAll('summary')).find(item=>item.textContent==='Top 50 by wait time').click()");
          await wait("Boolean(document.querySelector('[aria-label=\\"Top 50 by wait time\\"]'))");
          assert.ok(await evaluate("(() => { const values=Array.from(document.querySelectorAll('[aria-label=\\"Top 50 by wait time\\"] tbody tr')).map(row=>Number(row.cells[4].textContent));return values.every((value,index)=>index===0||value<=values[index-1]); })()"));
          await evaluate("Array.from(document.querySelectorAll('summary')).find(item=>item.textContent==='Top 50 by runtime').click()");
          await wait("Boolean(document.querySelector('[aria-label=\\"Top 50 by runtime\\"]'))");
          assert.equal(await evaluate("document.querySelector('[aria-label=\\"Top 50 by runtime\\"] tbody tr').cells[5].textContent"), '32');
          await evaluate("Array.from(document.querySelectorAll('summary')).find(item=>item.textContent==='Queue log').click()");
          await wait("Boolean(document.querySelector('[aria-label=\\"Queue request log\\"]'))");
          assert.deepEqual(await evaluate("Array.from(document.querySelectorAll('[aria-label=\\"Queue request log\\"] th')).map(c => c.textContent)"),
            ['Time', 'Duration ms', 'Request ID', 'Tool', 'Wait time ms', 'Runtime ms', 'Status']);
          assert.equal(await evaluate("document.querySelectorAll('[aria-label=\\"Queue request log\\"] tbody tr').length"), 2);
          const completedCells = await evaluate("Array.from(document.querySelectorAll('[aria-label=\\"Queue request log\\"] tbody tr')).find(r => r.textContent.includes('00000000-0000-4000-8000-000000000003')).querySelectorAll('td').length");
          assert.equal(completedCells, 7);
          assert.deepEqual(await evaluate("Array.from(Array.from(document.querySelectorAll('[aria-label=\\"Queue request log\\"] tbody tr')).find(r => r.textContent.includes('00000000-0000-4000-8000-000000000003')).querySelectorAll('td')).slice(1).map(c => c.textContent)"),
            ['34', '00000000-0000-4000-8000-000000000003', 'wm-document-read', '2', '32', 'Completed']);
          assert.equal(await evaluate("Array.from(document.querySelectorAll('[aria-label=\\"Queue request log\\"] td')).find(c => c.textContent === '00000000-0000-4000-8000-000000000003').title"), 'Caller: client:approved-id');
          await evaluate("['Max Concurrency','Max Queue Size','Queue Timeout','Heap Dispatch Pause Threshold'].forEach((label,index)=>{const input=document.querySelector('input[aria-label=\\"'+label+'\\"]');input.value=['2','8','12','55'][index];input.dispatchEvent(new Event('input',{bubbles:true}));})");
          await evaluate("Array.from(document.querySelectorAll('button')).find(button=>button.textContent==='Save Queue settings').click()");
          await wait("document.body.innerText.includes('Queue settings saved.')");
          assert.deepEqual(await evaluate("window.__diagnosticsTest.queueSettingsUpdates.at(-1)"), {
            endpoint:'http://127.0.0.1:7719/mcp',
            update:{expectedBootId:'00000000-0000-4000-8000-000000000002',
              expectedSettings:{maxConcurrency:4,maxQueueSize:16,queueTimeoutMs:5000,heapDispatchPausePercent:60},
              settings:{maxConcurrency:2,maxQueueSize:8,queueTimeoutMs:12000,heapDispatchPausePercent:55}},
          });
          await evaluate("window.__diagnosticsTest.queueSettingsFailure=true;(()=>{const input=document.querySelector('input[aria-label=\\"Max Concurrency\\"]');input.value='3';input.dispatchEvent(new Event('input',{bubbles:true}));})()");
          await evaluate("Array.from(document.querySelectorAll('button')).find(button=>button.textContent==='Save Queue settings').click()");
          await wait("document.body.innerText.includes('Queue settings save failed')");
          assert.equal(await evaluate("window.__diagnosticsTest.queueSettings.maxConcurrency"),2);
          assert.equal(await evaluate("document.querySelector('input[aria-label=\\"Max Concurrency\\"]').value"),'3');
          await evaluate("window.__diagnosticsTest.queueSettingsFailure=false;Array.from(document.querySelectorAll('button')).find(button=>button.textContent==='Discard changes').click()");
          assert.equal(await evaluate("document.querySelector('input[aria-label=\\"Max Concurrency\\"]').value"),'2');
          await evaluate("document.querySelector('#diagnostics-tab-http').click()");
          await wait("document.body.innerText.includes('correlated-request-id')");
          await evaluate("document.querySelector('#diagnostics-tab-queue').click()");
          await wait("document.querySelector('input[aria-label=\\"Max Concurrency\\"]')?.value==='2'");
          await evaluate("['Max Concurrency','Max Queue Size','Queue Timeout','Heap Dispatch Pause Threshold'].forEach((label,index)=>{const input=document.querySelector('input[aria-label=\\"'+label+'\\"]');input.value=['4','16','5','60'][index];input.dispatchEvent(new Event('input',{bubbles:true}));})");
          await evaluate("Array.from(document.querySelectorAll('button')).find(button=>button.textContent==='Save Queue settings').click()");
          await wait("document.body.innerText.includes('Queue settings saved.')");
          assert.equal(await evaluate("document.querySelector('[aria-label=\\"Diagnostics sections\\"] [aria-selected=true]').textContent"), 'Queue');
          assert.equal(await evaluate("getComputedStyle(document.querySelector('#diagnostics-tab-queue')).backgroundColor"), 'rgba(0, 0, 0, 0)');
          const pink = await evaluate("(() => { const marker = document.createElement('span'); marker.style.color = 'var(--desktop-accent-strong)'; document.body.append(marker); const color = getComputedStyle(marker).color; marker.remove(); return color; })()");
          assert.ok((await evaluate("Array.from(document.querySelectorAll('[aria-label=\\"Diagnostics sections\\"] button')).map(b => getComputedStyle(b).color)")).every(color => color === pink));
          assert.ok(await evaluate("document.querySelector('[aria-label=\\"Settings\\"]').getBoundingClientRect().bottom <= document.querySelector('[aria-label=\\"Diagnostics sections\\"]').getBoundingClientRect().top"));
          assert.equal(await evaluate("Array.from(document.querySelectorAll('button')).some(b => /refresh/i.test(b.textContent))"), false);
          assert.equal(await evaluate("document.querySelectorAll('[aria-label=\\"Diagnostics sections\\"] [tabindex=\\"0\\"]').length"), 1);
          await evaluate("document.querySelector('#diagnostics-tab-queue').dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }))");
          await wait("document.body.innerText.includes('correlated-request-id')");
          assert.equal(await evaluate("document.activeElement.id"), 'diagnostics-tab-http');
          await evaluate("document.querySelector('#diagnostics-tab-http').dispatchEvent(new KeyboardEvent('keydown', { key: 'Home', bubbles: true }))");
          await wait("document.body.innerText.includes('1 waiting / 16')");
          assert.equal(await evaluate("document.activeElement.id"), 'diagnostics-tab-queue');
          assert.equal((await evaluate('document.body.innerText')).includes('PRIVATE_LIVE_QUERY'), false);
          assert.equal(await evaluate("window.__diagnosticsTest.inspections"), 0);
          await evaluate("window.__diagnosticsTest.queueGone = true; window.__setDiagnosticsVisible(false)");
          const hiddenQueueCalls = await evaluate("window.__diagnosticsTest.queueCalls");
          await new Promise(resolve => setTimeout(resolve, 2200));
          assert.equal(await evaluate("window.__diagnosticsTest.queueCalls"), hiddenQueueCalls);
          await evaluate("window.__setDiagnosticsVisible(true)");
          await wait("document.body.innerText.includes('0 waiting / 16')");
          await evaluate("window.__diagnosticsTest.chart('Queue processing history').dispatchAction({type:'showTip',seriesIndex:0,dataIndex:0})");
          await wait("document.body.innerText.includes('Average queue depth: 1 waiting')");
          assert.equal((await evaluate('document.body.innerText')).includes('PRIVATE_LIVE_QUERY'), false);
          assert.deepEqual(await evaluate("Array.from(document.querySelectorAll('[aria-label=\\"Diagnostics sections\\"] button')).map(b => b.textContent.trim())"),
            ['Queue', 'HTTP', 'Runtime', 'Automatic incident reports', 'Embeddings']);
          await evaluate("document.querySelector('#diagnostics-tab-runtime').click()");
          await wait("window.__diagnosticsTest.chart('Normalized runtime time series')?.getOption().series.length === 9");
          assert.equal(await evaluate("document.querySelector('[aria-label=\\"Refresh interval\\"]').value"), '2000');
          const inactiveQueueCalls = await evaluate("window.__diagnosticsTest.queueCalls");
          assert.equal(await evaluate("document.querySelector('[role=tab][aria-selected=true]').textContent"), 'Diagnostics');
          assert.equal(await evaluate("document.querySelectorAll('table').length"), 0);
          const runtimeText = await evaluate('document.body.innerText');
          for (const value of ['60.0 MiB', '1100 ms', '60% heap safety cutoff']) {
            assert.ok(runtimeText.includes(value), value + ' missing');
          }
          assert.equal(runtimeText.includes('correlated-request-id'), false);
          assert.equal(runtimeText.includes('Three health probes failed.'), false);
          assert.deepEqual(await evaluate("window.__diagnosticsTest.chart('Normalized runtime time series').getOption().series[0].data.map(point => point[1])"), [100]);
          assert.deepEqual(await evaluate("window.__diagnosticsTest.chart('Normalized runtime time series').getOption().series[3].data.map(point => point[1])"), [100]);
          await evaluate("document.querySelector('[aria-label=\\"Normalized runtime time series\\"] .chart-legend button').click()");
          await wait("window.__diagnosticsTest.chart('Normalized runtime time series').getOption().series.length === 1");
          await evaluate("document.querySelector('[aria-label=\\"Normalized runtime time series\\"] .chart-legend button').click()");
          await wait("window.__diagnosticsTest.chart('Normalized runtime time series').getOption().series.length === 9");
          for (const value of ['peak 75 MiB', 'peak 50 %', 'peak 6 /min', 'peak 6 tools']) {
            assert.ok(runtimeText.includes(value), value + ' missing');
          }
          await evaluate("window.__diagnosticsTest.noRuntimeSamples = true; window.__setDiagnosticsVisible(false); window.__setDiagnosticsVisible(true)");
          await wait("document.body.innerText.includes('No runtime samples are available for this environment.')");
          assert.equal(await evaluate("document.querySelector('.diagnostics-chart').style.display"), 'none');
          await evaluate("window.__diagnosticsTest.noRuntimeSamples = false");
          await evaluate("Array.from(document.querySelectorAll('[role=tab]')).find(b => b.textContent.trim() === 'HTTP').click()");
          await wait("document.body.innerText.includes('correlated-request-id')");
          await wait("window.__diagnosticsTest.chart('Normalized HTTP time series')?.getOption().series.length === 4");
          assert.deepEqual(await evaluate("window.__diagnosticsTest.chart('Normalized HTTP time series').getOption().series[0].data.map(point => point[1])"), [50, 100]);
          await evaluate("window.__diagnosticsTest.chart('Normalized HTTP time series').dispatchAction({type:'showTip',seriesIndex:0,dataIndex:1})");
          await wait("document.body.innerText.includes('Transactions: 42 /min')");
          await evaluate("document.querySelector('[aria-label=\\"Normalized HTTP time series\\"] .chart-legend button').click()");
          await wait("window.__diagnosticsTest.chart('Normalized HTTP time series').getOption().series.length === 1");
          await evaluate("Array.from(document.querySelectorAll('[aria-label=\\"Normalized HTTP time series\\"] .chart-legend button')).find(button => button.textContent === 'Show all').click()");
          await wait("window.__diagnosticsTest.chart('Normalized HTTP time series').getOption().series.length === 4");
          assert.equal(await evaluate("document.querySelectorAll('table').length"), 1);
          assert.equal(await evaluate("document.querySelector('table th').textContent"), 'Time');
          assert.ok(await evaluate("Boolean(document.querySelector('.diagnostics-chart').compareDocumentPosition(document.querySelector('table')) & Node.DOCUMENT_POSITION_FOLLOWING)"));
          await evaluate("document.querySelector('details').open = true");
          const httpText = await evaluate('document.body.innerText');
          const maximum = await evaluate("(3500).toLocaleString()");
          for (const value of ['peak 42 /min', 'peak 3 /min', 'peak 100 ms', 'peak ' + maximum + ' ms', '503', 'client:approved-id']) {
            assert.ok(httpText.includes(value), value + ' missing');
          }
          assert.equal(httpText.includes('Three health probes failed.'), false);
          await evaluate("Array.from(document.querySelectorAll('[role=tab]')).find(b => b.textContent.trim() === 'Automatic incident reports').click()");
          await wait("document.body.innerText.includes('Three health probes failed.')");
          assert.equal(await evaluate("document.querySelectorAll('table').length"), 0);
          assert.equal(await evaluate("document.querySelectorAll('svg').length"), 0);
          assert.equal(await evaluate("document.querySelector('a').getAttribute('href')"), 'working-memory://open/topic/topic-id');
          assert.equal(await evaluate("Array.from(document.querySelectorAll('button')).some(b => b.textContent.trim() === 'Save')"), false);
          await evaluate("window.__diagnosticsTest.offline = true; window.__setDiagnosticsVisible(false)");
          const hiddenHttpCalls = await evaluate("window.__diagnosticsTest.calls");
          await new Promise(resolve => setTimeout(resolve, 100));
          assert.equal(await evaluate("window.__diagnosticsTest.calls"), hiddenHttpCalls);
          await evaluate("window.__setDiagnosticsVisible(true)");
          await wait("document.body.innerText.includes('Queued for Inbox')");
          assert.equal(await evaluate("document.querySelector('[role=alert]').textContent"), 'Backend unavailable');
          assert.equal(await evaluate("document.querySelectorAll('table').length"), 0);
          assert.ok((await evaluate('document.body.innerText')).includes('Waiting for recovery'));
          assert.equal(await evaluate("window.__diagnosticsTest.queueCalls"), inactiveQueueCalls);
          await evaluate("Array.from(document.querySelectorAll('[role=tab]')).find(b => b.textContent.trim() === 'Queue').click()");
          await wait("document.body.innerText.includes('0 waiting / 16')");
          await evaluate("window.__diagnosticsTest.noToolHistory = true; window.__setDiagnosticsVisible(false); window.__setDiagnosticsVisible(true)");
          await wait("document.body.innerText.includes('Tool-request history is unavailable on this backend.')");
          await evaluate("document.querySelector('#diagnostics-tab-embeddings').click()");
          await wait("document.body.innerText.includes('Enable Embeddings in Settings > Features')");
          assert.ok((await evaluate('document.body.innerText')).includes('80 / 100 indexed; 20 pending'));
          assert.ok((await evaluate('document.body.innerText')).includes('OpenVINO / NPU'));
          assert.ok((await evaluate('document.body.innerText')).includes('32,000-character'));
          assert.equal(await evaluate("document.querySelectorAll('.diagnostics-chart').length"), 0);
          assert.equal(await evaluate("Array.from(document.querySelectorAll('button')).some(b => ['Enable and install model', 'Disable'].includes(b.textContent.trim()))"), false);
          await evaluate("Array.from(document.querySelectorAll('[role=tab]')).find(b => b.textContent.trim() === 'Features').click()");
          await wait("document.querySelector('[aria-label=Embeddings]') && !document.querySelector('[aria-label=Embeddings]').disabled");
          await evaluate("document.querySelector('[aria-label=Embeddings]').click()");
          await wait("window.__diagnosticsTest.embeddingEnabled && !document.querySelector('[aria-label=Embeddings]').disabled");
          await evaluate("Array.from(document.querySelectorAll('[role=tab]')).find(b => b.textContent.trim() === 'Diagnostics').click()");
          await evaluate("document.querySelector('#diagnostics-tab-embeddings').click()");
          await wait("document.body.innerText.includes('Status: indexing')");
          assert.equal(await evaluate("document.querySelector('.embeddings-dashboard select').value"), 'always');
          assert.ok((await evaluate('document.body.innerText')).includes('1.1 GiB'));
          await evaluate("(()=>{const s=document.querySelector('.embeddings-dashboard select');s.value='30';s.dispatchEvent(new Event('change',{bubbles:true}));})()");
          await wait("window.__diagnosticsTest.retention === 30");
          await evaluate("window.__setDiagnosticsVisible(false); window.__setDiagnosticsVisible(true)");
          await wait("document.querySelector('.embeddings-dashboard select').value === '30'");
          await evaluate("window.__diagnosticsTest.retentionFailure=true;(()=>{const s=document.querySelector('.embeddings-dashboard select');s.value='1';s.dispatchEvent(new Event('change',{bubbles:true}));})()");
          await wait("document.body.innerText.includes('Retention save failed')");
          assert.equal(await evaluate("document.querySelector('.embeddings-dashboard select').value"), '30');
          await evaluate("window.__diagnosticsTest.retentionFailure=false");
          await evaluate("Array.from(document.querySelectorAll('button')).find(b => b.textContent.trim() === 'Pause').click()");
          await wait("document.body.innerText.includes('Status: paused')");
          assert.ok((await evaluate('document.body.innerText')).includes('Not loaded'));
          await evaluate("window.__diagnosticsTest.embeddingFailure = 'Intel NPU driver unavailable'; window.__setDiagnosticsVisible(false); window.__setDiagnosticsVisible(true)");
          await wait("document.body.innerText.includes('Intel NPU driver unavailable')");
          await evaluate("Array.from(document.querySelectorAll('button')).find(b => b.textContent.trim() === 'Retry').click()");
          await wait("!document.body.innerText.includes('Intel NPU driver unavailable')");
          assert.deepEqual(await evaluate("window.__diagnosticsTest.embeddingActions"), ['enable', 'pause', 'retry']);
          await evaluate("window.__setDiagnosticsVisible(false)");
          const hiddenEmbeddingReads = await evaluate("window.__diagnosticsTest.embeddingReads");
          await new Promise(resolve => setTimeout(resolve, 2200));
          assert.equal(await evaluate("window.__diagnosticsTest.embeddingReads"), hiddenEmbeddingReads);
          await evaluate("window.__setDiagnosticsVisible(true)");
          await evaluate("Array.from(document.querySelectorAll('[role=tab]')).find(b => b.textContent.trim() === 'Models').click()");
          await wait("document.body.innerText.includes('Routing matrix')");
          const stoppedCounts = await evaluate("[window.__diagnosticsTest.calls, window.__diagnosticsTest.queueCalls]");
          await evaluate("window.__setDiagnosticsVisible(false); window.__setDiagnosticsVisible(true)");
          await new Promise(resolve => setTimeout(resolve, 2200));
          assert.deepEqual(await evaluate("[window.__diagnosticsTest.calls, window.__diagnosticsTest.queueCalls]"), stoppedCounts);
          await evaluate("window.__diagnosticsTest.embeddingEnabled = false; window.__diagnosticsTest.mountRelated()");
          await wait("window.__diagnosticsTest.relatedReads > 0");
          assert.equal(await evaluate("document.querySelector('.related-topics')"), null);
          await evaluate("window.__diagnosticsTest.disposeRelated()");
          await evaluate("window.__diagnosticsTest.embeddingEnabled = true; window.__diagnosticsTest.relatedPending = true; window.__diagnosticsTest.mountRelated()");
          await wait("document.querySelector('.related-topics')?.innerText.includes('waiting for indexing')");
          assert.equal(await evaluate("document.querySelectorAll('.related-topics article').length"), 0);
          assert.equal((await evaluate("document.querySelector('.related-topics').innerText")).includes('No related topics found'), false);
          assert.ok((await evaluate("document.querySelector('.related-topics').innerText")).includes('Settings > Diagnostics > Embeddings'));
          await evaluate("window.__diagnosticsTest.disposeRelated()");
          await evaluate("window.__diagnosticsTest.relatedPending = false");
          await evaluate("window.__diagnosticsTest.mountRelated()");
          await wait("document.querySelector('.related-topics')?.innerText.includes('Connectivity recovery')");
          assert.equal(await evaluate("window.__diagnosticsTest.relatedRequestId"), 'source-topic');
          assert.equal(await evaluate("document.querySelectorAll('.related-topics article').length"), 1);
          assert.equal((await evaluate("document.querySelector('.related-topics').innerText")).includes('Unrelated keyword substitute'), false);
          assert.ok((await evaluate("document.querySelector('.related-topics').innerText")).includes('Already linked'));
          assert.equal((await evaluate("document.querySelector('.related-topics').innerText")).includes('Suggestions, not authored relationships'), false);
          assert.equal((await evaluate("document.querySelector('.related-topics').innerText")).includes('Meaning'), false);
          assert.equal(await evaluate("document.querySelector('.related-topics .relevance').textContent.trim()"), 'Relevance 0.80');
          assert.equal(await evaluate("document.querySelector('.related-topics .confidence').textContent.trim()"), 'Confidence High');
          assert.ok((await evaluate("document.querySelector('.related-topics .confidence').title")).includes('not a calibrated probability'));
          assert.ok((await evaluate("document.querySelector('.related-topics .relevance').title")).includes('not a confidence percentage'));
          assert.equal(await evaluate("document.querySelector('.related-topics .twistie').getAttribute('aria-expanded')"), 'false');
          assert.equal(await evaluate("document.querySelector('.related-topics .excerpt')"), null);
          if (process.env.WM_RELATED_TOPICS_SCREENSHOT) {
            await evaluate("document.querySelector('.related-topics').scrollIntoView()");
            require('node:fs').writeFileSync(process.env.WM_RELATED_TOPICS_SCREENSHOT, (await window.webContents.capturePage()).toPNG());
          }
          await evaluate("document.querySelector('.related-topics .twistie').click()");
          await wait("document.querySelector('.related-topics blockquote.excerpt strong')?.textContent === 'routing'");
          assert.equal(await evaluate("document.querySelector('.related-topics .twistie').getAttribute('aria-expanded')"), 'true');
          assert.equal(await evaluate("document.querySelectorAll('.related-topics .excerpt li').length"), 2);
          assert.equal(await evaluate("document.querySelector('.related-topics .excerpt a').getAttribute('href')"), 'working-memory://open/topic/source-topic');
          assert.equal(await evaluate("window.__unsafeExcerpt === true"), false);
          assert.ok((await evaluate("document.querySelector('.related-topics').innerText")).includes('Restore routing'));
          const expandedReads = await evaluate("window.__diagnosticsTest.relatedReads");
          await evaluate("window.__setDiagnosticsVisible(false); window.__setDiagnosticsVisible(true)");
          await wait("window.__diagnosticsTest.relatedReads > " + expandedReads);
          assert.equal(await evaluate("document.querySelector('.related-topics .twistie').getAttribute('aria-expanded')"), 'true');
          await evaluate("document.querySelector('.related-topics .twistie').click()");
          await wait("!document.querySelector('.related-topics .excerpt')");
          await evaluate("document.querySelector('.related-topics .topic-link').click()");
          assert.equal(await evaluate("window.__diagnosticsTest.openedTopic"), 'related-topic');
          await evaluate("document.querySelector('.related-topics .topic-link').dispatchEvent(new MouseEvent('contextmenu', {bubbles: true, cancelable: true, clientX: 100, clientY: 100}))");
          await wait("document.querySelector('[aria-label=\\"Topic actions\\"]')");
          assert.deepEqual(await evaluate("Array.from(document.querySelectorAll('[aria-label=\\"Topic actions\\"] [role=menuitem]')).map(b => b.textContent.trim())"), ['Add Child...', 'Add to workstream']);
          await evaluate("Array.from(document.querySelectorAll('[role=menuitem]')).find(b => b.textContent.trim() === 'Add Child...').click()");
          await wait("window.__diagnosticsTest.childRequest?.workstream.id === 'one'");
          assert.equal(await evaluate("window.__diagnosticsTest.childRequest.parent.id"), 'related-topic');
          assert.equal(await evaluate("document.querySelector('dialog')"), null);
          await evaluate("window.__diagnosticsTest.parentWorkstreams = [{id: 'one', title: 'One'}, {id: 'two', title: 'Two'}]; document.querySelector('.related-topics .topic-link').dispatchEvent(new MouseEvent('contextmenu', {bubbles: true, cancelable: true}))");
          await evaluate("Array.from(document.querySelectorAll('[role=menuitem]')).find(b => b.textContent.trim() === 'Add Child...').click()");
          await wait("!!document.querySelector('dialog[open] select')");
          await evaluate("{ const select = document.querySelector('dialog select'); select.value = 'two'; select.dispatchEvent(new Event('change', {bubbles: true})); }");
          await evaluate("Array.from(document.querySelectorAll('dialog button')).find(b => b.textContent.trim() === 'Continue').click()");
          await wait("window.__diagnosticsTest.childRequest?.workstream.id === 'two' && !document.querySelector('dialog')");
          await evaluate("document.querySelector('.related-topics .topic-link').dispatchEvent(new MouseEvent('contextmenu', {bubbles: true, cancelable: true}))");
          await evaluate("Array.from(document.querySelectorAll('[role=menuitem]')).find(b => b.textContent.trim() === 'Add to workstream').click()");
          await wait("!!document.querySelector('dialog[open] select')");
          await evaluate("{ window.__diagnosticsTest.membershipFailure = 'Membership failed'; const select = document.querySelector('dialog select'); select.value = 'one'; select.dispatchEvent(new Event('change', {bubbles: true})); }");
          await evaluate("Array.from(document.querySelectorAll('dialog button')).find(b => b.textContent.trim() === 'Add').click()");
          await wait("document.querySelector('dialog [role=alert]')?.textContent.includes('Membership failed')");
          await evaluate("window.__diagnosticsTest.membershipFailure = null; Array.from(document.querySelectorAll('dialog button')).find(b => b.textContent.trim() === 'Add').click()");
          await wait("!document.querySelector('dialog')");
          assert.deepEqual(await evaluate("window.__diagnosticsTest.addedTopic"), {id: 'related-topic', workstream: 'one'});
          const dragPayload = await evaluate("(() => { const dataTransfer = new DataTransfer(); document.querySelector('.related-topics .topic-link').dispatchEvent(new DragEvent('dragstart', {bubbles: true, cancelable: true, dataTransfer})); return {markdown: dataTransfer.getData('text/markdown'), uri: dataTransfer.getData('text/uri-list')}; })()");
          assert.deepEqual(dragPayload, {markdown: '[Connectivity recovery](http://127.0.0.1:7718/open/topic/related-topic)', uri: 'file:///tmp/related.md'});
          assert.equal(await evaluate("window.__diagnosticsTest.nativeDrag.filePath"), '/tmp/related.md');
          await evaluate("window.__diagnosticsTest.dragResult({filePath: '/tmp/related.md', status: 'failed', error: 'Native test failure'})");
          await wait("document.querySelector('.related-topics [role=alert]')?.textContent.includes('Native test failure')");
          await evaluate("window.__diagnosticsTest.embeddingEnabled = false; window.__setDiagnosticsVisible(false); window.__setDiagnosticsVisible(true)");
          await wait("!document.querySelector('.related-topics')");
          await evaluate("window.__diagnosticsTest.relatedFailure = 'Related topics unavailable'; window.__setDiagnosticsVisible(false); window.__setDiagnosticsVisible(true)");
          await wait("document.querySelector('.related-topics')?.innerText.includes('Related topics unavailable')");
          await evaluate("window.__diagnosticsTest.disposeRelated()");
          const relatedReads = await evaluate("window.__diagnosticsTest.relatedReads");
          await evaluate("window.__setDiagnosticsVisible(false); window.__setDiagnosticsVisible(true)");
          await new Promise(resolve => setTimeout(resolve, 50));
          assert.equal(await evaluate("window.__diagnosticsTest.relatedReads"), relatedReads);
          window.destroy();
          console.log('diagnostics-browser-ok');
          app.quit();
        }).catch(error => { console.error(error); app.exit(1); });
      `);
      const { stdout } = await promisify(execFile)(executable, [script], {
        env: { ...process.env, ELECTRON_RUN_AS_NODE: '' }, timeout: 30000, maxBuffer: 1024 * 1024,
      });
      expect(stdout).toContain('diagnostics-browser-ok');
    } finally {
      await server.close();
      await rm(directory, { recursive: true, force: true });
    }
  }, 45000,
);
