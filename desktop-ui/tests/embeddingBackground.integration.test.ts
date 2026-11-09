import { expect, it } from 'vitest';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { EmbeddingServiceManager } from '../src/main/embeddingServiceManager';
import { ControlPlaneClient } from '../../shared/controlPlaneClient';
import { embeddingDashboardSchema, relatedTopicsSchema } from '../../control-plane/src/embeddingContract';

const execute = promisify(execFile);
it.skipIf(process.env.WM_TEST_BACKGROUND_EMBEDDINGS !== '1')('indexes from a real container through the installed sign-in service after its desktop client disconnects', async () => {
  if (process.platform !== 'darwin') throw new Error('This installed-app/container acceptance fixture currently targets macOS.');
  const app = '/Applications/Working Memory.app';
  const bundle = readFileSync(join(app, 'Contents/Resources/app/out/main/index.js'), 'utf8');
  const timestamp = bundle.match(/new EmbeddingServiceManager\(\s*process\.execPath,\s*embeddingHome,[\s\S]*?"(\d{4}-[^"]+)"/)?.[1];
  if (!timestamp) throw new Error('Installed application service build identity was not found.');
  const version = JSON.parse(readFileSync(join(app, 'Contents/Resources/app/package.json'), 'utf8')).version;
  const manager = new EmbeddingServiceManager(join(app, 'Contents/MacOS/Electron'),
    join(homedir(), 'Library/Application Support/Working Memory/embeddings'), `${version}@${timestamp}`);
  const host = await manager.ensure();
  const directory = mkdtempSync(join(tmpdir(), 'wm-container-embedding-'));
  const name = `wm-embedding-acceptance-${process.pid}`;
  const image = `working-memory-control-plane:${version}`;
  const script = `
    import {openStore} from './out/control-plane/store.js';
    import {loadKinds} from './out/control-plane/kinds/loader.js';
    import {InstanceIdentity} from './out/control-plane/instanceIdentity.js';
    import {InstanceFeatureStore} from './out/control-plane/instanceFeatures.js';
    import {startServer} from './out/control-plane/server.js';
    import {writeFileSync} from 'node:fs';
    await loadKinds();
    const store = openStore('/data/journal.sqlite');
    const identity = new InstanceIdentity(store.db);
    const session = identity.configured() ? await identity.login({password:'synthetic acceptance password'})
      : await identity.initialize('synthetic acceptance password');
    new InstanceFeatureStore(store.db).write({search:true});
    if (!store.db.prepare("SELECT 1 FROM resources WHERE kind='TopicType'").get()) {
      store.createDocument({kind:'TopicType',spec:{label:'Topic'}});
    }
    if (!store.db.prepare("SELECT 1 FROM resources WHERE kind='Topic'").get()) {
      store.createDocument({kind:'Topic',spec:{title:'Private network outage',body:'The router cannot reach the remote service. Connections fail and packets are dropped.'}});
      store.createDocument({kind:'Topic',spec:{title:'Connectivity recovery',body:'Restore routing to the server and investigate dropped packets and connection failures.'}});
      store.createDocument({kind:'Topic',spec:{title:'Baking bread',body:'Mix flour, yeast and water. Knead the dough and bake a loaf.'}});
    }
    writeFileSync('/data/session.json',JSON.stringify(session),{mode:0o600});
    const server = await startServer({host:'0.0.0.0',port:7717,store});
    process.on('SIGTERM',()=>void server.close().then(()=>{store.close();process.exit(0)}));
  `;
  let created = false;
  let client: ControlPlaneClient | undefined;
  try {
    await execute('docker', ['run', '-d', '--name', name, '-p', '127.0.0.1::7717',
      '--mount', `type=bind,source=${directory},target=/data`, image, 'node', '--input-type=module', '-e', script]);
    created = true;
    const port = (await execute('docker', ['port', name, '7717/tcp'])).stdout.trim().split(':').at(-1)!;
    let endpoint = `http://127.0.0.1:${port}`;
    for (let attempt = 0; attempt < 100; attempt++) {
      try { if ((await fetch(`${endpoint}/health`)).ok) break; }
      catch (error) { if (attempt === 99) throw error; }
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    const session = JSON.parse(readFileSync(join(directory, 'session.json'), 'utf8'));
    client = new ControlPlaneClient({ resolveUrl: () => `${endpoint}/mcp`, getToken: () => session.token });
    const topics = await client.callTool('wm-document-read', { kind: 'Topic' });
    if (!topics.ok) throw new Error(topics.error);
    const documents = (topics.result as { documents: { metadata: { id: string }; spec: { title: string } }[] }).documents;
    const source = documents.find(topic => topic.spec.title === 'Private network outage')!;
    const related = documents.find(topic => topic.spec.title === 'Connectivity recovery')!;
    const configured = await client.callTool('wm-embeddings-configure', { action: 'enable', host });
    expect(configured.ok).toBe(true);
    await client.dispose();
    client = undefined;
    const indexed = async () => {
      const result = await execute('docker', ['exec', name, 'node', '--input-type=module', '-e',
        "import {DatabaseSync} from 'node:sqlite';const db=new DatabaseSync('/data/journal.sqlite',{readOnly:true});console.log(db.prepare(\"SELECT count(*) AS count FROM topic_embedding_index i JOIN resources r ON r.id=i.topic_id WHERE r.kind='Topic'\").get().count);db.close()"]);
      return Number(result.stdout.trim());
    };
    for (let attempt = 0; attempt < 180; attempt++) {
      if (await indexed() === 3) break;
      await new Promise(resolve => setTimeout(resolve, 1000));
    }
    expect(await indexed()).toBe(3);
    client = new ControlPlaneClient({ resolveUrl: () => `${endpoint}/mcp`, getToken: () => session.token });
    const result = await client.callTool('wm-related-topics', { id: source.metadata.id });
    if (!result.ok) throw new Error(result.error);
    expect(relatedTopicsSchema.parse(result.result).results[0].id).toBe(related.metadata.id);
    await client.dispose();
    client = undefined;
    await execute('docker', ['restart', name]);
    const restartedPort = (await execute('docker', ['port', name, '7717/tcp'])).stdout.trim().split(':').at(-1)!;
    endpoint = `http://127.0.0.1:${restartedPort}`;
    for (let attempt = 0; attempt < 100; attempt++) {
      try { if ((await fetch(`${endpoint}/health`)).ok) break; }
      catch (error) { if (attempt === 99) throw error; }
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    client = new ControlPlaneClient({ resolveUrl: () => `${endpoint}/mcp`, getToken: () => session.token });
    const added = await client.callTool('wm-document-create', { kind: 'Topic',
      spec: { title: 'Basket weaving', body: 'Weave reeds into a decorative basket.' } });
    if (!added.ok) throw new Error(`Post-restart topic creation failed: ${added.error}`);
    await client.dispose();
    client = undefined;
    for (let attempt = 0; attempt < 30; attempt++) {
      if (await indexed() === 4) break;
      await new Promise(resolve => setTimeout(resolve, 1000));
    }
    expect(await indexed()).toBe(4);
    client = new ControlPlaneClient({ resolveUrl: () => `${endpoint}/mcp`, getToken: () => session.token });
    const state = await client.callTool('wm-embeddings-dashboard', {});
    if (!state.ok) throw new Error(state.error);
    const snapshot = embeddingDashboardSchema.parse(state.result);
    expect(snapshot.stats?.indexed).toBeGreaterThanOrEqual(4);
    expect(snapshot.stats?.indexed).toBe(snapshot.stats?.total);
    expect(snapshot.stats?.pending).toBe(0);
    expect(snapshot.backend).toContain('Core ML');
    const startup = await execute('/bin/launchctl', ['print', `gui/${process.getuid!()}/com.workingmemory.embeddings`]);
    expect(startup.stdout).toContain('state = running');
    expect(startup.stdout).toContain('--embedding-service');
    console.log(JSON.stringify({ container: name, indexedWithoutDesktopClient: 4, resumedAfterContainerRestart: true, backend: snapshot.backend,
      hostRssMiB: (snapshot.rssBytes ?? 0) / 1048576, inferenceMs: snapshot.lastInferenceMs, startup: 'LaunchAgent running' }));
  } finally {
    await client?.dispose();
    if (created) await execute('docker', ['rm', '-f', name]);
    rmSync(directory, { recursive: true, force: true });
  }
}, 300000);
