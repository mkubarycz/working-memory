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
  'uses the actual global footer offline and with a selected search, snapshots through IPC, retries and preserves drafts',
  async () => {
    const executable: unknown = createRequire(import.meta.url)('electron');
    if (typeof executable !== 'string') throw new Error('Electron executable is unavailable.');
    const directory = await mkdtemp(join(tmpdir(), 'wm-session-report-'));
    const preload = join(directory, 'preload.cjs');
    const reportsModule = join(directory, 'reports.cjs');
    await build({ entryPoints: [fileURLToPath(new URL('../src/main/sessionBugReport.ts', import.meta.url))],
      outfile: reportsModule, bundle: true, platform: 'node', format: 'cjs', external: ['electron'] });
    await build({ stdin: { contents: `
      const {contextBridge,ipcRenderer}=require('electron');
      const {toIpcPayload}=require(${JSON.stringify(fileURLToPath(new URL('../src/preload/ipcPayload.ts', import.meta.url)))});
      contextBridge.exposeInMainWorld('sessionReportBridge',{
        capture:input=>ipcRenderer.invoke('test:capture',toIpcPayload(input)),
        describe:(id,text)=>ipcRenderer.invoke('test:describe',id,text),
      });`, resolveDir: fileURLToPath(new URL('..', import.meta.url)) },
    outfile: preload, bundle: true, platform: 'node', format: 'cjs', external: ['electron'] });
    const fixture = `
      import {mount} from 'svelte';
      import App from '/src/renderer/App.svelte';
      import '/src/renderer/style.css';
      const connected=new URL(location.href).searchParams.has('connected');
      const environment={id:'session-test',port:7717,displayName:'Session test',mcpUrl:'http://127.0.0.1:7717/mcp',source:'sandbox'};
      const test=window.__sessionTest={captures:[],descriptions:[],preparations:[],sends:[],failSend:false,captureError:false,settingsError:false,saves:[]};
      if(connected)localStorage.setItem('working-memory.desktop.document-tabs:v1:session-test',JSON.stringify({
        version:1,tabs:[{kind:'search',identifier:'document-search'}],selectedKey:'search:document-search'}));
      const model={kind:'topic',id:'topic-1',title:'Original title',body:'UNSAVED_PRIVATE_DOCUMENT',
        status:'open',createdAt:1,updatedAt:1,closure:null,resourceVersion:1,editable:true,
        topics:[],tree:[],agentMessages:[],parents:[],children:[],workstreams:[],focusedWorkstreams:[],topicTypes:[]};
      window.workingMemory={
        getDesktopBuildInfo:async()=>({version:'fixture',development:true}),
        getConfig:async()=>({endpoint:'',model:'',hasApiKey:false,credentialStorage:'session',humanName:'',profiles:[],routing:{}}),
        discoverEnvironments:async()=>({environments:connected?[environment]:[],selected:connected?environment:null}),
        getInstanceIdentity:async()=>({environment:'http://127.0.0.1:7717',passwordConfigured:true,passwordHint:'',setupAvailable:false,authenticated:connected}),
        onInstanceAuthenticationChanged:()=>()=>{},
        onOpenResource:listener=>{test.open=listener;return()=>{};},
        onDocumentChanges:()=>()=>{},onResourceDragResult:()=>()=>{},
        getBackendHealth:async()=>({state:'unreachable',endpoint:environment.mcpUrl,result:'Backend offline',observedAt:Date.now(),source:'sandbox'}),
        getActivePanel:async()=>({tab:'active',items:[],emptyMessage:'No active workstreams.'}),
        getChatHistory:async()=>({journals:[]}),getAgentMessages:async()=>[],
        listContainerApps:async()=>[],getInstanceFeatures:async()=>({hostTasks:false,search:true,topicPlacementAutoLoad:false}),
        getRelatedTopics:async()=>({topics:[],state:'ready'}),
        getInstanceAccess:async()=>({requests:[],clients:[]}),startDocumentChanges:async()=>{},
        getOpenAiHealth:async()=>({ok:false,message:'No model configured'}),
        openResource:async()=>model,
        saveTopic:async(id,patch)=>{test.saves.push({id,patch});await new Promise(resolve=>{test.finishSave=()=>resolve(model);});return model;},
        onDocumentSearchTrace:()=>()=>{},onDocumentSearchResults:()=>()=>{},
        getPublicFeedbackSettings:async()=>{if(test.settingsError)throw new Error('Settings unavailable');return {enabled:true,destination:'https://fixture.blob.core.windows.net/feedback'};},
        captureSessionBugReport:async input=>{
          test.captures.push(input);
          if(test.captureError)throw new Error('Diagnostic capture unavailable');
          return window.sessionReportBridge.capture(input);
        },
        describeSessionBugReport:async(id,text)=>{const draft=await window.sessionReportBridge.describe(id,text);test.descriptions.push(draft);return draft;},
        prepareFeedback:async(id,requestId)=>{test.preparations.push({id,requestId});return {servers:[{id:'public',name:'Feedback',address:'fixture.blob.core.windows.net',delivery:'public-inbox'}],
          context:{desktop:{version:'fixture',build:'fixture'},backend:{version:'Unknown'}}};},
        sendFeedback:async(id,requestId,serverId)=>{test.sends.push({id,requestId,serverId});if(test.failSend)throw new Error('Upload unavailable');return {status:'queued',requestId,uploadedAt:new Date().toISOString(),destination:'fixture.blob.core.windows.net'};},
      };
      mount(App,{target:document.body});
    `;
    const server = await createServer({
      configFile: false, root: fileURLToPath(new URL('..', import.meta.url)), cacheDir: join(directory, 'vite-cache'),
      optimizeDeps: { include: ['svelte', '@codemirror/commands', '@codemirror/lang-markdown', '@codemirror/language',
        '@lezer/highlight', '@lezer/markdown', '@codemirror/state', '@codemirror/view',
        '@codemirror/lang-javascript', '@codemirror/lang-json', 'chrono-node', 'markdown-it', 'turndown', 'zod'] },
      plugins: [svelte(), {
        name: 'session-report-fixture',
        resolveId: id => id === '/session-fixture.js' ? '\0session-fixture' : undefined,
        load: id => id === '\0session-fixture' ? fixture : undefined,
        configureServer(server) {
          server.middlewares.use((req, res, next) => {
            if (!req.url?.startsWith('/session-test.html')) { next(); return; }
            res.setHeader('content-type', 'text/html');
            res.end('<!doctype html><html><body><script type="module" src="/session-fixture.js"></script></body></html>');
          });
        },
      }], server: { host: '127.0.0.1', port: 0, fs: { allow: [
        fileURLToPath(new URL('../..', import.meta.url)),
        fileURLToPath(new URL('../../..', import.meta.url)),
      ] } }, appType: 'custom',
    });
    try {
      await server.listen();
      const address = server.httpServer?.address();
      if (!address || typeof address === 'string') throw new Error('Session fixture did not bind.');
      const script = join(directory, 'main.cjs');
      await writeFile(script, `
        const {app,BrowserWindow,ipcMain}=require('electron');
        const {SessionBugReports}=require(${JSON.stringify(reportsModule)});
        const assert=require('node:assert/strict');
        const reports=new SessionBugReports();
        ipcMain.handle('test:capture',(_event,input)=>reports.capture(input,{
          secrets:['PRIVATE_MODEL_KEY'],uptimeSeconds:120,diagnostics:()=>({activeRunsOnThisDesktop:0}),
          environment:{desktopVersion:'fixture',desktopBuild:'fixture',backendUrl:null,platform:process.platform,arch:process.arch,processId:process.pid},
          upgradeFailure:()=>undefined,
        }));
        ipcMain.handle('test:describe',(_event,id,text)=>reports.describe(id,text));
        app.setPath('userData',${JSON.stringify(join(directory, 'profile'))});
        app.whenReady().then(async()=>{
          const win=new BrowserWindow({show:false,width:1400,height:900,webPreferences:{preload:${JSON.stringify(preload)},contextIsolation:true,nodeIntegration:false}});
          win.webContents.on('console-message',event=>console.error(event.message));
          const evaluate=code=>win.webContents.executeJavaScript(code);
          const button=label=>'Array.from(document.querySelectorAll("button")).find(b=>b.textContent.trim()==='+JSON.stringify(label)+')';
          const click=label=>evaluate(button(label)+'.click()');
          async function wait(code){for(let i=0;i<400;i++){if(await evaluate('Boolean('+code+')'))return;await new Promise(resolve=>setTimeout(resolve,25));}
            throw new Error('Timed out: '+code+'\\\\n'+await evaluate('document.body.innerText'));}
          const describe=text=>evaluate('(()=>{const t=document.querySelector("#bug-description");t.value='+JSON.stringify(text)+';t.dispatchEvent(new Event("input",{bubbles:true}));})()');
          await win.loadURL('http://127.0.0.1:${address.port}/session-test.html');
          await wait('document.querySelector(".desktop-status-bar .session-report-link")');
          assert.equal(await evaluate('document.querySelectorAll(".session-report-link").length'),1);
          assert.equal(await evaluate('document.querySelector(".session-report-link .codicon-bug") !== null'),true);
          assert.equal(await evaluate('document.querySelector(".desktop-status-bar").getBoundingClientRect().bottom <= innerHeight'),true);
          await evaluate('document.querySelector(".session-report-link").focus()');
          assert.equal(await evaluate('document.activeElement.textContent.trim()'),'Report Bug');
          await click('Report Bug');
          await wait('window.__sessionTest.captures.length===1 && document.querySelector("dialog:modal")');
          assert.equal(await evaluate('window.__sessionTest.captures[0].operation'),null);
          assert.equal(await evaluate('window.__sessionTest.captures[0].renderer.authenticated'),false);
          assert.equal(await evaluate('window.__sessionTest.descriptions.length'),0);
          assert.equal(await evaluate('window.__sessionTest.sends.length'),0);
          await wait('document.querySelector("dialog .warning").innerText.includes("reports are uploaded to Azure")');
          assert.equal(await evaluate(button('Send bug report')+'.disabled'),true);
          await describe('Cannot connect PRIVATE_MODEL_KEY wm-attachment:abc');
          await wait('!'+button('Send bug report')+'.disabled');
          await evaluate('window.__sessionTest.failSend=true');
          await click('Send bug report');
          await wait('document.querySelector("dialog [role=alert]")?.textContent.includes("Upload unavailable")');
          await evaluate('window.__sessionTest.failSend=false');
          await click('Send bug report');
          await wait(button('Done'));
          const sends=await evaluate('window.__sessionTest.sends');
          assert.deepEqual(sends[0],sends[1]);
          assert.equal(await evaluate('window.__sessionTest.preparations.length'),1);
          assert.equal(await evaluate('window.__sessionTest.descriptions.length'),1);
          assert.equal(await evaluate('document.querySelector("dialog").innerText.includes("Queued for the Feedback receiver")'),true);
          assert.equal(await evaluate('document.querySelector("dialog").innerText.includes("No topic was created")'),true);
          const body=await evaluate('window.__sessionTest.descriptions[0].body');
          assert(!body.includes('PRIVATE_MODEL_KEY'));assert(!body.includes('wm-attachment:'));
          await click('Done');
          await wait('!document.querySelector("dialog")');
          await evaluate('window.__sessionTest.settingsError=true;window.__sessionTest.captureError=true');
          await click('Report Bug');
          await wait('document.querySelector("dialog").innerText.includes("Diagnostic capture unavailable") && document.querySelector("dialog").innerText.includes("Settings unavailable")');
          await describe('Test retry');
          assert.equal(await evaluate(button('Send bug report')+'.disabled'),true);
          await evaluate('window.__sessionTest.settingsError=false;window.__sessionTest.captureError=false');
          await click('Retry delivery settings');await click('Retry diagnostic capture');
          await wait('!'+button('Send bug report')+'.disabled');
          const sendsBeforePreview=await evaluate('window.__sessionTest.sends.length');
          await click('Preview report');
          await wait('document.querySelector("#share-topic-title") && !'+button('Send')+'.disabled');
          assert.equal(await evaluate('window.__sessionTest.sends.length'),sendsBeforePreview);
          assert.equal(await evaluate('document.querySelector("dialog").innerText.includes("Nothing is written to the affected backend")'),true);
          await click('Cancel');await wait('!document.querySelector("dialog")');
          await win.loadURL('http://127.0.0.1:${address.port}/session-test.html?connected=1');
          await wait('document.querySelector("#document-search-prompt")');
          await evaluate('(()=>{const t=document.querySelector("#document-search-prompt");t.value="Selected search PRIVATE_MODEL_KEY";t.dispatchEvent(new Event("input",{bubbles:true}));})()');
          await click('Report Bug');
          await wait('window.__sessionTest.captures.length===1');
          assert.equal(await evaluate('window.__sessionTest.captures[0].operation.kind'),'search');
          await evaluate('(()=>{const t=document.querySelector("#document-search-prompt");t.value="Changed after capture";t.dispatchEvent(new Event("input",{bubbles:true}));})()');
          await describe('Wrong search result');
          await click('Send bug report');await wait(button('Done'));
          assert.equal(await evaluate('window.__sessionTest.descriptions[0].body.includes("Selected search")'),true);
          assert.equal(await evaluate('window.__sessionTest.descriptions[0].body.includes("PRIVATE_MODEL_KEY")'),false);
          assert.equal(await evaluate('window.__sessionTest.descriptions[0].body.includes("Changed after capture")'),false);
          await click('Done');await wait('!document.querySelector("dialog")');
          await evaluate('window.__sessionTest.open({kind:"topic",identifier:"topic-1"})');
          await wait('document.querySelector(".title-input")');
          assert.equal(await evaluate('document.querySelector(".feedback-button")'),null);
          await evaluate('(()=>{const t=document.querySelector(".title-input");t.value="Unsaved title";t.dispatchEvent(new Event("input",{bubbles:true}));})()');
          await wait('window.__sessionTest.saves.length===1');
          await click('Report Bug');await wait('window.__sessionTest.captures.length===2');
          assert.equal(await evaluate('JSON.stringify(window.__sessionTest.captures[1]).includes("UNSAVED_PRIVATE_DOCUMENT")'),false);
          await click('Cancel');await wait('!document.querySelector("dialog")');
          assert.equal(await evaluate('document.querySelector(".title-input").value'),'Unsaved title');
          assert.equal(await evaluate('window.__sessionTest.saves.length'),1);
          win.destroy();app.quit();
        }).catch(error=>{console.error(error);app.exit(1);});
      `);
      const { stdout, stderr } = await promisify(execFile)(executable, [script], {
        timeout: 90_000, env: { ...process.env, ELECTRON_RUN_AS_NODE: '' },
      });
      expect(`${stdout}\n${stderr}`).not.toContain('AssertionError');
    } finally {
      await server.close();
      await rm(directory, { recursive: true, force: true });
    }
  },
  120_000,
);
