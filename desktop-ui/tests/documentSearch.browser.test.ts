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
  'searches by intent, retains results while browsing and explicitly adds to a workstream in a native dialog',
  async () => {
    const executable: unknown = createRequire(import.meta.url)('electron');
    if (typeof executable !== 'string') throw new Error('Electron executable is unavailable.');
    const directory = await mkdtemp(join(tmpdir(), 'wm-search-browser-'));
    const fixture = `
      <script>
        import SearchView from '/src/renderer/documents/SearchView.svelte';
        import ActiveRail from '/src/renderer/ActiveRail.svelte';
        import {createSearchViewState} from '/src/renderer/documentSearch.ts';
        import '/src/renderer/style.css';
        let session = $state(createSearchViewState());
        session.context={document:{id:'workstream-1',kind:'workstream',title:'Connection reliability'},workstreams:[{id:'workstream-1',title:'Connection reliability'}]};
        let active = $state('search');
        let activeDrag = $state(null);
        const test = window.__searchTest = { searches: [], adds: [], opened: [], refreshes: 0, preparations: [], nativeDrags: [], dragListeners: [] };
        test.readDrag=()=>activeDrag;
        window.workingMemory = {
          onDocumentSearchTrace: () => () => {},
          cancelDocumentSearch: async () => {},
          onResourceDragResult: listener => {
            test.dragListeners.push(listener);
            return () => {test.dragListeners=test.dragListeners.filter(candidate=>candidate!==listener);};
          },
          prepareResourceDrag: async (openUri,label) => {
            test.preparations.push({openUri,label});
            return {filename:'context.md',filePath:'/tmp/search-context.md',fileUrl:'file:///tmp/search-context.md',workstreamSection:'progress'};
          },
          startResourceDrag: prepared => {test.nativeDrags.push(prepared);},
          searchDocuments: async (query,options) => {
            test.searches.push(query);
            test.options=options;
            if (test.failSearch) throw new Error('Model unavailable');
            return {query, queries:['OAuth'], blocks:test.blocks, results:test.empty ? [] : [{
              id:'topic-1', kind:'Topic', title:'OAuth connections',
              excerpt:'The connector authenticates through a handshake.',
              reason:'Explains connection reliability and authentication.', score:1,status:'open'
            },...(test.extraResults??[])]};
          },
          listSearchWorkstreams: async () => {
            if(test.failList) throw new Error('Workstreams unavailable');
            return test.noWorkstreams ? [] : [{id:'workstream-1',title:'Connection reliability'}];
          },
          addSearchTopicToWorkstream: async (id,workstream) => {
            test.adds.push({id,workstream});
            if(test.hold) await new Promise(resolve => {test.release=resolve;});
            if(test.failAdd) throw new Error('Topic changed; retry');
          }
        };
        const noop=()=>{};
        const treeProps={environments:[],selectedEnvironment:null,environmentLoading:false,environmentError:'',
          data:null,loading:false,error:'',onRefresh:noop,onSettings:noop,onCollapse:noop,onOpen:noop,
          onToggleFocus:noop,onAction:noop,onReorder:noop,onTransferTopic:noop,onReparentTopic:noop,
          onAddTopic:noop,onAddWorkstream:noop,onMoveToNewWorkstream:noop,onOpenTopicBacklog:noop,
          onDiscoverEnvironments:noop,onSwitchEnvironment:noop,onManageInstances:noop,
          onSearch:()=>{active='search';}};
        function open(kind,id) {test.opened.push({kind,id});active='topic';}
      </script>
      <div style="display:flex;align-items:stretch">
      <aside class="active-rail" style="width:280px;flex-shrink:0;height:800px">
        <ActiveRail {...treeProps} bind:activeDrag />
      </aside>
      <div style="flex:1;min-width:0">
      {#if active === 'search'}
        <SearchView bind:state={session} bind:activeDrag onOpen={open} onAdded={() => {test.refreshes++;}} />
      {:else}
        <h1>Opened topic</h1><button onclick={() => {active='search';}}>Back to search</button>
      {/if}
      </div></div>
    `;
    const server = await createServer({
      configFile: false, root: fileURLToPath(new URL('..', import.meta.url)),
      cacheDir: join(directory, 'vite-cache'), optimizeDeps: { include: ['svelte'] },
      plugins: [{
        name: 'search-browser-fixture',
        resolveId: id => ['/search-fixture.svelte', '/search-fixture.js'].includes(id) ? `\0${id.slice(1)}` : undefined,
        load: id => id === '\0search-fixture.svelte' ? fixture
          : id === '\0search-fixture.js' ? 'import {mount} from "svelte"; import Fixture from "/search-fixture.svelte"; mount(Fixture, {target: document.querySelector("main")});'
          : undefined,
        configureServer(server) {
          server.middlewares.use((req, res, next) => {
            if (req.url !== '/search-test.html') { next(); return; }
            res.setHeader('content-type', 'text/html');
            res.end('<!doctype html><html><body style="overflow:auto"><main></main><script type="module" src="/search-fixture.js"></script></body></html>');
          });
        },
      }, svelte()],
      server: { host: '127.0.0.1', port: 0 }, appType: 'custom',
    });
    try {
      await server.listen();
      const address = server.httpServer?.address();
      if (!address || typeof address === 'string') throw new Error('Search fixture did not bind a TCP port.');
      const script = join(directory, 'search-test.cjs');
      await writeFile(script, `
        const {app,BrowserWindow}=require('electron');
        const assert=require('node:assert/strict');
        app.setPath('userData',${JSON.stringify(join(directory, 'profile'))});
        app.whenReady().then(async()=>{
          const win=new BrowserWindow({show:false,width:1100,height:850});
          const evaluate=async code=>{
            try{return await win.webContents.executeJavaScript(code);}
            catch(error){throw new Error('Renderer evaluation failed: '+code,{cause:error});}
          };
          const delay=ms=>new Promise(resolve=>setTimeout(resolve,ms));
          async function wait(code) {
            const until=Date.now()+7000;
            while(Date.now()<until){if(await evaluate('Boolean('+code+')'))return;await delay(20);}
            throw new Error('Timed out: '+code+'\\n'+await evaluate('document.body.innerText'));
          }
          const click=label=>evaluate('Array.from(document.querySelectorAll("button")).find(b=>b.textContent.trim()==='+JSON.stringify(label)+'||b.getAttribute("aria-label")==='+JSON.stringify(label)+').click()');
          const submit=()=>evaluate('document.querySelector("form").requestSubmit()');
          const drag=selector=>evaluate('(()=>{const link=document.querySelector('+JSON.stringify(selector)+');const dataTransfer=new DataTransfer();dataTransfer.setData("text/uri-list",link.href);dataTransfer.setData("text/html","default anchor");const event=new DragEvent("dragstart",{bubbles:true,cancelable:true,dataTransfer});link.dispatchEvent(event);return {prevented:event.defaultPrevented,markdown:dataTransfer.getData("text/markdown"),plain:dataTransfer.getData("text/plain"),uri:dataTransfer.getData("text/uri-list"),html:dataTransfer.getData("text/html"),reference:JSON.parse(dataTransfer.getData("application/vnd.kubarycz.working-memory+json")),active:JSON.parse(JSON.stringify(window.__searchTest.readDrag()))};})()');
          const endDrag=selector=>evaluate('document.querySelector('+JSON.stringify(selector)+').dispatchEvent(new DragEvent("dragend",{bubbles:true}))');
          const enter=async(modifiers=[])=>{
            await evaluate('(()=>{const t=document.querySelector("textarea");t.focus();t.setSelectionRange(t.value.length,t.value.length);})()');
            win.webContents.sendInputEvent({type:'keyDown',keyCode:'Return',modifiers});
            await delay(20);
            if(!await evaluate('window.__searchTest.lastEnterPrevented')) {
              win.webContents.sendInputEvent({type:'char',keyCode:'\\r',modifiers});
            }
            win.webContents.sendInputEvent({type:'keyUp',keyCode:'Return',modifiers});
            await delay(50);
          };
          const select=()=>evaluate('(()=>{const s=document.querySelector("dialog select");s.value="workstream-1";s.dispatchEvent(new Event("change",{bubbles:true}));})()');
          const escape=async()=>{
            win.webContents.sendInputEvent({type:'keyDown',keyCode:'Escape'});
            win.webContents.sendInputEvent({type:'keyUp',keyCode:'Escape'});await delay(50);
          };
          await win.loadURL(${JSON.stringify(`http://127.0.0.1:${address.port}/search-test.html`)});
          await wait('document.querySelector("textarea")');
          await evaluate('document.addEventListener("keydown",event=>{if(event.key==="Enter")window.__searchTest.lastEnterPrevented=event.defaultPrevented;})');
          assert.equal(await evaluate('document.querySelector("textarea").placeholder'),'Describe what you want to find');
          assert.equal(await evaluate('document.querySelector(".compose-toggle").textContent.trim()'),'');
          assert.equal(await evaluate('!!document.querySelector(".compose-toggle .codicon-file")'),true);
          assert.equal(await evaluate('getComputedStyle(document.querySelector(".compose-toggle")).backgroundColor'),'rgb(255, 255, 255)');
          assert.equal(await evaluate('(()=>{const t=document.querySelector("textarea").getBoundingClientRect();const b=document.querySelector(".compose-toggle").getBoundingClientRect();return b.top>=t.top&&b.bottom<=t.bottom&&b.right<=t.right&&t.right-b.right<=24&&b.top-t.top<=12;})()'),true);
          assert.ok(await evaluate('parseFloat(getComputedStyle(document.querySelector("textarea")).paddingRight)>=document.querySelector(".compose-toggle").getBoundingClientRect().width+20'));
          assert.ok(await evaluate('document.querySelector(".context").textContent.includes("Connection reliability")'));
          await evaluate('(()=>{const t=document.querySelector("textarea");t.value="First line";t.dispatchEvent(new Event("input",{bubbles:true}));})()');
          await enter(['shift']);
          assert.equal(await evaluate('document.querySelector("textarea").value'),'First line\\n');
          assert.equal(await evaluate('window.__searchTest.searches.length'),0);
          await click('Multiline mode');
          assert.equal(await evaluate('document.querySelector("textarea").rows'),6);
          assert.equal(await evaluate('document.querySelector(".compose-toggle").getAttribute("aria-pressed")'),'true');
          assert.equal(await evaluate('getComputedStyle(document.querySelector(".compose-toggle")).backgroundColor'),'rgb(71, 85, 105)');
          await enter();
          assert.equal(await evaluate('document.querySelector("textarea").value'),'First line\\n\\n');
          assert.equal(await evaluate('window.__searchTest.searches.length'),0);
          await click('Multiline mode');
          assert.equal(await evaluate('getComputedStyle(document.querySelector(".compose-toggle")).backgroundColor'),'rgb(255, 255, 255)');
          assert.equal(await evaluate('document.querySelector("textarea").value'),'First line\\n\\n');
          assert.equal(await evaluate('document.querySelector("textarea").dispatchEvent(new KeyboardEvent("keydown",{key:"Enter",isComposing:true,bubbles:true,cancelable:true}))'),true);
          assert.equal(await evaluate('window.__searchTest.searches.length'),0);
          for(const width of [220,280]) {
            await evaluate('document.querySelector("aside").style.width="'+width+'px"');
            await delay(50);
            assert.equal(await evaluate('(()=>{const h=document.querySelector(".active-rail-header").getBoundingClientRect();return [...document.querySelectorAll(".active-header-button")].every(b=>{const r=b.getBoundingClientRect();return r.left>=h.left&&r.right<=h.right;});})()'),true);
          }
          await evaluate('(()=>{const t=document.querySelector("textarea");t.value="Find work on reliable sign in";t.dispatchEvent(new Event("input",{bubbles:true}));})()');
          await enter();
          await wait('document.querySelector("[data-search-result]")');
          assert.equal(await evaluate('window.__searchTest.searches[0]'),'Find work on reliable sign in');
          assert.equal(await evaluate('window.__searchTest.options.context.workstreams[0].id'),'workstream-1');
          assert.ok(await evaluate('document.querySelector("article").getBoundingClientRect().height<150'));
          assert.equal(await evaluate('document.querySelector("article h3 a").getAttribute("href")'),'working-memory://open/topic/topic-1');
          assert.equal(await evaluate('document.querySelector(".reason").textContent'),'Explains connection reliability and authentication.');
          assert.equal(await evaluate('document.querySelector("article details")'),null);
          assert.equal(await evaluate('document.querySelector("article blockquote")'),null);
          assert.equal(await evaluate('document.querySelector("article").textContent.includes("The connector authenticates through a handshake.")'),false);
          assert.equal(await evaluate('document.querySelector("article h3 a").draggable'),true);
          const fallback=await drag('article h3 a');
          assert.equal(fallback.prevented,false);
          assert.equal(fallback.markdown,'[OAuth connections](http://127.0.0.1:7718/open/topic/topic-1)');
          assert.equal(fallback.plain,fallback.markdown);
          assert.equal(fallback.uri,'');
          assert.equal(fallback.html,'');
          assert.deepEqual(fallback.active,{kind:'topic',id:'topic-1',sourceWorkstream:''});
          await endDrag('article h3 a');
          assert.equal(await evaluate('window.__searchTest.readDrag()'),null);
          await evaluate('document.querySelector("article h3 a").dispatchEvent(new PointerEvent("pointerenter"))');
          await wait('window.__searchTest.preparations.length===1');
          await delay(20);
          const preparedDrag=await drag('article h3 a');
          assert.equal(preparedDrag.prevented,true);
          assert.equal(preparedDrag.uri,'file:///tmp/search-context.md');
          assert.equal(preparedDrag.reference.uri,preparedDrag.uri);
          assert.equal(await evaluate('window.__searchTest.nativeDrags.length'),1);
          await evaluate('window.dispatchEvent(new PointerEvent("pointerup",{buttons:0}))');
          assert.equal(await evaluate('window.__searchTest.readDrag()'),null);
          await evaluate('document.querySelector("article h3 a").click()');
          await wait('document.body.innerText.includes("Opened topic")');
          await evaluate('document.querySelector(".active-rail-header .codicon-search").closest("button").click()');
          await wait('document.querySelector("[data-search-result]")');
          assert.equal(await evaluate('document.querySelector("textarea").value'),'Find work on reliable sign in');
          assert.equal(await evaluate('window.__searchTest.searches.length'),1);
          await click('Add to workstream');
          await wait('document.querySelector("dialog[open] select")');
          await click('Cancel');
          assert.equal(await evaluate('window.__searchTest.adds.length'),0);
          await evaluate('window.__searchTest.failList=true');
          await click('Add to workstream');
          await wait('document.querySelector("dialog [role=alert]")');
          await evaluate('window.__searchTest.failList=false');
          await click('Retry loading');
          await wait('document.querySelector("dialog select")');
          await select();
          await evaluate('window.__searchTest.failAdd=true');
          await click('Add');
          await wait('document.querySelector("dialog [role=alert]")');
          assert.equal(await evaluate('!!document.querySelector("dialog[open]")'),true);
          await evaluate('window.__searchTest.failAdd=false;window.__searchTest.hold=true');
          await click('Add');
          await wait('!!window.__searchTest.release');
          await escape();await escape();
          assert.equal(await evaluate('!!document.querySelector("dialog[open]")'),true);
          await evaluate('window.__searchTest.release()');
          await wait('!document.querySelector("dialog")');
          assert.equal(await evaluate('window.__searchTest.refreshes'),1);
          assert.deepEqual(await evaluate('window.__searchTest.adds.at(-1)'),{id:'topic-1',workstream:'workstream-1'});
          assert.ok(await evaluate('document.querySelector(".notice").textContent.includes("Connection reliability")'));
          await evaluate('window.__searchTest.failSearch=true');
          await submit();await wait('document.querySelector(".search-view [role=alert]")');
          await evaluate('window.__searchTest.failSearch=false;window.__searchTest.empty=true');
          await submit();await wait('document.body.innerText.includes("No relevant documents found")');
          await evaluate('window.__searchTest.empty=false;window.__searchTest.blocks=[{type:"table",columns:["title","status","summary"],rows:[{sourceId:"topic-1",summary:"Case summary"}]}]');
          await submit();await wait('document.querySelector("table")');
          assert.equal(await evaluate('document.querySelectorAll("tbody td")[1].textContent.trim()'),'open');
          assert.equal(await evaluate('document.querySelectorAll("tbody td")[2].textContent.trim()'),'Case summary');
          assert.equal(await evaluate('document.querySelector("tbody a").getAttribute("href")'),'working-memory://open/topic/topic-1');
          const tableDrag=await drag('tbody a');
          assert.equal(tableDrag.markdown,'[OAuth connections](http://127.0.0.1:7718/open/topic/topic-1)');
          await endDrag('tbody a');
          await evaluate('window.__searchTest.extraResults=[{id:"workstream-1",kind:"Workstream",title:"Connection reliability",excerpt:"",reason:"Related scope",score:1,status:"progress"}];window.__searchTest.blocks=[{type:"summary",text:"Related scope",sourceIds:["workstream-1"]}]');
          await submit();await wait('document.querySelector(".citations a")');
          await evaluate('document.querySelector(".citations a").dispatchEvent(new PointerEvent("pointerenter"))');
          await delay(20);
          const citationDrag=await drag('.citations a');
          assert.deepEqual(citationDrag.active,{kind:'workstream',id:'workstream-1',section:'progress'});
          assert.equal(citationDrag.markdown,'[Connection reliability](http://127.0.0.1:7718/open/workstream/workstream-1)');
          await evaluate('window.__searchTest.dragListeners.forEach(listener=>listener({filePath:"/tmp/search-context.md",status:"failed",error:"Native failure"}))');
          assert.equal(await evaluate('window.__searchTest.readDrag()'),null);
          await wait('document.querySelector(".search-view [role=alert]")');
          await evaluate('window.__searchTest.extraResults=[]');
          await evaluate('window.__searchTest.blocks=[{type:"clarification",text:"Which workstream?",suggestions:["Use the Windows workstream"]}]');
          await submit();await wait('document.querySelector(".clarification")');
          await click('Use the Windows workstream');
          await wait('window.__searchTest.searches.at(-1).includes("Clarification: Use the Windows workstream")');
          await wait('!document.querySelector("textarea").disabled');
          await evaluate('window.__searchTest.blocks=undefined;(()=>{const t=document.querySelector("textarea");t.value="Line one\\\\nLine two";t.dispatchEvent(new Event("input",{bubbles:true}));})()');
          await click('Multiline mode');
          const before=await evaluate('window.__searchTest.searches.length');
          await enter(['control']);
          await wait('window.__searchTest.searches.length==='+String(before+1));
          assert.equal(await evaluate('window.__searchTest.searches.at(-1)'),'Line one\\nLine two');
          await evaluate('document.querySelector("article h3 a").click()');
          await wait('document.body.innerText.includes("Opened topic")');
          await click('Back to search');
          await wait('document.querySelector("textarea")');
          assert.equal(await evaluate('document.querySelector("textarea").rows'),6);
          assert.equal(await evaluate('document.querySelector("textarea").value'),'Line one\\nLine two');
          await enter(['meta']);
          await wait('window.__searchTest.searches.length==='+String(before+2));
          console.log('search-browser: intent, navigation, persistence, native dialog, errors and explicit membership passed');
          win.destroy();app.exit(0);
        }).catch(error=>{console.error(error);app.exit(1);});
      `);
      const { stdout } = await promisify(execFile)(executable, [script], {
        timeout: 30_000, env: { ...process.env, ELECTRON_RUN_AS_NODE: '' },
      });
      expect(stdout).toContain('search-browser: intent, navigation, persistence, native dialog, errors and explicit membership passed');
    } finally { await server.close(); await rm(directory, { recursive: true, force: true }); }
  }, 35_000,
);
