import { expect, it } from 'vitest';
import { build } from 'esbuild';
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
  'reports over a real native dashboard, previews evidence, retries Feedback and discards stale capture UI',
  async () => {
    const executable: unknown = createRequire(import.meta.url)('electron');
    if (typeof executable !== 'string') throw new Error('Electron executable is unavailable.');
    const directory = await mkdtemp(join(tmpdir(), 'wm-chat-report-'));
    const preload = join(directory, 'native-surface-preload.cjs');
    await build({
      stdin: {
        contents: `
          const {contextBridge,ipcRenderer}=require('electron');
          contextBridge.exposeInMainWorld('nativeSurfaceTest',{
            mount:(id,bounds)=>ipcRenderer.invoke('surface-test:mount',id,bounds),
            resize:(id,bounds)=>ipcRenderer.invoke('surface-test:resize',id,bounds),
            visible:(id,visible)=>ipcRenderer.invoke('surface-test:visible',id,visible),
            close:id=>ipcRenderer.invoke('surface-test:close',id),
          });
        `,
      },
      outfile: preload, bundle: true, platform: 'node', format: 'cjs', external: ['electron'],
    });
    const fixture = `
      <script>
        import MessageEntry from '/src/renderer/MessageEntry.svelte';
        import ReportChatBugDialog from '/src/renderer/ReportChatBugDialog.svelte';
        import ContainerAppSurface from '/src/renderer/ContainerAppSurface.svelte';
        import {tick} from 'svelte';
        import {createLiveRun,mergeHistoryRuns,latestChatRun,reconcileLiveRun,summaryToChatRun} from '/src/renderer/chatHistory.ts';
        import {mergeScopedHistory} from '/src/renderer/scopedChat.ts';
        import '/src/renderer/style.css';
        let reporting = $state(null);
        let showSurface = $state(true);
        const initial = {key:'blocked-run',journalId:'journal-1',status:'running',startedAt:Date.now()-86400000,
          userText:'Inspect this resource',assistantText:'Inspecting...',scope:{kind:'Topic',id:'topic-1'},attachments:[],tools:[],entityRefs:[]};
        let runs = $state([initial]);
        let cached = $state([]);
        const run = $derived(runs.at(-1));
        const reportSnapshot = $derived(reporting ? latestChatRun(reporting,mergeScopedHistory(runs,cached)) : null);
        const test = window.__reportTest = {captures:[],preparations:[],sends:[],hold:false,fail:false,surfaceVisible:true,surfaceMounted:false};
        test.reset=()=>{reporting=null;};
        test.remountSurface=async()=>{
          showSurface=false;await tick();test.surfaceMounted=false;showSurface=true;await tick();
        };
        test.beginSubmission=()=>{
          const now=Date.now();
          runs=[{...initial,startedAt:now-2000,status:'failed'},
            createLiveRun('optimistic','Inspect this resource',initial.scope,now)];
        };
        test.persistSubmission=()=>{
          const current=runs.at(-1);
          runs=mergeHistoryRuns(runs,[{id:'new-journal',resourceVersion:1,createdAt:Date.now()/1000,
            startedAt:current.startedAt+5000,status:'running',request:{userText:current.userText},primaryScope:current.scope,
            entityRefs:[],eventSummaries:[{sequence:2,timestamp:Date.now(),toolName:'pending-read',callId:'pending',status:'pending'}]}]);
        };
        test.sourceStatus=()=>runs.at(-1).status;
        test.stageLiveFailure=()=>{
          const current=runs.at(-1);
          const persisted={id:current.journalId,resourceVersion:5,createdAt:Date.now()/1000,
            startedAt:current.startedAt,status:'running',request:{userText:current.userText},primaryScope:current.scope,
            entityRefs:[],eventSummaries:[]};
          cached=[persisted];
          runs=reconcileLiveRun([summaryToChatRun(persisted)],persisted.id,{
            journalId:persisted.id,status:'failed',message:'Confirmation request failed: connection lost'});
        };
        window.workingMemory = {
          mountContainerAppSurface:async(_appId,id,bounds)=>{
            await window.nativeSurfaceTest.mount(id,bounds);
            test.surfaceMounted=true;
          },
          resizeContainerAppSurface:(id,bounds)=>window.nativeSurfaceTest.resize(id,bounds),
          setContainerAppSurfaceVisible:async(id,visible)=>{
            await window.nativeSurfaceTest.visible(id,visible);test.surfaceVisible=visible;
          },
          closeContainerAppSurface:id=>window.nativeSurfaceTest.close(id),
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
            if(test.queue) return {status:'queued',requestId,uploadedAt:new Date().toISOString(),destination:'test.blob.core.windows.net'};
            return {status:'sent',receipt:{statusUrl:'http://localhost:7722/status/report-1',topicId:'received',title:'Stalled',duplicate:false}};
          },
        };
        const noop=()=>{};
      </script>
      <div style="height:250px;width:700px">
        {#if showSurface}<ContainerAppSurface appId="observability" title="Test OpenObserve" />{/if}
      </div>
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
        const {app,BrowserWindow,WebContentsView,ipcMain}=require('electron');
        const assert=require('node:assert/strict');
        app.setPath('userData',${JSON.stringify(join(directory, 'profile'))});
        app.whenReady().then(async()=>{
          const win=new BrowserWindow({show:false,width:1000,height:850,
            webPreferences:{preload:${JSON.stringify(preload)},contextIsolation:true,nodeIntegration:false}});
          let native;
          let nativeId;
          const bounds=value=>({x:Math.round(value.x),y:Math.round(value.y),width:Math.round(value.width),height:Math.round(value.height)});
          ipcMain.handle('surface-test:mount',async(_event,id,rect)=>{
            nativeId=id;
            native=new WebContentsView({webPreferences:{contextIsolation:true,nodeIntegration:false,sandbox:true}});
            native.setBounds(bounds(rect));
            await native.webContents.loadURL('data:text/html,<body style="background:%2388aa88">Synthetic OpenObserve native surface</body>');
            win.contentView.addChildView(native);
          });
          ipcMain.handle('surface-test:resize',(_event,id,rect)=>{if(nativeId===id)native.setBounds(bounds(rect));});
          ipcMain.handle('surface-test:visible',(_event,id,visible)=>{if(nativeId===id)native.setVisible(visible);});
          ipcMain.handle('surface-test:close',(_event,id)=>{
            if(nativeId!==id)return;
            win.contentView.removeChildView(native);native.webContents.close();nativeId=null;
          });
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
          await wait('window.__reportTest.surfaceMounted');
          assert.equal(native.getVisible(),true);
          assert.equal(await evaluate('document.querySelector(".report-bug-link").disabled'),false);
          await click('Bug Report');
          await wait('document.querySelector("dialog:modal")');
          await wait('window.__reportTest.surfaceVisible===false');
          assert.equal(native.getVisible(),false);
          assert(await evaluate('document.body.innerText.includes("What was the bug?")'));
          assert.equal(await evaluate(button('Send bug report')+'.disabled'),true);
          await evaluate('window.__reportTest.remountSurface()');
          await wait('window.__reportTest.surfaceMounted');
          assert.equal(native.getVisible(),false);
          await click('Cancel');
          await wait('!document.querySelector("dialog")');
          await wait('window.__reportTest.surfaceVisible===true');
          assert.equal(native.getVisible(),true);
          await click('Bug Report');
          await wait('window.__reportTest.surfaceVisible===false');
          assert.equal(native.getVisible(),false);
          await describe();
          await wait('!'+button('Send bug report')+'.disabled');
          await evaluate('window.__reportTest.fail=true');
          await click('Send bug report');
          await wait('window.__reportTest.preparations.length===1');
          await wait('document.querySelector("details pre")');
          assert.equal(native.getVisible(),false);
          assert.equal(await evaluate('document.querySelector("details pre").querySelector("em")'),null);
          assert.equal(await evaluate('window.__reportTest.captures[0].run.status'),'running');
          assert.equal(await evaluate('window.__reportTest.captures[0].renderer.conversationBlocked'),true);
          assert.equal(await evaluate('window.__reportTest.captures[0].renderer.localRequestActive'),false);
          await wait('document.querySelector("[role=alert]")?.textContent.includes("Delivery unavailable")');
          await evaluate('window.__reportTest.fail=false');
          await click('Send bug report');
          await wait(button('Done'));
          const sends=await evaluate('window.__reportTest.sends');
          assert.equal(sends.length,2);
          assert.equal(sends[0].requestId,sends[1].requestId);
          assert.equal(sends[0].id,'report-1');
          assert.equal(await evaluate('window.__reportTest.captures.length'),1);
          await click('Done');
          await wait('!document.querySelector("dialog")');
          await wait('window.__reportTest.surfaceVisible===true');
          assert.equal(native.getVisible(),true);
          await evaluate('window.__reportTest.beginSubmission()');
          await click('Bug Report');
          await describe();
          await evaluate('window.__reportTest.persistSubmission()');
          await click('Send bug report');
          await wait(button('Done'));
          assert.equal(await evaluate('window.__reportTest.captures[1].run.journalId'),'new-journal');
          assert.equal(await evaluate('window.__reportTest.captures[1].run.tools[0].toolName'),'pending-read');
          assert.equal(await evaluate('window.__reportTest.sourceStatus()'),'running');
          await click('Done');
          await wait('!document.querySelector("dialog")');
          await wait('window.__reportTest.surfaceVisible===true');
          assert.equal(native.getVisible(),true);
          await evaluate('window.__reportTest.stageLiveFailure()');
          await click('Bug Report');
          await describe();
          await click('Send bug report');
          await wait(button('Done'));
          assert.equal(await evaluate('window.__reportTest.captures[2].run.status'),'failed');
          assert.equal(await evaluate('window.__reportTest.captures[2].run.assistantText'),'Confirmation request failed: connection lost');
          assert.equal(await evaluate('window.__reportTest.sourceStatus()'),'failed');
          await click('Done');
          await wait('!document.querySelector("dialog")');
          await evaluate('window.__reportTest.hold=true');
          await click('Bug Report');
          await describe();
          await click('Send bug report');
          await wait('typeof window.__reportTest.release==="function"');
          await evaluate('window.__reportTest.reset();window.__reportTest.release()');
          await wait('!document.querySelector("dialog")');
          await new Promise(resolve=>setTimeout(resolve,100));
          assert.equal(await evaluate('window.__reportTest.preparations.length'),4);
          assert.equal(await evaluate('document.querySelectorAll(".report-bug-link").length'),1);
          await evaluate('window.__reportTest.hold=false');
          const sentBeforePreview=await evaluate('window.__reportTest.sends.length');
          await click('Bug Report');
          await describe();
          await click('Preview report');
          await wait('document.querySelector("#share-topic-title")');
          await wait('document.querySelector("details pre")');
          assert.equal(await evaluate('window.__reportTest.sends.length'),sentBeforePreview);
          await click('Cancel');
          await wait('!document.querySelector("dialog")');
          await evaluate('window.__reportTest.queue=true');
          await click('Bug Report');
          await describe();
          await click('Send bug report');
          await wait(button('Done'));
          assert(await evaluate('document.querySelector("dialog [role=status]").textContent.includes("Queued for the Feedback receiver")'));
          assert.equal(await evaluate('document.querySelector("dialog a")'),null);
          await click('Done');
          await wait('!document.querySelector("dialog")');
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
