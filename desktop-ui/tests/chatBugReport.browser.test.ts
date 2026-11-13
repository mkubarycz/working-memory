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
  'reports a blocked running message, previews evidence, retries Feedback and discards stale capture UI',
  async () => {
    const executable: unknown = createRequire(import.meta.url)('electron');
    if (typeof executable !== 'string') throw new Error('Electron executable is unavailable.');
    const directory = await mkdtemp(join(tmpdir(), 'wm-chat-report-'));
    const fixture = `
      <script>
        import MessageEntry from '/src/renderer/MessageEntry.svelte';
        import ReportChatBugDialog from '/src/renderer/ReportChatBugDialog.svelte';
        import {createLiveRun,mergeHistoryRuns,latestChatRun} from '/src/renderer/chatHistory.ts';
        import '/src/renderer/style.css';
        let reporting = $state(null);
        const initial = {key:'blocked-run',journalId:'journal-1',status:'running',startedAt:Date.now()-86400000,
          userText:'Inspect this resource',assistantText:'Inspecting...',scope:{kind:'Topic',id:'topic-1'},attachments:[],tools:[],entityRefs:[]};
        let runs = $state([initial]);
        const run = $derived(runs[0]);
        const reportSnapshot = $derived(reporting ? latestChatRun(reporting,runs) : null);
        const test = window.__reportTest = {captures:[],preparations:[],sends:[],hold:false,fail:false};
        test.reset=()=>{reporting=null;};
        test.beginSubmission=()=>{runs=[createLiveRun('optimistic','Inspect this resource',initial.scope,Date.now())];};
        test.persistSubmission=()=>{
          const current=runs[0];
          runs=mergeHistoryRuns(runs,[{id:'new-journal',resourceVersion:1,createdAt:Date.now()/1000,
            startedAt:current.startedAt+1,status:'running',request:{userText:current.userText},primaryScope:current.scope,
            entityRefs:[],eventSummaries:[{sequence:2,timestamp:Date.now(),toolName:'pending-read',callId:'pending',status:'pending'}]}]);
        };
        test.sourceStatus=()=>runs[0].status;
        window.workingMemory = {
          createChatBugReport:async input=>{
            test.captures.push(input);
            if(test.hold) await new Promise(resolve=>{test.release=resolve;});
            return {id:'report-1',title:'Chat bug: Stalled',body:'Captured prompt and pending tool\\\\n<em>literal evidence</em>'};
          },
          prepareFeedback:async(id,requestId)=>{
            test.preparations.push({id,requestId});
            return {servers:[{id:'feedback',name:'Local feedback',address:'127.0.0.1',port:7720}],
              context:{desktop:{version:'1.11.0-dev',build:'fixture'},backend:{version:'fixture'}}};
          },
          sendFeedback:async(id,requestId,serverId)=>{
            test.sends.push({id,requestId,serverId});
            if(test.fail) throw new Error('Delivery unavailable; retry');
            return {status:'sent',receipt:{statusUrl:'http://localhost:7722/status/report-1',topicId:'received',title:'Stalled',duplicate:false}};
          },
        };
        const noop=()=>{};
      </script>
      <MessageEntry row={{kind:'run',key:run.key,timestamp:run.startedAt,run}} humanName="You" unreadResponses={[]}
        onOpen={noop} onInspect={noop} onResolve={noop} onFocus={noop} onViewed={noop}
        onSetAgentMessageStatus={noop} attachmentUrl={()=>''} assistantFallback={()=>'Running'}
        onRetry={noop} runBlocked={()=>true}
        onReportBug={value=>{reporting=value;}} />
      {#if reportSnapshot}
        <ReportChatBugDialog run={reportSnapshot} conversationBlocked={true} localRequestActive={false}
          onClose={()=>{reporting=null;}} />
      {/if}
    `;
    const server = await createServer({
      configFile: false, root: fileURLToPath(new URL('..', import.meta.url)), cacheDir: join(directory, 'vite-cache'),
      optimizeDeps: { include: ['svelte', 'markdown-it', 'chrono-node'] },
      plugins: [{
        name: 'chat-report-fixture',
        resolveId: id => ['/report-fixture.svelte', '/report-fixture.js'].includes(id) ? `\0${id.slice(1)}` : undefined,
        load: id => id === '\0report-fixture.svelte' ? fixture : id === '\0report-fixture.js'
          ? 'import {mount} from "svelte"; import Fixture from "/report-fixture.svelte"; mount(Fixture,{target:document.querySelector("main")});'
          : undefined,
        configureServer(server) {
          server.middlewares.use((request, response, next) => {
            if (request.url !== '/report-test.html') { next(); return; }
            response.setHeader('content-type', 'text/html');
            response.end('<!doctype html><main></main><script type="module" src="/report-fixture.js"></script>');
          });
        },
      }, svelte()], server: { host: '127.0.0.1', port: 0 }, appType: 'custom',
    });
    try {
      await server.listen();
      const address = server.httpServer?.address();
      if (!address || typeof address === 'string') throw new Error('Chat report fixture did not bind.');
      const script = join(directory, 'report-test.cjs');
      await writeFile(script, `
        const {app,BrowserWindow}=require('electron');
        const assert=require('node:assert/strict');
        app.setPath('userData',${JSON.stringify(join(directory, 'profile'))});
        app.whenReady().then(async()=>{
          const win=new BrowserWindow({show:false,width:1000,height:850});
          win.webContents.on('console-message',(_event,level,message)=>{if(level>=2)console.error(message);});
          const evaluate=code=>win.webContents.executeJavaScript(code);
          const button=label=>'Array.from(document.querySelectorAll("button")).find(b=>b.textContent.trim()==='+JSON.stringify(label)+')';
          const click=label=>evaluate(button(label)+'.click()');
          async function wait(code) {
            for(let i=0;i<200;i++){
              if(await evaluate('Boolean('+code+')'))return;
              await new Promise(resolve=>setTimeout(resolve,25));
            }
            throw new Error('Timed out: '+code+'\\\\n'+await evaluate('document.body.innerText'));
          }
          const describe=()=>evaluate('(()=>{const t=document.querySelector("textarea");t.value="Stalled for hours";t.dispatchEvent(new Event("input",{bubbles:true}));})()');
          await win.loadURL('http://127.0.0.1:${address.port}/report-test.html');
          await wait('document.querySelector(".report-bug-link")');
          assert.equal(await evaluate('document.querySelector(".report-bug-link").disabled'),false);
          await click('Report a bug');
          await wait('document.querySelector("dialog:modal")');
          assert(await evaluate('document.body.innerText.includes("What was the bug?")'));
          assert.equal(await evaluate(button('Create report')+'.disabled'),true);
          await describe();
          await wait('!'+button('Create report')+'.disabled');
          await click('Create report');
          await wait('window.__reportTest.preparations.length===1');
          await wait('document.querySelector("details pre")');
          assert.equal(await evaluate('document.querySelector("details pre").querySelector("em")'),null);
          assert.equal(await evaluate('window.__reportTest.captures[0].run.status'),'running');
          assert.equal(await evaluate('window.__reportTest.captures[0].renderer.conversationBlocked'),true);
          assert.equal(await evaluate('window.__reportTest.captures[0].renderer.localRequestActive'),false);
          assert.equal(await evaluate('window.__reportTest.sends.length'),0);
          await evaluate('window.__reportTest.fail=true');
          await click('Send');
          await wait('document.querySelector("[role=alert]")?.textContent.includes("Delivery unavailable")');
          await evaluate('window.__reportTest.fail=false');
          await click('Send');
          await wait(button('Done'));
          const sends=await evaluate('window.__reportTest.sends');
          assert.equal(sends.length,2);
          assert.equal(sends[0].requestId,sends[1].requestId);
          assert.equal(sends[0].id,'report-1');
          await click('Done');
          await wait('!document.querySelector("dialog")');
          await evaluate('window.__reportTest.beginSubmission()');
          await click('Report a bug');
          await describe();
          await evaluate('window.__reportTest.persistSubmission()');
          await click('Create report');
          await wait('window.__reportTest.preparations.length===2');
          assert.equal(await evaluate('window.__reportTest.captures[1].run.journalId'),'new-journal');
          assert.equal(await evaluate('window.__reportTest.captures[1].run.tools[0].toolName'),'pending-read');
          assert.equal(await evaluate('window.__reportTest.sourceStatus()'),'running');
          await click('Cancel');
          await wait('!document.querySelector("dialog")');
          await evaluate('window.__reportTest.hold=true');
          await click('Report a bug');
          await describe();
          await click('Create report');
          await wait('typeof window.__reportTest.release==="function"');
          await evaluate('window.__reportTest.reset();window.__reportTest.release()');
          await wait('!document.querySelector("dialog")');
          await new Promise(resolve=>setTimeout(resolve,100));
          assert.equal(await evaluate('window.__reportTest.preparations.length'),2);
          assert.equal(await evaluate('document.querySelectorAll(".report-bug-link").length'),1);
          console.log('CHAT_REPORT_UI_OK'); win.destroy(); app.exit(0);
        }).catch(error=>{console.error(error);app.exit(1);});
      `);
      const { ELECTRON_RUN_AS_NODE: _nodeMode, ...env } = process.env;
      const result = await promisify(execFile)(executable, [script, '--no-sandbox'], {
        env, timeout: 35000, maxBuffer: 2 * 1024 * 1024,
      });
      expect(result.stdout).toContain('CHAT_REPORT_UI_OK');
    } finally { await server.close(); await rm(directory, { recursive: true, force: true }); }
  }, 60000,
);
