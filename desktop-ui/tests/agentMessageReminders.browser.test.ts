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
  'renders deadline-aware reminder placement, overdue styling, acknowledgement, Snooze and errors',
  async () => {
    const executable: unknown = createRequire(import.meta.url)('electron');
    if (typeof executable !== 'string') throw new Error('Electron executable is unavailable.');
    const directory = await mkdtemp(join(tmpdir(), 'working-memory-reminders-browser-'));
    const fixture = `
      <script>
        import RecentMessages from '/src/renderer/RecentMessages.svelte';
        import AgentMessageCallouts from '/src/renderer/documents/AgentMessageCallouts.svelte';
        import '/src/renderer/style.css';
        const initialMessage = {
          id: 'reminder-1', agentId: 'agent-1', agentName: 'Reminder Agent', title: 'Review X, Y, Z',
          description: '**Authored reminder**', recommendedAction: 'Review X, Y, Z.',
          category: 'reminder', severity: 'info', status: 'open', attention: false,
          dueAt: Math.floor(Date.now() / 1000) + 2, createdAt: 1, updatedAt: 1, topics: ['selected'], relations: [],
        };
        let message = $state(initialMessage);
        const ordinary = { ...initialMessage, id: 'ordinary-1', category: 'completion',
          dueAt: undefined, agentName: 'Other Agent', title: 'Ordinary history', createdAt: 2 };
        let moreMessages = $state(['completion', 'approval', 'error', 'request'].map(category => ({
          ...initialMessage, id: 'message-' + category, title: 'Message ' + category,
          category, description: 'Details for ' + category, dueAt: undefined,
          attention: category === 'error', severity: category === 'error' ? 'error' : 'info',
          createdAt: Math.floor(Date.now() / 1000) - 180,
        })));
        const conversation = { key: 'conversation-1', journalId: 'conversation-1',
          status: 'succeeded', startedAt: Date.now(), userText: 'Conversation history',
          assistantText: 'Still visible', scope: {kind: 'Topic', id: 'selected'},
          entityRefs: [], attachments: [], tools: [] };
        const testState = window.__reminderTest = { calls: [], fail: false };
        testState.setDeadline = dueAt => { message = { ...message, dueAt }; };
        testState.clearDecision = () => { moreMessages = moreMessages.map(value => ({ ...value, decision: undefined })); };
        const noop = () => {};
        async function snooze(id, dueAt) {
          testState.calls.push({ id, dueAt });
          if (testState.hold) await new Promise(resolve => { testState.release = resolve; });
          if (testState.fail) throw new Error('Snooze failed');
          message = { ...message, dueAt, status: 'open', attention: false };
        }
        function setStatus(id, status) {
          if (id === message.id) message = { ...message, status, attention: false };
          else moreMessages = moreMessages.map(value => value.id === id ? { ...value, status, attention: false } : value);
        }
        async function recordDecision(id, outcome, decidedBy) {
          moreMessages = moreMessages.map(value => value.id === id
            ? { ...value, decision: {outcome, decided_by: decidedBy} } : value);
        }
      </script>
      <div class="document-reminders">
        <AgentMessageCallouts agentMessages={[message, ...moreMessages]} onSetAgentMessageStatus={setStatus}
          onRecordDecision={recordDecision} onSnooze={snooze} />
      </div>
      <RecentMessages runs={[conversation]} agentMessages={[message, ...moreMessages, ordinary]} humanName="Human" expanded
        context={{kind: 'topic', routeKind: 'topic', identifier: 'selected', title: 'Selected'}}
        onReload={noop}
        unreadResponses={[]} onViewed={noop} onFocus={noop} onRetry={noop} runBlocked={() => false}
        onInspect={noop} onOpen={noop} attachmentUrl={() => ''} assistantFallback={() => ''}
        onResolve={noop} onSetAgentMessageStatus={setStatus} onSnooze={snooze} />
    `;
    const server = await createServer({
      configFile: false, root: fileURLToPath(new URL('..', import.meta.url)),
      cacheDir: join(directory, 'vite-cache'), optimizeDeps: { include: ['svelte', 'markdown-it', 'chrono-node'] },
      plugins: [{
        name: 'reminders-browser-fixture',
        resolveId: id => ['/reminders-fixture.svelte', '/reminders-fixture.js'].includes(id) ? `\0${id.slice(1)}` : undefined,
        load: id => id === '\0reminders-fixture.svelte' ? fixture
          : id === '\0reminders-fixture.js' ? 'import {mount} from "svelte"; import Fixture from "/reminders-fixture.svelte"; mount(Fixture, {target: document.querySelector("main")});'
          : undefined,
        configureServer(server) {
          server.middlewares.use((req, res, next) => {
            if (req.url !== '/reminders-test.html') { next(); return; }
            res.setHeader('content-type', 'text/html');
            res.end('<!doctype html><html><body><main></main><script type="module" src="/reminders-fixture.js"></script></body></html>');
          });
        },
      }, svelte()],
      server: { host: '127.0.0.1', port: 0 }, appType: 'custom',
    });
    try {
      await server.listen();
      const address = server.httpServer?.address();
      if (!address || typeof address === 'string') throw new Error('Reminder fixture did not bind a TCP port.');
      const script = join(directory, 'reminders-test.cjs');
      await writeFile(script, `
        const { app, BrowserWindow } = require('electron');
        const assert = require('node:assert/strict');
        app.setPath('userData', ${JSON.stringify(join(directory, 'profile'))});
        app.whenReady().then(async () => {
          const window = new BrowserWindow({ show: false });
          const evaluate = async code => {
            try { return await window.webContents.executeJavaScript(code); }
            catch (error) { throw new Error('Renderer evaluation failed: ' + code, {cause: error}); }
          };
          const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
          async function wait(code) {
            const until = Date.now() + 7000;
            while (Date.now() < until) {
              if (await evaluate(code)) return;
              await delay(20);
            }
            throw new Error('Timed out: ' + code + '\\n' + await evaluate('document.body.innerText'));
          }
          const card = 'document.querySelector(\\'.agent-message-stage article[data-agent-message-id="reminder-1"]\\')';
          const tile = 'document.querySelector(\\'.agent-message-slider article[data-agent-message-id="reminder-1"]\\')';
          const click = label => evaluate('Array.from(' + card + '.querySelectorAll("button")).find(button => button.textContent.trim() === ' + JSON.stringify(label) + ').click()');
          const clickPreview = label => evaluate(tile + '.querySelector(' + JSON.stringify('[aria-label="' + label + '"]') + ').click()');
          const dialog = 'document.querySelector("dialog[open]")';
          const clickDialog = label => evaluate('Array.from(' + dialog + '.querySelectorAll("button")).find(button => (button.getAttribute("aria-label") || button.textContent.trim()) === ' + JSON.stringify(label) + ').click()');
          const enterCustom = value => evaluate('(() => { const input = ' + dialog + '.querySelector("input"); input.value = ' + JSON.stringify(value) + '; input.dispatchEvent(new Event("input", {bubbles:true})); })()');
          const escape = async () => {
            window.webContents.sendInputEvent({type:'keyDown', keyCode:'Escape'});
            window.webContents.sendInputEvent({type:'keyUp', keyCode:'Escape'});
            await delay(50);
          };
          const assertPrimary = async (target, label) => {
            assert.deepEqual(await evaluate('Array.from(' + target + '.querySelectorAll(".primary-action")).map(button => button.getAttribute("aria-label"))'), label ? [label] : []);
            if (label) {
              const style = await evaluate('(() => { const button = ' + target + '.querySelector(".primary-action"); const style = getComputedStyle(button); return {background: style.backgroundColor, border: style.borderColor, color: style.color, icon: getComputedStyle(button.querySelector(".codicon")).color}; })()');
              assert.deepEqual(style, {background: 'rgba(0, 0, 0, 0)', border: 'rgb(189, 31, 102)', color: 'rgb(189, 31, 102)', icon: 'rgb(189, 31, 102)'});
            }
          };
          await window.loadURL('http://127.0.0.1:${address.port}/reminders-test.html');
          await wait(tile);
          assert.equal(await evaluate('document.querySelectorAll(' + JSON.stringify('article[data-agent-message-id="reminder-1"]') + ').length'), 1);
          assert.equal(await evaluate('document.querySelector(".agent-message-stage")'), null);
          assert.equal(await evaluate('document.querySelectorAll(".agent-message-tile").length'), 5);
          const slider = await evaluate('(() => { const s = document.querySelector(".agent-message-slider"); return {width: s.clientWidth, scrollWidth: s.scrollWidth, tileWidth: s.querySelector(".agent-message-tile").getBoundingClientRect().width}; })()');
          assert.ok(Math.abs(slider.tileWidth - 240) < 1);
          assert.ok(slider.scrollWidth > slider.width);
          assert.equal(await evaluate('getComputedStyle(' + tile + ').borderLeftColor'), 'rgb(163, 163, 163)');
          assert.deepEqual(await evaluate('Array.from(' + tile + '.querySelectorAll(".message-actions button")).map(button => button.getAttribute("aria-label"))'),
            ['Acknowledge', 'Resolve', 'Snooze', 'Show full alert']);
          assert.equal(await evaluate('Array.from(document.querySelectorAll(".agent-message-slider .message-actions button")).every(button => button.textContent.trim() === "" && button.title === button.getAttribute("aria-label") && button.querySelector(".codicon[aria-hidden=true]") && button.getBoundingClientRect().width >= 30)'), true);
          assert.equal(await evaluate(tile + '.querySelector("[aria-label=Acknowledge] .codicon-verified") !== null'), true);
          assert.equal(await evaluate(tile + '.querySelector("[aria-label=Resolve] .codicon-archive") !== null'), true);
          await assertPrimary(tile, 'Acknowledge');
          await evaluate('document.fonts.ready');
          assert.equal(await evaluate('getComputedStyle(' + tile + '.querySelector(".codicon"), "::before").content.length > 2'), true);
          assert.equal(await evaluate('document.fonts.check("16px codicon")'), true);
          await clickPreview('Acknowledge');
          await wait(tile + '.querySelector("[aria-label=Reopen]")');
          await assertPrimary(tile, 'Resolve');
          await clickPreview('Reopen');
          await wait(tile + '.querySelector("[aria-label=Acknowledge]")');
          await assertPrimary(tile, 'Acknowledge');
          assert.equal(await evaluate('document.querySelector(".agent-message-stage")'), null);
          const approvalTile = 'document.querySelector(\\'.agent-message-slider article[data-agent-message-id="message-approval"]\\')';
          assert.equal(await evaluate(approvalTile + '.querySelector("[aria-label=\\'Record rejected\\']").disabled'), true);
          await evaluate('const recorder = ' + approvalTile + '.querySelector("input"); recorder.value = "Human"; recorder.dispatchEvent(new Event("input", {bubbles:true}));');
          await evaluate(approvalTile + '.querySelector("[aria-label=\\'Record rejected\\']").click()');
          await wait(approvalTile + '.querySelector(".approval-decision")?.textContent.includes("rejected")');
          await evaluate('window.__reminderTest.clearDecision()');
          assert.ok(await evaluate('(() => { const s = document.querySelector(".agent-message-slider"); s.scrollLeft = 100; return s.scrollLeft > 0; })()'));
          await evaluate(tile + '.querySelector(".show-full-alert").click()');
          await wait(card);
          await evaluate('document.querySelector(\\'.agent-message-slider article[data-agent-message-id="message-completion"] .show-full-alert\\').click()');
          await wait('document.querySelector(".agent-message-stage").textContent.includes("Details for completion")');
          assert.equal(await evaluate('document.querySelectorAll(".agent-message-stage").length'), 1);
          assert.equal(await evaluate('document.querySelector(".agent-message-stage .message-time").textContent'), 'Received 3 minutes ago');
          assert.equal(await evaluate('document.querySelector(".agent-message-stage").textContent.includes("Snooze")'), false);
          const completionTile = 'document.querySelector(\\'.agent-message-slider article[data-agent-message-id="message-completion"]\\')';
          for (const [action, label] of [['Acknowledge', 'Acknowledged'], ['Resolve', 'Resolved'], ['Reopen', 'Received 3 minutes ago']]) {
            await evaluate('document.querySelector(".agent-message-stage [aria-label=' + action + ']").click()');
            await wait('document.querySelector(".agent-message-stage .message-time").textContent === ' + JSON.stringify(label));
            assert.equal(await evaluate(completionTile + '.querySelector(".message-time").textContent'), label);
          }
          await evaluate('document.querySelector(\\'.agent-message-slider article[data-agent-message-id="message-approval"] .show-full-alert\\').click()');
          await wait('document.querySelector(".agent-message-stage .approval-notice")');
          await evaluate('const input = document.querySelector(".agent-message-stage input"); input.value = "Human"; input.dispatchEvent(new Event("input", {bubbles:true}));');
          await evaluate('document.querySelector(".agent-message-stage [aria-label=\\'Record approved\\']").click()');
          await wait('document.querySelector(".agent-message-stage .approval-decision")?.textContent.includes("approved")');
          await evaluate('document.querySelector(\\'.agent-message-slider article[data-agent-message-id="message-error"] .show-full-alert\\').click()');
          await wait('document.querySelector(".agent-message-stage").textContent.includes("Details for error")');
          assert.equal(await evaluate('getComputedStyle(document.querySelector(".agent-message-stage article")).borderLeftColor'), 'rgb(196, 43, 28)');
          await evaluate('document.querySelector(\\'.agent-message-slider article[data-agent-message-id="message-request"] .show-full-alert\\').click()');
          await wait('document.querySelector(".agent-message-stage").textContent.includes("Details for request")');
          assert.equal(await evaluate(card), null);
          await evaluate('document.querySelector(".stage-heading button").click()');
          await wait('!document.querySelector(".agent-message-stage")');
          await evaluate(tile + '.querySelector(".show-full-alert").click()');
          await wait(card);
          assert.equal(await evaluate('Array.from(' + card + '.querySelectorAll(".message-actions button")).every(button => button.textContent.trim() === button.getAttribute("aria-label") && button.querySelector(".codicon[aria-hidden=true]"))'), true);
          assert.equal(await evaluate(card + '.querySelector("[aria-label=Acknowledge] .codicon-verified") !== null'), true);
          assert.equal(await evaluate(card + '.querySelector("[aria-label=Resolve] .codicon-archive") !== null'), true);
          await assertPrimary(card, 'Acknowledge');
          assert.equal(await evaluate('document.querySelector(".document-reminders").contains(' + card + ')'), true);
          assert.equal(await evaluate('document.querySelector(".scope-preview").querySelector(' + JSON.stringify('[data-agent-message-id="reminder-1"]') + ')'), null);
          assert.equal(await evaluate('document.querySelector(".scope-preview").textContent.includes("Ordinary history")'), false);
          assert.equal(await evaluate('document.querySelector(".scope-preview").textContent.includes("Conversation history")'), true);
          assert.equal(await evaluate('document.querySelector(".scope-preview [data-agent-message-id]")'), null);
          assert.equal(await evaluate('document.querySelector(".reminder-list")'), null);
          const geometry = await evaluate('(() => { const c = ' + card + '; const deadline = c.querySelector(".message-time").getBoundingClientRect(); const requester = c.querySelector(".message-meta .message-from").getBoundingClientRect(); return {right: c.getBoundingClientRect().right, deadlineRight: deadline.right, deadlineTop: deadline.top, requesterRight: requester.right, requesterBottom: requester.bottom}; })()');
          assert.ok(Math.abs(geometry.right - geometry.deadlineRight - 11) < 2);
          assert.ok(Math.abs(geometry.deadlineRight - geometry.requesterRight) < 2);
          assert.ok(geometry.requesterBottom < geometry.deadlineTop);
          assert.equal(await evaluate('getComputedStyle(' + card + '.querySelector(".message-from")).fontWeight'), '400');
          assert.equal(await evaluate('getComputedStyle(' + card + '.querySelector(".message-from")).color'),
            await evaluate('(() => { const e = document.createElement("span"); e.style.color = "var(--vscode-descriptionForeground, #777)"; document.body.append(e); const color = getComputedStyle(e).color; e.remove(); return color; })()'));
          await wait(card + '.classList.contains("overdue") && ' + card + '.querySelector(".message-time").textContent.includes("ago")');
          await wait(tile + '.classList.contains("overdue")');
          assert.equal(await evaluate('getComputedStyle(' + tile + ').borderLeftColor'), 'rgb(196, 43, 28)');
          assert.equal(await evaluate(card + '.querySelector("header").textContent.includes("info")'), false);
          await evaluate('window.__reminderTest.setDeadline(Math.floor(Date.now() / 1000) - 180)');
          await wait(card + '.querySelector(".message-time").textContent === "Due 3 minutes ago"');
          await click('Acknowledge');
          await wait('!' + card + '.classList.contains("overdue") && !document.querySelector(".reminder-list")');
          await assertPrimary(card, 'Resolve');
          await assertPrimary(tile, 'Resolve');
          await evaluate(card + '.querySelector("[aria-label=Snooze]").focus()');
          await click('Snooze');
          await wait(dialog);
          assert.equal(await evaluate(dialog + '.matches(":modal")'), true);
          assert.deepEqual(await evaluate('Array.from(' + dialog + '.querySelectorAll(".presets button")).map(button => button.getAttribute("aria-label"))'),
            ['10 minutes', '1 hour', 'Tomorrow', 'Next week']);
          assert.equal(await evaluate('document.querySelector(".snooze-controls")'), null);
          await escape();
          await wait('!' + dialog);
          assert.equal(await evaluate('window.__reminderTest.calls.length'), 0);
          assert.equal(await evaluate('document.activeElement === ' + card + '.querySelector("[aria-label=Snooze]")'), true);
          await click('Snooze');
          await wait(dialog);
          await evaluate('window.__reminderTest.fail = true');
          await clickDialog('1 hour');
          await wait(dialog + '.querySelector("[role=alert]")?.textContent === "Snooze failed"');
          await evaluate('window.__reminderTest.fail = false; window.__reminderTest.hold = true');
          await clickDialog('1 hour');
          await wait(dialog + '.querySelector("button").disabled');
          await escape();
          assert.equal(await evaluate(dialog + ' !== null'), true, 'Snooze dialog must stay open while saving');
          assert.equal(await evaluate('window.__reminderTest.calls.length'), 2);
          await evaluate('window.__reminderTest.hold = false; window.__reminderTest.release()');
          await wait('!' + dialog + ' && !' + card + '.classList.contains("overdue")');
          const preset = await evaluate('window.__reminderTest.calls.at(-1)');
          assert.equal(preset.id, 'reminder-1');
          assert.ok(Math.abs(preset.dueAt - Math.floor(Date.now() / 1000) - 3600) < 3);
          await evaluate('window.__reminderTest.setDeadline(Math.floor(Date.now() / 1000) + 8 * 60 + 10)');
          await wait(card + '.querySelector(".message-time").textContent === "Due in 8 minutes"');
          await click('Snooze');
          await wait(dialog);
          await clickDialog('Custom');
          await wait(dialog + '.querySelector("input") === document.activeElement');
          assert.equal(await evaluate('Array.from(' + dialog + '.querySelectorAll("button")).some(button => button.textContent.trim() === "Custom")'), false);
          await enterCustom('not a date');
          await wait(dialog + '.querySelector("input").getAttribute("aria-invalid") === "true"');
          assert.equal(await evaluate(dialog + '.querySelector("button[type=submit]").disabled'), true);
          await enterCustom('yesterday');
          await wait(dialog + '.querySelector("#custom-snooze-preview").textContent.includes("future")');
          await enterCustom('tomorrow or Friday');
          await wait(dialog + '.querySelector("#custom-snooze-preview").textContent.includes("one date")');
          for (const invalid of ['tomorrow at 25:00', 'every day at 9am']) {
            await enterCustom(invalid);
            await wait(dialog + '.querySelector("#custom-snooze-preview").textContent.includes("entire time expression")');
            assert.equal(await evaluate(dialog + '.querySelector("input").getAttribute("aria-invalid")'), 'true');
            assert.equal(await evaluate(dialog + '.querySelector("button[type=submit]").disabled'), true);
            assert.equal(await evaluate(dialog + '.querySelector("time")'), null);
            await evaluate(dialog + '.querySelector("form").requestSubmit()');
            assert.equal(await evaluate('window.__reminderTest.calls.length'), 2);
          }
          assert.equal(await evaluate('window.__reminderTest.calls.length'), 2);
          await enterCustom('in 45 minutes');
          await wait(dialog + '.querySelector("time")');
          const customDeadline = await evaluate('Date.parse(' + dialog + '.querySelector("time").dateTime) / 1000');
          assert.ok(Math.abs(customDeadline - Math.floor(Date.now() / 1000) - 2700) < 3);
          await evaluate(dialog + '.querySelector("form").requestSubmit()');
          await wait('window.__reminderTest.calls.length === 3 && !' + dialog);
          assert.equal(await evaluate('window.__reminderTest.calls.at(-1).dueAt'), customDeadline);
          await click('Resolve');
          await wait('!' + card + '.classList.contains("overdue") && !document.querySelector(".reminder-list")');
          await assertPrimary(card, null);
          await assertPrimary(tile, null);
          assert.equal(await evaluate('Array.from(' + card + '.querySelectorAll("button")).some(button => button.textContent.trim() === "Snooze")'), false);
          assert.equal(await evaluate(tile + '.querySelector("[aria-label=Snooze]")'), null);
          await clickPreview('Reopen');
          await wait(tile + '.querySelector("[aria-label=Snooze]")');
          await assertPrimary(card, 'Acknowledge');
          await assertPrimary(tile, 'Acknowledge');
          await evaluate('document.querySelector(".stage-heading button").click()');
          await wait('!document.querySelector(".agent-message-stage")');
          await clickPreview('Snooze');
          await wait(dialog);
          assert.equal(await evaluate('(() => { const r = ' + dialog + '.getBoundingClientRect(); return r.width > 240 && r.left >= 0 && r.right <= innerWidth && r.top >= 0 && r.bottom <= innerHeight; })()'), true);
          await evaluate('window.__reminderTest.fail = true');
          await clickDialog('10 minutes');
          await wait(dialog + '.querySelector("[role=alert]")?.textContent === "Snooze failed"');
          await evaluate('window.__reminderTest.fail = false');
          await clickDialog('10 minutes');
          await wait('!' + dialog);
          assert.ok(Math.abs(await evaluate('window.__reminderTest.calls.at(-1).dueAt') - Math.floor(Date.now() / 1000) - 600) < 3);
          for (const label of ['Tomorrow', 'Next week']) {
            await clickPreview('Snooze');
            await wait(dialog);
            const expected = await evaluate('(() => { const date = new Date(); date.setDate(date.getDate() + (' + JSON.stringify(label) + ' === "Tomorrow" ? 1 : (8 - date.getDay()) % 7 || 7)); date.setHours(9,0,0,0); return date.getTime() / 1000; })()');
            await clickDialog(label);
            await wait('!' + dialog);
            assert.equal(await evaluate('window.__reminderTest.calls.at(-1).dueAt'), expected);
          }
          await clickPreview('Snooze');
          await wait(dialog);
          const beforeCancel = await evaluate('window.__reminderTest.calls.length');
          await clickDialog('Cancel');
          await wait('!' + dialog);
          assert.equal(await evaluate('window.__reminderTest.calls.length'), beforeCancel);
          assert.equal(await evaluate(tile + '.scrollWidth <= ' + tile + '.clientWidth'), true);
          await clickPreview('Resolve');
          await wait(tile + '.querySelector("[aria-label=Reopen]") && !' + tile + '.querySelector("[aria-label=Snooze]")');
          await assertPrimary(tile, null);
          console.log('reminders-browser: placement, deadline, overdue, acknowledgement, Snooze and errors passed');
          window.destroy();
          app.exit(0);
        }).catch(error => { console.error(error); app.exit(1); });
      `);
      const { stdout } = await promisify(execFile)(executable, [script], {
        timeout: 25_000, env: { ...process.env, ELECTRON_RUN_AS_NODE: '' },
      });
      expect(stdout).toContain('reminders-browser: placement, deadline, overdue, acknowledgement, Snooze and errors passed');
    } finally {
      await server.close();
      await rm(directory, { recursive: true, force: true });
    }
  }, 30_000,
);
