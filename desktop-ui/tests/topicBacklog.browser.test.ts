import { expect, it } from 'vitest';
import { createServer, normalizePath } from 'vite';
import { svelte } from '@sveltejs/vite-plugin-svelte';
import { createRequire } from 'node:module';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Topic, Workstream } from '../../shared/controlPlaneClient';
import { buildWorkstreamPanels } from '../../shared/panelData';

it.skipIf(process.platform === 'linux' && !process.env.DISPLAY)(
  'shares rail and backlog drag targets, menus, native references, disclosure and move actions',
  async () => {
    const executable: unknown = createRequire(import.meta.url)('electron');
    if (typeof executable !== 'string') throw new Error('Electron executable is unavailable.');
    const directory = await realpath(await mkdtemp(join(tmpdir(), 'working-memory-backlog-browser-')));
    const workstream = (id: string, status: Workstream['status'] = 'backlog'): Workstream => ({
      id, title: id, status, position: 0, closure: null,
      opened_at: 1, updated_at: 1, closed_at: null, resourceVersion: 1,
    });
    const topic = (id: string, member = 'inbox', parent?: string): Topic => ({
      id, title: id, body: '', status: 'open', topicType: 'type',
      parents: parent ? [parent] : [], workstreams: member ? [member] : [],
      focusedWorkstreams: id === 'parent' ? ['inbox'] : [],
      created_at: 1, updated_at: 1, resourceVersion: 1,
    });
    const panel = buildWorkstreamPanels({
      available: true, workstreams: [
        workstream('inbox'), workstream('later'), workstream('queued', 'queue'), workstream('active', 'progress'),
      ],
      topics: [
        topic('parent'), topic('child', 'inbox', 'parent'), topic('grandchild', 'inbox', 'child'),
        topic('active-topic', 'active'), topic('orphan', ''),
      ],
    }).active;
    const inbox = panel.items.flatMap(item => item.kind === 'workstream-section' ? item.workstreams : [])
      .find(item => item.id === 'inbox')!;
    inbox.actions.find(action => action.title === 'Send to In Progress')!.enabled = false;
    const harness = join(directory, 'BacklogHarness.svelte');
    await writeFile(harness, `
      <script>
        import ActiveRail from '/src/renderer/ActiveRail.svelte';
        import Backlog from '/src/renderer/documents/TopicBacklogView.svelte';
        import { topicBacklogDocument } from '/src/renderer/topicBacklog';
        import '/src/renderer/style.css';
        const fixture = window.__backlogTest = {
          actions: [], opens: [], transfers: [], reorders: [], parents: [], focus: [], children: [], newWorkstreams: [],
          preparations: [], nativeDrags: [], dragListeners: [], finish: null,
        };
        let panel = $state(${JSON.stringify(panel)});
        let drag = $state(null);
        window.workingMemory = {
          prepareResourceDrag: (uri, label) => new Promise(resolve => fixture.preparations.push(() => resolve({
            filePath: '/tmp/test-context.md', fileUrl: 'file:///tmp/test-context.md', filename: 'test-context.md',
          }))),
          startResourceDrag: prepared => fixture.nativeDrags.push(prepared),
          onResourceDragResult: listener => { fixture.dragListeners.push(listener); return () => {}; },
        };
        const treeProps = $derived({
          data: panel, loading: false, error: '', environments: [], selectedEnvironment: null,
          environmentLoading: false, environmentError: '',
          async onDiscoverEnvironments() {}, async onSwitchEnvironment() {}, onManageInstances() {},
          onRefresh() {}, onSettings() {}, onCollapse() {}, onOpenTopicBacklog() {}, onAddWorkstream() {},
          onOpen: uri => fixture.opens.push(uri),
          onReorder: async (id, section, index) => fixture.reorders.push({ id, section, index }),
          onTransferTopic: request => fixture.transfers.push(request),
          onReparentTopic: (id, parent) => fixture.parents.push({ id, parent }),
          onToggleFocus: (workstream, topic) => fixture.focus.push({ workstream, topic }),
          onAddTopic: (workstream, parent) => fixture.children.push({ workstream, parent }),
          onMoveToNewWorkstream: source => fixture.newWorkstreams.push(source),
          async onAction(id, action) {
            fixture.actions.push({ id, action: JSON.parse(JSON.stringify(action)) });
            await new Promise(resolve => fixture.finish = resolve);
            panel = { ...panel, items: panel.items.map(item => item.kind === 'workstream-section'
              ? { ...item, workstreams: item.workstreams.filter(workstream => workstream.id !== id) } : item) };
          },
        });
        const backlog = $derived(topicBacklogDocument(panel));
        fixture.refresh = () => {
          const next = JSON.parse(JSON.stringify(panel));
          const inbox = next.items.find(item => item.section === 'backlog').workstreams[0];
          inbox.children[0].children[0].label = 'parent refreshed';
          inbox.focused_topics[0].label = 'parent refreshed';
          panel = next;
        };
      </script>
      <div class="rail active-rail"><ActiveRail {...treeProps} bind:activeDrag={drag} /></div>
      <div class="backlog"><Backlog {backlog} {treeProps} bind:activeDrag={drag} /></div>
      <style>
        :global(body) { display: flex; width: 1200px; }
        .rail { width: 300px; height: 900px; }
        .backlog { width: 850px; padding: 16px; }
      </style>
    `);
    const server = await createServer({
      configFile: false, root: fileURLToPath(new URL('..', import.meta.url)),
      resolve: { dedupe: ['svelte'] }, cacheDir: join(directory, 'vite-cache'),
      optimizeDeps: { include: ['svelte'] },
      plugins: [svelte(), {
        name: 'backlog-browser-fixture',
        resolveId: id => id === '/backlog-fixture.js' ? '\0backlog-fixture' : undefined,
        load: id => id === '\0backlog-fixture'
          ? `import { mount } from 'svelte'; import Harness from ${JSON.stringify(`/@fs/${normalizePath(harness)}`)}; mount(Harness, { target: document.body });`
          : undefined,
        configureServer(server) {
          server.middlewares.use((req, res, next) => {
            if (req.url !== '/backlog-test.html') { next(); return; }
            res.setHeader('content-type', 'text/html');
            res.end('<!doctype html><html><body><script type="module" src="/backlog-fixture.js"></script></body></html>');
          });
        },
      }],
      server: { host: '127.0.0.1', port: 0, fs: { allow: [fileURLToPath(new URL('../..', import.meta.url)), directory] } },
      appType: 'custom',
    });
    try {
      await server.listen();
      const address = server.httpServer?.address();
      if (!address || typeof address === 'string') throw new Error('Backlog fixture did not bind a TCP port.');
      const script = join(directory, 'backlog-test.cjs');
      await writeFile(script, `
        const { app, BrowserWindow } = require('electron');
        const assert = require('node:assert/strict');
        app.setPath('userData', ${JSON.stringify(join(directory, 'profile'))});
        app.whenReady().then(async () => {
          const window = new BrowserWindow({ show: false, width: 1250, height: 1000 });
          const evaluate = code => window.webContents.executeJavaScript(code);
          const screenshotDirectory = ${JSON.stringify(process.env.WM_BACKLOG_SCREENSHOT_DIR ?? '')};
          async function screenshot(name) {
            if (!screenshotDirectory) return;
            await evaluate('new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))');
            const image = await window.webContents.capturePage();
            require('node:fs').writeFileSync(require('node:path').join(screenshotDirectory, name + '.png'), image.toPNG());
          }
          async function contrast(selector, property = 'color', backgroundSelector = selector) {
            const colors = await evaluate(\`(() => {
              const element = document.querySelector(\${JSON.stringify(selector)});
              let background = document.querySelector(\${JSON.stringify(backgroundSelector)});
              while (background && getComputedStyle(background).backgroundColor === 'rgba(0, 0, 0, 0)') background = background.parentElement;
              return [getComputedStyle(element)[\${JSON.stringify(property)}], getComputedStyle(background).backgroundColor].map(color => {
                const canvas = document.createElement('canvas');
                canvas.width = canvas.height = 1;
                const context = canvas.getContext('2d');
                context.fillStyle = color;
                context.fillRect(0, 0, 1, 1);
                return [...context.getImageData(0, 0, 1, 1).data].slice(0, 3);
              });
            })()\`);
            const luminance = color => {
              const rgb = color.map(value => {
                const channel = value / 255;
                return channel <= .04045 ? channel / 12.92 : ((channel + .055) / 1.055) ** 2.4;
              });
              return rgb[0] * .2126 + rgb[1] * .7152 + rgb[2] * .0722;
            };
            const values = colors.map(luminance).sort((a, b) => b - a);
            return (values[0] + .05) / (values[1] + .05);
          }
          const errors = [];
          window.webContents.on('console-message', (_event, _level, message) => { if (message.includes('Error')) errors.push(message); });
          async function wait(code) {
            const until = Date.now() + 7000;
            while (Date.now() < until) {
              if (await evaluate(code)) return;
              await new Promise(resolve => setTimeout(resolve, 20));
            }
            throw new Error('Timed out: ' + code + '\\n' + errors.join('\\n') + '\\n' + await evaluate('document.body.innerText'));
          }
          async function drag(source, target, metaKey = false) {
            return evaluate(\`(() => {
              const from = document.querySelector(\${JSON.stringify(source)});
              const to = document.querySelector(\${JSON.stringify(target)});
              if (!from || !to) throw new Error('Missing drag endpoint');
              const dataTransfer = new DataTransfer();
              from.dispatchEvent(new DragEvent('dragstart', { bubbles: true, cancelable: true, dataTransfer }));
              const over = new DragEvent('dragover', { bubbles: true, cancelable: true, dataTransfer, metaKey: \${metaKey} });
              to.dispatchEvent(over);
              to.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer, metaKey: \${metaKey} }));
              from.dispatchEvent(new DragEvent('dragend', { bubbles: true, dataTransfer }));
              return { accepted: over.defaultPrevented, markdown: dataTransfer.getData('text/markdown'),
                reference: JSON.parse(dataTransfer.getData('application/vnd.kubarycz.working-memory+json')) };
            })()\`);
          }
          async function menu(selector) {
            await evaluate(\`document.querySelector(\${JSON.stringify(selector)}).dispatchEvent(new MouseEvent('contextmenu',
              { bubbles: true, cancelable: true, clientX: 400, clientY: 200 }))\`);
            await wait("document.querySelector('.active-context-menu')");
          }
          async function menuClick(title) {
            await evaluate(\`[...document.querySelectorAll('.active-context-menu button')].find(button => button.textContent.trim() === \${JSON.stringify(title)}).click()\`);
          }
          await window.loadURL('http://127.0.0.1:${address.port}/backlog-test.html');
          await wait("document.querySelector('.backlog [aria-label=\\"Expand inbox\\"]')");
          assert(await contrast('.backlog .workstream-open') >= 4.5, 'Backlog title contrast');
          assert(await contrast('.rail .workstream-open') >= 4.5, 'Rail title contrast');
          assert(await contrast('.backlog-workstream-actions button') >= 4.5, 'Move button contrast');
          assert.equal(await evaluate("document.querySelectorAll('.backlog .active-row').length"), 1);
          await evaluate("document.querySelector('.backlog [data-workstream=inbox] .workstream-open').click()");
          assert.deepEqual(await evaluate("window.__backlogTest.opens"), ['working-memory:/workstream/inbox.working-memory']);
          await evaluate("document.querySelector('.backlog [aria-label=\\"Expand inbox\\"]').click()");
          await wait("document.querySelector('.backlog [aria-label=\\"Expand parent\\"]')");
          await evaluate("document.querySelector('.backlog [aria-label=\\"Expand parent\\"]').click()");
          await wait("document.querySelector('.backlog [aria-label=\\"Expand child\\"]')");
          await evaluate("document.querySelector('.backlog [aria-label=\\"Expand child\\"]').click()");
          await wait("document.querySelectorAll('.backlog [data-workstream=inbox] .active-row').length === 3");
          assert(await contrast('.backlog .active-row .active-open') >= 4.5, 'Topic text contrast');
          assert(await contrast('.backlog .active-group-header') >= 4.5, 'Topic group contrast');
          assert(await contrast('.backlog .graph-node-dot', 'borderTopColor', '.backlog .active-card') >= 3, 'Topic connector contrast');
          assert(await contrast('.backlog .backlog-orphan-topics .graph-node-dot', 'borderTopColor', '.backlog .backlog-orphan-topics') >= 3, 'Unassigned topic connector contrast');
          const originalCardClass = await evaluate("document.querySelector('.backlog [data-workstream=inbox]').className");
          for (let index = 0; index < 15; index++) {
            await evaluate(\`{
              const card = document.querySelector('.backlog [data-workstream=inbox]');
              card.classList.remove(...Array.from({ length: 15 }, (_, i) => 'ws-card-color-' + i));
              card.classList.add('ws-card-color-\${index}');
            }\`);
            assert(await contrast('.backlog .workstream-open') >= 4.5, 'Title contrast for palette ' + index);
            assert(await contrast('.backlog .graph-node-dot', 'borderTopColor', '.backlog .active-card') >= 3, 'Connector contrast for palette ' + index);
          }
          await evaluate(\`document.querySelector('.backlog [data-workstream=inbox]').className = \${JSON.stringify(originalCardClass)}\`);
          await screenshot('backlog-wide');
          await evaluate("document.querySelector('.backlog').style.width = '360px'; document.querySelector('.backlog').style.flexShrink = '0'");
          assert.equal(await evaluate(\`(() => {
            const card = document.querySelector('.backlog .active-card').getBoundingClientRect();
            return [...document.querySelectorAll('.backlog .active-card:first-child .backlog-workstream-actions button')]
              .every(button => { const bounds = button.getBoundingClientRect(); return bounds.left >= card.left && bounds.right <= card.right && bounds.height >= 30 && bounds.height <= 40; });
          })()\`), true, 'Move buttons must fit narrow cards');
          await evaluate("document.querySelector('.backlog .workstream-open .active-label').textContent = 'A very long workstream title with room for clear actions and topic navigation'.repeat(4)");
          assert.equal(await evaluate(\`(() => {
            const label = document.querySelector('.backlog .workstream-open .active-label');
            return label.scrollWidth > label.clientWidth && getComputedStyle(label).textOverflow === 'ellipsis'
              && label.getBoundingClientRect().height < 30;
          })()\`), true, 'Long titles must truncate rather than displace controls');
          await screenshot('backlog-narrow');
          await evaluate("document.querySelector('.backlog .workstream-open .active-label').textContent = 'inbox'; document.querySelector('.backlog').style.width = '850px'");
          await evaluate("document.querySelectorAll('.backlog [data-workstream=inbox] .active-row .active-open')[2].click()");
          assert.equal(await evaluate("window.__backlogTest.opens.at(-1)"), 'working-memory:/topic/grandchild.working-memory');
          await evaluate("window.__backlogTest.refresh()");
          await wait("document.querySelector('.backlog [aria-label=\\"Collapse parent refreshed\\"]')");
          assert.equal(await evaluate("document.querySelectorAll('.backlog [data-workstream=inbox] .active-row').length"), 3);
          const source = '.backlog [data-workstream=inbox] .active-row .active-open';
          const queue = '.rail [data-workstream=queued] .active-card-header';
          const dropped = await drag(source, queue);
          assert.equal(dropped.accepted, true);
          assert.equal(dropped.reference.href, 'http://127.0.0.1:7718/open/topic/parent');
          assert.equal(dropped.markdown, '[parent refreshed](http://127.0.0.1:7718/open/topic/parent)');
          assert.deepEqual(await evaluate("window.__backlogTest.transfers.at(-1)"),
            { id: 'parent', sourceWorkstream: 'inbox', targetWorkstream: 'queued', move: false });
          await drag(source, queue, true);
          assert.equal(await evaluate("window.__backlogTest.transfers.at(-1).move"), true);
          await drag('.rail [data-workstream=active] .active-row .active-open', '.backlog [data-workstream=later] .active-card-header');
          assert.deepEqual(await evaluate("window.__backlogTest.transfers.at(-1)"),
            { id: 'active-topic', sourceWorkstream: 'active', targetWorkstream: 'later', move: false });
          await drag(source, '.rail [data-workstream=active] .active-row');
          assert.deepEqual(await evaluate("window.__backlogTest.parents.at(-1)"), { id: 'parent', parent: 'active-topic' });
          await drag('.rail [data-workstream=active] .active-row .active-open', '.backlog [data-workstream=inbox] .active-group');
          assert.deepEqual(await evaluate("window.__backlogTest.parents.at(-1)"), { id: 'active-topic', parent: null });
          await drag('.backlog [data-workstream=inbox] .workstream-open', '.rail .section-progress .active-section-content');
          assert.deepEqual(await evaluate("window.__backlogTest.reorders.at(-1)"), { id: 'inbox', section: 'progress', index: 0 });
          await drag('.rail [data-workstream=queued] .workstream-open', '.backlog .backlog-workstreams');
          assert.equal(await evaluate("window.__backlogTest.reorders.at(-1).section"), 'backlog');
          await drag('.backlog .backlog-orphan-topics .active-open', queue);
          assert.deepEqual(await evaluate("window.__backlogTest.transfers.at(-1)"),
            { id: 'orphan', sourceWorkstream: '', targetWorkstream: 'queued', move: false });
          await menu('.backlog [data-workstream=inbox] .active-row');
          assert(await contrast('.backlog-context-menu button') >= 4.5, 'Backlog menu text contrast');
          assert.equal(await evaluate("getComputedStyle(document.querySelector('.backlog-context-menu')).backgroundColor"), 'rgb(255, 255, 255)');
          await screenshot('backlog-menu');
          assert.deepEqual(await evaluate("[...document.querySelectorAll('.active-context-menu > .active-context-menu-entry > button')].map(button => button.textContent.trim())"),
            ['Add Child...', 'Remove from Focus', 'Move to...', 'Remove from workstream']);
          await menuClick('Remove from Focus');
          assert.deepEqual(await evaluate("window.__backlogTest.focus.at(-1)"), { workstream: 'inbox', topic: 'parent' });
          await menu('.backlog [data-workstream=inbox] .active-row');
          await menuClick('Add Child...');
          assert.deepEqual(await evaluate("window.__backlogTest.children.at(-1)"),
            { workstream: 'inbox', parent: { id: 'parent', title: 'parent refreshed' } });
          await menu('.backlog [data-workstream=inbox] .active-row');
          await menuClick('queued');
          assert.deepEqual(await evaluate("window.__backlogTest.transfers.at(-1)"),
            { id: 'parent', sourceWorkstream: 'inbox', targetWorkstream: 'queued', move: true });
          await menu('.backlog [data-workstream=inbox] .active-row');
          await menuClick('New Workstream...');
          assert.deepEqual(await evaluate("window.__backlogTest.newWorkstreams.at(-1)"), { id: 'parent', sourceWorkstream: 'inbox' });
          await menu('.backlog .backlog-orphan-topics .active-row');
          await menuClick('New Workstream...');
          assert.deepEqual(await evaluate("window.__backlogTest.newWorkstreams.at(-1)"), { id: 'orphan', sourceWorkstream: '' });
          await menu('.backlog [data-workstream=inbox] .active-card-header');
          assert.equal(await evaluate("[...document.querySelectorAll('.active-context-menu button')].some(button => button.textContent.trim() === 'Close Workstream')"), true);
          await evaluate("document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))");
          await wait("!document.querySelector('.active-context-menu')");
          await evaluate("window.__backlogTest.preparations.forEach(resolve => resolve())");
          await new Promise(resolve => setTimeout(resolve, 50));
          await evaluate(\`{
            const event = new DragEvent('dragstart', { bubbles: true, cancelable: true, dataTransfer: new DataTransfer() });
            document.querySelector('\${source}').dispatchEvent(event);
            if (!event.defaultPrevented) throw new Error('Native drag was not started');
          }\`);
          assert.equal(await evaluate("window.__backlogTest.nativeDrags.at(-1).filename"), 'test-context.md');
          await evaluate("window.__backlogTest.dragListeners.forEach(listener => listener({ filePath: '/tmp/test-context.md', status: 'failed', error: 'Test cancellation' }))");
          assert.equal(await evaluate("document.querySelectorAll('.backlog-workstream-actions button')[1].disabled"), true);
          await evaluate("document.querySelector('.backlog-workstream-actions button').click()");
          await wait("document.querySelector('.backlog [data-workstream=inbox][aria-busy=true]')");
          assert.equal(await evaluate("document.querySelector('.backlog-workstream-actions button').disabled"), true);
          await evaluate("document.querySelector('.backlog-workstream-actions button').click()");
          assert.equal(await evaluate("window.__backlogTest.actions.length"), 1);
          assert.equal(await evaluate("window.__backlogTest.actions[0].action.args[0].section"), 'queue');
          await evaluate("window.__backlogTest.finish()");
          await wait("!document.querySelector('.backlog [data-workstream=inbox]')");
          await evaluate("document.querySelectorAll('.backlog-workstream-actions button')[1].click()");
          await wait("window.__backlogTest.actions.length === 2");
          assert.equal(await evaluate("window.__backlogTest.actions[1].action.args[0].section"), 'progress');
          await evaluate("window.__backlogTest.finish()");
          await wait("document.body.innerText.includes('No workstreams are on the backlog.')");
          console.log('backlog-browser: shared interactions and disclosure passed');
          app.quit();
        }).catch(error => { console.error(error); app.exit(1); });
      `);
      const { stdout } = await promisify(execFile)(executable, [script], {
        timeout: 30_000, env: { ...process.env, ELECTRON_RUN_AS_NODE: '' },
      });
      expect(stdout).toContain('backlog-browser: shared interactions and disclosure passed');
    } finally {
      await server.close();
      await rm(directory, { recursive: true, force: true });
    }
  }, 40_000,
);
