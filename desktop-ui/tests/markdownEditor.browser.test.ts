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
import type { TopicVM } from '../src/renderer/documents/types';

it.skipIf(process.platform === 'linux' && !process.env.DISPLAY)(
  'opens bare URLs and pastes rich links in Live and Source without changing plain paste or images',
  async () => {
    const executable: unknown = createRequire(import.meta.url)('electron');
    if (typeof executable !== 'string') throw new Error('Electron executable is unavailable.');
    const directory = await realpath(await mkdtemp(join(tmpdir(), 'working-memory-markdown-browser-')));
    const url = 'https://example.com/incidents/details/123456789/summary';
    const title = 'Incident 123456789 : <Declared Outage><Example Customer>An operation requires exclusive access.';
    const topic: TopicVM = {
      kind: 'topic', id: 'markdown-fixture', title: 'Markdown preview', status: 'open',
      topicType: 'user-story', typeMeta: null, body: `${url}\n\nTail`,
      createdAt: 1, updatedAt: 1, resourceVersion: 1, editable: true,
      parents: [], children: [], workstreams: [], focusedWorkstreams: [], agentMessages: [],
    };
    const harness = join(directory, 'MarkdownHarness.svelte');
    await writeFile(harness, `
      <script>
        import { EditorView } from '@codemirror/view';
        import { undo, redo } from '@codemirror/commands';
        import { activateLivePreview } from '/src/renderer/documents/liveMarkdownPreview';
        import TopicView from '/src/renderer/documents/TopicView.svelte';
        import '/src/renderer/style.css';
        let topic = $state(${JSON.stringify(topic)});
        const fixture = window.__markdownTest = { saves: [], opens: [], attachments: [], imageOpens: [] };
        fixture.body = () => topic.body;
        fixture.reset = body => { topic = { ...topic, body }; };
        fixture.editor = () => EditorView.findFromDOM(document.querySelector('.editor .cm-editor'));
        fixture.select = (from, to = from) => {
          const view = fixture.editor();
          view.focus();
          view.dispatch({ selection: { anchor: from, head: to }, effects: activateLivePreview.of() });
        };
        fixture.undo = () => undo(fixture.editor());
        fixture.redo = () => redo(fixture.editor());
        const readonly = $derived({ ...topic, editable: false });
        function save(patch) { fixture.saves.push(patch); topic = { ...topic, ...patch }; }
        async function attach(files) {
          fixture.attachments.push(files.map(file => file.name));
          return [{ id: '60138e0f-1ca7-460d-a66b-2bc80fb82942', filename: 'screenshot.png' }];
        }
      </script>
      <div class="editor">
        <TopicView {topic} saveState="idle" onSaveTopic={save}
          attachmentBaseUrl={window.location.origin}
          onOpenTopic={() => {}} onOpenWorkstream={() => {}} onSetAgentMessageStatus={() => {}}
          onOpenLink={href => fixture.opens.push(href)} onAttachImages={attach} />
      </div>
      <div class="readonly">
        <TopicView topic={readonly} saveState="idle" onSaveTopic={() => {}}
          attachmentBaseUrl={window.location.origin}
          onOpenTopic={() => {}} onOpenWorkstream={() => {}} onSetAgentMessageStatus={() => {}} />
      </div>
      <style>
        :global(body) { padding: 24px; }
        .editor, .readonly { width: 900px; }
        :global(.markdown-image img) { width: 240px; height: 120px; object-fit: contain; }
      </style>
    `);
    const server = await createServer({
      configFile: false, root: fileURLToPath(new URL('..', import.meta.url)),
      resolve: { dedupe: ['svelte', '@codemirror/state', '@codemirror/view', '@codemirror/commands'] },
      cacheDir: join(directory, 'vite-cache'),
      optimizeDeps: { include: [
        'svelte', 'turndown', 'markdown-it', '@codemirror/state', '@codemirror/view',
        '@codemirror/commands', '@codemirror/lang-markdown', '@codemirror/language',
        '@lezer/highlight', '@lezer/markdown',
      ] },
      plugins: [svelte(), {
        name: 'markdown-browser-fixture',
        resolveId: id => id === '/markdown-fixture.js' ? '\0markdown-fixture' : undefined,
        load: id => id === '\0markdown-fixture'
          ? `import { mount } from 'svelte'; import Harness from ${JSON.stringify(`/@fs/${normalizePath(harness)}`)}; mount(Harness, { target: document.body });`
          : undefined,
        configureServer(server) {
          server.middlewares.use((req, res, next) => {
            if (req.url?.startsWith('/attachments/')) {
              res.setHeader('content-type', 'image/png');
              res.end(Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=', 'base64'));
              return;
            }
            if (req.url !== '/markdown-test.html') { next(); return; }
            res.setHeader('content-type', 'text/html');
            res.end('<!doctype html><html><body><script type="module" src="/markdown-fixture.js"></script></body></html>');
          });
        },
      }],
      server: { host: '127.0.0.1', port: 0, fs: { allow: [fileURLToPath(new URL('../..', import.meta.url)), directory] } },
      appType: 'custom',
    });
    try {
      await server.listen();
      const address = server.httpServer?.address();
      if (!address || typeof address === 'string') throw new Error('Markdown fixture did not bind a TCP port.');
      const script = join(directory, 'markdown-test.cjs');
      await writeFile(script, `
        const { app, BrowserWindow } = require('electron');
        const assert = require('node:assert/strict');
        app.setPath('userData', ${JSON.stringify(join(directory, 'profile'))});
        app.whenReady().then(async () => {
          const window = new BrowserWindow({ show: false, width: 1100, height: 1000 });
          const evaluate = code => window.webContents.executeJavaScript(code);
          const imageMenus = [];
          window.webContents.on('context-menu', (_event, params) => {
            imageMenus.push({ type: params.mediaType, source: params.srcURL, loaded: params.hasImageContents });
          });
          const url = ${JSON.stringify(url)};
          const title = ${JSON.stringify(title)};
          const html = '<p><a href="' + url + '">' + title.replace(/</g, '&lt;').replace(/>/g, '&gt;') + '</a></p>';
          const errors = [];
          window.webContents.on('console-message', (_event, _level, message) => errors.push(message));
          async function wait(code) {
            const until = Date.now() + 7000;
            while (Date.now() < until) {
              if (await evaluate(code)) return;
              await new Promise(resolve => setTimeout(resolve, 20));
            }
            throw new Error('Timed out: ' + code + '\\n' + errors.join('\\n'));
          }
          async function reset(body) {
            await evaluate('window.__markdownTest.reset(' + JSON.stringify(body) + ')');
            await wait('window.__markdownTest.editor().state.doc.toString() === ' + JSON.stringify(body));
          }
          async function paste(selector, html, text = title, image = false) {
            return evaluate(\`(() => {
              const transfer = new DataTransfer();
              if (\${JSON.stringify(html)}) transfer.setData('text/html', \${JSON.stringify(html)});
              transfer.setData('text/plain', \${JSON.stringify(text)});
              if (\${image}) transfer.items.add(new File(['image'], 'screenshot.png', { type: 'image/png' }));
              const event = new ClipboardEvent('paste', { bubbles: true, cancelable: true, clipboardData: transfer });
              document.querySelector(\${JSON.stringify(selector)}).dispatchEvent(event);
              return event.defaultPrevented;
            })()\`);
          }
          async function failedPaste(selector) {
            return evaluate(\`(() => {
              const transfer = new DataTransfer();
              Object.defineProperty(transfer, 'getData', { value: () => { throw new Error('Clipboard conversion failed'); } });
              const event = new ClipboardEvent('paste', { bubbles: true, cancelable: true, clipboardData: transfer });
              document.querySelector(\${JSON.stringify(selector)}).dispatchEvent(event);
              return event.defaultPrevented;
            })()\`);
          }
          await window.loadURL('http://127.0.0.1:${address.port}/markdown-test.html');
          await wait("document.querySelector('.cm-live-link-target')");
          assert.equal(await evaluate("document.querySelector('.cm-live-link-target').title"), url);
          assert.equal(await evaluate("document.querySelector('.readonly a').getAttribute('href')"), url);
          const point = await evaluate(\`(() => {
            const rect = document.querySelector('.cm-live-link-target').getBoundingClientRect();
            return { x: Math.round(rect.left + 12), y: Math.round(rect.top + rect.height / 2) };
          })()\`);
          window.webContents.sendInputEvent({ type: 'mouseDown', ...point, button: 'left', clickCount: 1 });
          window.webContents.sendInputEvent({ type: 'mouseUp', ...point, button: 'left', clickCount: 1 });
          await wait("window.__markdownTest.opens.length === 1");
          assert.deepEqual(await evaluate('window.__markdownTest.opens'), [url]);
          assert.equal(await evaluate('window.__markdownTest.saves.length'), 0);
          assert.equal(await evaluate('window.__markdownTest.body()'), url + '\\n\\nTail');

          await reset('Before SELECT after\\n\\nTail');
          await evaluate('window.__markdownTest.select(7, 13)');
          assert(await paste('.cm-content', html));
          const source = await evaluate('window.__markdownTest.body()');
          assert(source.startsWith('Before [Incident 123456789'));
          assert(source.endsWith(' after\\n\\nTail'));
          assert(source.includes('](' + url + ')'));
          assert.equal(await evaluate('window.__markdownTest.editor().state.selection.main.head'), source.length - ' after\\n\\nTail'.length);
          assert(await evaluate('window.__markdownTest.undo()'));
          assert.equal(await evaluate('window.__markdownTest.body()'), 'Before SELECT after\\n\\nTail');
          assert(await evaluate('window.__markdownTest.redo()'));
          assert.equal(await evaluate('window.__markdownTest.body()'), source);
          await evaluate('window.__markdownTest.select(window.__markdownTest.body().length)');
          await wait("document.querySelector('.cm-live-link-target')");
          assert.equal(await evaluate("document.querySelector('.cm-live-link-target').textContent"), title);
          assert.equal(await evaluate("document.querySelector('.cm-live-link-target').title"), url);
          assert.equal(await evaluate("document.querySelector('.readonly a').textContent"), title);

          await reset('');
          await evaluate('window.__markdownTest.select(0)');
          await paste('.cm-content', '', '**plain Markdown** ' + url);
          assert.equal(await evaluate('window.__markdownTest.body()'), '**plain Markdown** ' + url);
          await reset('');
          await evaluate('window.__markdownTest.select(0)');
          await paste('.cm-content', html, title, true);
          await wait("window.__markdownTest.body().startsWith('![screenshot.png]')");
          assert.deepEqual(await evaluate('window.__markdownTest.attachments'), [['screenshot.png']]);
          assert.equal(await evaluate('window.__markdownTest.body()'), '![screenshot.png](wm-attachment:60138e0f-1ca7-460d-a66b-2bc80fb82942)');
          await wait("document.querySelector('.hybrid-markdown-image img')?.naturalWidth > 0");
          assert.equal(await evaluate("document.querySelectorAll('figcaption').length"), 0);
          assert.equal(await evaluate("document.querySelector('.hybrid-markdown-image img').alt"), 'screenshot.png');
          await evaluate(\`document.body.addEventListener('click', event => {
            const button = event.target.closest('button[data-image-source]');
            if (button) { event.preventDefault(); window.__markdownTest.imageOpens.push(button.dataset.imageSource); }
          })\`);
          const imageSource = await evaluate("document.querySelector('.hybrid-markdown-image img').src");
          const saves = await evaluate('window.__markdownTest.saves.length');
          await evaluate("document.querySelector('.editor .markdown-image-open').click()");
          await evaluate("document.querySelector('.readonly .markdown-image-open').click()");
          assert.deepEqual(await evaluate('window.__markdownTest.imageOpens'), [imageSource, imageSource]);
          assert.equal(await evaluate('window.__markdownTest.saves.length'), saves);
          assert.equal(await evaluate("getComputedStyle(document.querySelector('.markdown-image-open')).width"), '32px');
          const imagePoint = await evaluate(\`(() => {
            const image = document.querySelector('.hybrid-markdown-image img');
            image.scrollIntoView();
            const rect = image.getBoundingClientRect();
            return { x: Math.round(rect.left + rect.width / 2), y: Math.round(rect.top + rect.height / 2) };
          })()\`);
          window.webContents.sendInputEvent({ type: 'mouseDown', ...imagePoint, button: 'right', clickCount: 1 });
          window.webContents.sendInputEvent({ type: 'mouseUp', ...imagePoint, button: 'right', clickCount: 1 });
          const menuDeadline = Date.now() + 2000;
          while (imageMenus.length === 0 && Date.now() < menuDeadline) await new Promise(resolve => setTimeout(resolve, 20));
          assert.deepEqual(imageMenus[0], { type: 'image', source: imageSource, loaded: true });
          assert.equal(await evaluate('window.__markdownTest.saves.length'), saves);

          await reset('Before SELECT after');
          await evaluate("document.querySelector('.editor #tab-source').click()");
          await wait("document.querySelector('.editor textarea')");
          await evaluate("document.querySelector('.editor textarea').setSelectionRange(7, 13)");
          assert(await paste('.editor textarea', html));
          const sourceMode = await evaluate('window.__markdownTest.body()');
          assert(sourceMode.startsWith('Before [Incident 123456789'));
          assert(sourceMode.endsWith(' after'));
          assert(sourceMode.includes('](' + url + ')'));
          assert.equal(await evaluate("document.querySelector('.editor textarea').selectionStart"), sourceMode.length - ' after'.length);
          window.webContents.undo();
          await wait("window.__markdownTest.body() === 'Before SELECT after'");
          assert.equal(await evaluate("document.querySelector('.editor textarea').value"), 'Before SELECT after');
          window.webContents.redo();
          await wait('window.__markdownTest.body() === ' + JSON.stringify(sourceMode));
          assert.equal(await evaluate("document.querySelector('.editor textarea').value"), sourceMode);
          assert.equal(await paste('.editor textarea', '', '**raw Markdown**'), false);
          assert.equal(await evaluate('window.__markdownTest.body()'), sourceMode);
          assert.equal(await evaluate("document.querySelectorAll('.readonly .cm-editor, .readonly textarea').length"), 0);
          assert.equal(await evaluate("document.querySelectorAll('[role=alert]').length"), 0);
          assert(await failedPaste('.editor textarea'));
          await wait("document.querySelector('.editor [role=alert]')?.textContent.includes('Clipboard conversion failed')");
          assert.equal(await evaluate('window.__markdownTest.body()'), sourceMode);
          await evaluate("document.querySelector('.editor #tab-hybrid').click()");
          await wait("document.querySelector('.editor .cm-content')");
          assert(await failedPaste('.editor .cm-content'));
          await wait("document.querySelector('.editor [role=alert]')?.textContent.includes('Clipboard conversion failed')");
          assert.equal(await evaluate('window.__markdownTest.body()'), sourceMode);
          console.log('markdown-browser: links, rich paste, selection, undo, source and images passed');
          app.quit();
        }).catch(error => { console.error(error); app.exit(1); });
      `);
      const { stdout } = await promisify(execFile)(executable, [script], {
        timeout: 30_000, env: { ...process.env, ELECTRON_RUN_AS_NODE: '' },
      });
      expect(stdout).toContain('markdown-browser: links, rich paste, selection, undo, source and images passed');
    } finally {
      await server.close();
      await rm(directory, { recursive: true, force: true });
    }
  }, 40_000,
);
