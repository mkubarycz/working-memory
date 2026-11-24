import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile, readdir, mkdtemp, rm } from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, resolve } from 'node:path';
import { performance } from 'node:perf_hooks';
import { parseArgs } from 'node:util';
import { realisticTopic, workloadDigest, percentile, responseDigest } from './benchmark-workload.mjs';
import { startBenchmarkEmbeddings } from './benchmark-embeddings.mjs';

// No target URL option: synthetic writes can only reach the container we create.
const { values } = parseArgs({ options: {
  image: { type: 'string' }, output: { type: 'string' },
  scales: { type: 'string', default: '10000,30000' },
  samples: { type: 'string', default: '100' },
  'body-bytes': { type: 'string', default: '2048' },
  'keep-for-feedback': { type: 'boolean' },
  credentials: { type: 'string' },
  'ordered-index': { type: 'boolean' },
  cases: { type: 'string' },
  realistic: { type: 'boolean' },
  seed: { type: 'string', default: 'acceptance-v1' },
  'first-samples': { type: 'string', default: '3' },
  'backend-dir': { type: 'string' },
  'compare-backend-dir': { type: 'string' },
  'embedding-runtime': { type: 'string' },
  'embedding-model-directory': { type: 'string' },
  help: { type: 'boolean' },
} });
if (values.help) {
  console.log([
    'node scripts/benchmark-documents.mjs --image <existing-local-image> --output <report.json> [--scales 10000,30000] [--samples 100] [--body-bytes 2048] [--cases read-id,read-kind-page]',
    'Creates an isolated 1 CPU/1 GiB/no-swap Docker container, dedicated network and named volume; removes only those exact artifacts. Uses production HTTP setup/features and MCP tools. No live-instance access.',
    'Acceptance workload: --realistic --embedding-runtime <existing-helper> --embedding-model-directory <verified-model-dir> [--seed acceptance-v1] [--first-samples 3]. Varied Markdown, 64 workstreams and acyclic graph; real production passages/vectors; host inference measured separately. First samples each restart the disposable backend, NOT OS-cold.',
    'Code control: --backend-dir <compiled-control-plane-dir> [--compare-backend-dir <other-compiled-dir>] stages code in stopped containers from the same image. Separate labelled volumes restore byte-identical copies of the stopped synthetic store/vectors at each scale, so schema changes cannot contaminate baseline. Verifies code hashes and response equality except timings. No host filesystem mount or host SQLite connection.',
    'Controlled index experiment: --ordered-index adds the current store.ts live ordered index during startup of this disposable container only, leaving the supplied image unchanged.',
    'Explicit feedback handoff: --keep-for-feedback --credentials <private-new-file.json> retains the isolated backend/network/volume and writes its owner credential with mode 0600. Caller must remove the exact reported artifacts after use.',
  ].join('\n'));
  process.exit(0);
}
assert.ok(values.image && values.output, '--image and --output are required');
assert.equal(Boolean(values['keep-for-feedback']), Boolean(values.credentials),
  '--keep-for-feedback and --credentials must be specified together');
const scales = values.scales.split(',').map(Number);
const samples = Number(values.samples);
const bodyBytes = Number(values['body-bytes']);
const firstSamples = Number(values['first-samples']);
const allCases = ['read-id', 'read-kind-page', 'read-unscoped-page', 'read-substring-page',
  'search-selective', 'search-common', 'query-page', 'query-substring',
  ...(values.realistic ? ['query-workstream', 'query-parent', 'semantic-status', 'semantic', 'related', 'placement'] : [])];
const selectedCases = values.cases ? values.cases.split(',') : allCases;
assert.ok(selectedCases.length && selectedCases.every(name => allCases.includes(name)), 'Unknown read case');
assert.ok(scales.length && scales.every((n, i) => Number.isSafeInteger(n) && n > 0 && (!i || n > scales[i - 1])), 'Scales must be increasing positive integers');
assert.ok(Number.isSafeInteger(samples) && samples > 0);
assert.ok(Number.isSafeInteger(bodyBytes) && bodyBytes >= 128 && bodyBytes <= 65536);
assert.ok(Number.isSafeInteger(firstSamples) && firstSamples > 0 && firstSamples <= 20);
assert.match(values.seed, /^[a-zA-Z0-9-]{1,40}$/);
assert.ok(!values.realistic || (values['embedding-runtime'] && values['embedding-model-directory']),
  'Realistic acceptance requires the existing real embedding runtime and verified model');
assert.ok(!values['compare-backend-dir'] || values['backend-dir'], 'Code comparison requires both compiled directories');
assert.ok(!values['backend-dir'] || !values['ordered-index'], 'Code-hash controls cannot use startup source rewriting');
const output = resolve(values.output);
const requestDeadlineMs = 90000;
assert.ok(!values.credentials || resolve(values.credentials) !== output,
  'Credentials and report must use different files');
const run = randomUUID();
const name = `wm-document-benchmark-${run}`;
const volume = `${name}-data`;
const network = `${name}-network`;
const label = `wm.document-benchmark=${run}`;
const docker = (...args) => execFileSync('docker', args, { encoding: 'utf8', timeout: 60000 }).trim();
const image = JSON.parse(docker('image', 'inspect', values.image))[0];
const indexSql = values['ordered-index']
  ? (await readFile(new URL('../control-plane/src/store.ts', import.meta.url), 'utf8'))
    .match(/CREATE INDEX IF NOT EXISTS idx_resources_live_kind_updated\s+ON resources \(kind, updated_at\) WHERE deleted_at IS NULL;/)?.[0]
  : '';
assert.ok(!values['ordered-index'] || indexSql, 'Expected the production live ordered index declaration');
const report = {
  startedAt: new Date().toISOString(), image: values.image, imageId: image.Id,
  imageArchitecture: image.Architecture,
  imageNodeVersion: image.Config.Env.find(value => value.startsWith('NODE_VERSION='))?.slice('NODE_VERSION='.length),
  clientRuntime: process.version, clientPlatform: process.platform, clientArchitecture: process.arch,
  syntheticDataOnly: true,
  orderedIndexExperiment: indexSql || null,
  resources: { cpus: 1, memoryBytes: 1073741824, swapBytes: 0, memoryPlusSwapBytes: 1073741824 },
  workload: { scales, samplesPerReadCase: samples, bodyBytes: values.realistic ? null : bodyBytes, createConcurrency: 4,
    seed: values.seed, realistic: !!values.realistic, firstSamples: values.realistic ? firstSamples : 0,
    readConcurrency: [1, 4], readCases: selectedCases, kinds: values.realistic ? ['Topic', 'Workstream', 'TopicType'] : ['Topic'],
    transport: 'Streamable HTTP MCP, one persistent session per backend process',
    notes: values.realistic
      ? 'Seeded 512/2048/8192/36000 UTF-16-unit Markdown, prose/code/tables/references and some Unicode; repeated technical families plus unique references, broad fanout and multiple parents/memberships, open/closed/unplaced topics. Real model and production passage contract. First samples are backend-process restarts with retained OS cache and warm host model; not OS-cold. Host-side indexing uses bounded exact-text vector reuse, query inference does not. Loopback Docker network latency included.'
      : 'Deterministic ASCII Markdown; 100 evenly distributed category tokens, one unique token per document. Warm steady-state reads after complete insertion. Embeddings disabled. Loopback Docker network latency included.' },
  stages: [], cleanup: {},
  deadlines: { mcpRequestMs: requestDeadlineMs, nativeHelperMs: 300000,
    semanticInferenceMs: values.realistic
      ? (await import('../out/control-plane/embeddingContract.js')).SEMANTIC_SEARCH_INFERENCE_TIMEOUT_MS : null },
  measurementNotes: 'End-to-end times include MCP transport, parsing and assertions. Code controls also include response comparison on both variants. Cgroup peaks are lifetime peaks since each disposable container was created, not incremental per-operation allocations; include file cache and temporary in-container sampling processes.',
};
let containerId, volumeCreated = false, networkCreated = false, token, session, url, requestId = 0, host;
let backend = values['backend-dir'], variant = 'baseline';
let activeVolume = volume, restoreDirectory, snapshotDirectory, snapshotIdentities;
const cloneVolumes = new Set();
const DB_FILE = values['compare-backend-dir'] ? (await import('../out/control-plane/config.js')).DB_FILE : null;
let retained = false;
const interrupted = new AbortController();
for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => interrupted.abort(new Error(`Benchmark interrupted by ${signal}`)));
}
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
async function http(path, { method = 'GET', body, headers = {} } = {}) {
  const response = await fetch(`${url}${path}`, { method,
    headers: { Accept: 'application/json, text/event-stream', ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(body === undefined ? {} : { 'Content-Type': 'application/json' }), ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.any([AbortSignal.timeout(requestDeadlineMs), interrupted.signal]),
  });
  const text = await response.text();
  assert.ok(response.ok, `HTTP ${response.status} ${path}: ${text.slice(0, 500)}`);
  if (response.headers.get('mcp-session-id')) session = response.headers.get('mcp-session-id');
  if (!text) return undefined;
  if (response.headers.get('content-type')?.includes('text/event-stream')) {
    const messages = text.split(/\r?\n\r?\n/).flatMap(event => {
      const data = event.split(/\r?\n/).filter(line => line.startsWith('data:')).map(line => line.slice(5).trim()).join('\n');
      return data ? [JSON.parse(data)] : [];
    });
    return messages.find(message => message.id !== undefined);
  }
  return JSON.parse(text);
}
async function rpc(method, params, notification = false) {
  const result = await http('/mcp', { method: 'POST',
    headers: { ...(session ? { 'Mcp-Session-Id': session } : {}), 'MCP-Protocol-Version': '2025-03-26' },
    body: { jsonrpc: '2.0', ...(notification ? {} : { id: ++requestId }), method, ...(params ? { params } : {}) } });
  assert.ok(!result?.error, JSON.stringify(result?.error));
  return result?.result;
}
async function tool(name, args) {
  const result = await rpc('tools/call', { name, arguments: args });
  assert.ok(result && !result.isError, `${name}: ${JSON.stringify(result).slice(0, 500)}`);
  const text = result.content?.filter(item => item.type === 'text').map(item => item.text).join('\n');
  return JSON.parse(text);
}
function memory() {
  return { containerId, ...JSON.parse(docker('exec', containerId, 'node', '--input-type=module', '-e', `
    import {readFileSync,readdirSync,statSync,existsSync} from 'node:fs';
    const read = p => readFileSync(p,'utf8');
    const stat = Object.fromEntries(read('/sys/fs/cgroup/memory.stat').trim().split('\\n').map(x=>x.split(' ')).map(([k,v])=>[k,Number(v)]));
    const rss = Number(read('/proc/1/status').match(/^VmRSS:\\s+(\\d+)/m)?.[1] ?? 0)*1024;
    console.log(JSON.stringify({cgroupBytes:Number(read('/sys/fs/cgroup/memory.current')),
      cgroupPeakBytes:Number(read('/sys/fs/cgroup/memory.peak')),anonymousBytes:stat.anon,fileCacheBytes:stat.file,
      limits:{memoryMaxBytes:Number(read('/sys/fs/cgroup/memory.max')),
        swapMaxBytes:Number(read('/sys/fs/cgroup/memory.swap.max')),cpuMax:read('/sys/fs/cgroup/cpu.max').trim()},
      processRssBytes:rss,cpuStat:read('/sys/fs/cgroup/cpu.stat').trim(),
      memoryEvents:read('/sys/fs/cgroup/memory.events').trim(),
      httpLifecycle:existsSync('/tmp/wm-benchmark-http-lifecycle.json')
        ? JSON.parse(read('/tmp/wm-benchmark-http-lifecycle.json')) : [],
      storeVerification:existsSync('/tmp/wm-benchmark-store-verified.json')
        ? JSON.parse(read('/tmp/wm-benchmark-store-verified.json')) : [],
      transportErrors:existsSync('/tmp/wm-benchmark-transport-errors.json')
        ? JSON.parse(read('/tmp/wm-benchmark-transport-errors.json')) : [],
      dataFiles:readdirSync('/data').map(name=>({name,bytes:statSync('/data/'+name).size}))}));`)) };
}
async function measure(label, count, concurrency, action, prepare) {
  let next = 0;
  const latencies = [], successfulLatencies = [], errors = [], timings = [], firstSampleMemory = [];
  const before = memory();
  const start = performance.now();
  await Promise.all(Array.from({ length: concurrency }, async () => {
    while (next < count) {
      interrupted.signal.throwIfAborted();
      const i = next++;
      if (prepare) await prepare();
      const t = performance.now();
      try {
        const result = await action(i);
        successfulLatencies.push(performance.now() - t);
        if (result?.timings) timings.push(result.timings);
      }
      catch (error) {
        const causes = [], seen = new Set();
        for (let cause = error; cause && typeof cause === 'object' && causes.length < 8 && !seen.has(cause); cause = cause.cause) {
          seen.add(cause);
          causes.push({ name: cause.name, message: cause.message, code: cause.code });
        }
        errors.push({ index: i, at: new Date().toISOString(), elapsedMs: performance.now() - t,
          requestDeadlineMs, name: error.name, message: error.message, causes });
      }
      latencies.push(performance.now() - t);
      if (prepare) firstSampleMemory.push(memory());
    }
  }));
  const wallMs = performance.now() - start;
  const elapsedMs = prepare ? latencies.reduce((sum, value) => sum + value, 0) : wallMs;
  latencies.sort((a, b) => a - b);
  successfulLatencies.sort((a, b) => a - b);
  const failedLatencies = errors.map(error => error.elapsedMs).sort((a, b) => a - b);
  const after = memory();
  const result = { label, variant, phase: prepare ? 'first-after-process-restart' : label.startsWith('create') ? 'write' : 'warm',
    count, concurrency, elapsedMs, wallMs, successes: count - errors.length,
    errors: errors.length, errorExamples: errors.slice(0, 5),
    throughputPerSecond: (count - errors.length) / (elapsedMs / 1000),
    attemptedThroughputPerSecond: count / (elapsedMs / 1000),
    latencyMs: { p50: percentile(latencies, .5), p95: percentile(latencies, .95), max: latencies.at(-1) },
    successfulLatencyMs: { count: successfulLatencies.length, p50: percentile(successfulLatencies, .5),
      p95: percentile(successfulLatencies, .95), max: successfulLatencies.at(-1) ?? null },
    failedRequestElapsedMs: { count: failedLatencies.length, p50: percentile(failedLatencies, .5),
      p95: percentile(failedLatencies, .95), max: failedLatencies.at(-1) ?? null },
    memoryBefore: before, memoryAfter: after, clientResourceUsage: process.resourceUsage(),
    peakCgroupBytes: Math.max(after.cgroupPeakBytes, ...firstSampleMemory.map(value => value.cgroupPeakBytes)),
    cgroupPeakBasis: 'Lifetime of the currently running disposable container; includes retained file cache',
    ...(prepare ? { throughputBasis: 'request time only; restart time excluded, not sustained service throughput',
      firstSampleMemory } : {}),
    ...(timings.length ? { semanticTimingsMs: Object.fromEntries(['inferenceMs', 'hostMs', 'rankingMs'].map(key => {
      const sorted = timings.map(timing => timing[key]).sort((a, b) => a - b);
      return [key, { p50: percentile(sorted, .5), p95: percentile(sorted, .95) }];
    })) } : {}) };
  console.log(JSON.stringify({ label, count, concurrency, errors: result.errors,
    throughputPerSecond: result.throughputPerSecond, latencyMs: result.latencyMs,
    cgroupPeakBytes: result.memoryAfter.cgroupPeakBytes, processRssBytes: result.memoryAfter.processRssBytes }));
  return result;
}
async function codeIdentity(directory) {
  if (!directory) return { source: 'image', imageId: image.Id };
  const files = [];
  async function visit(path, prefix = '') {
    for (const entry of (await readdir(path, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
      const relative = `${prefix}${entry.name}`;
      if (entry.isDirectory()) await visit(resolve(path, entry.name), `${relative}/`);
      else if (entry.name.endsWith('.js')) files.push([relative, await readFile(resolve(path, entry.name))]);
    }
  }
  await visit(resolve(directory));
  assert.ok(files.some(([name]) => name === 'index.js'), 'Compiled backend must include index.js');
  const { createHash } = await import('node:crypto');
  const hash = createHash('sha256');
  files.forEach(([name, content]) => hash.update(name).update(content));
  return { directory: resolve(directory), sha256: hash.digest('hex'), files: files.length };
}
async function startContainer() {
  containerId = docker('create', '--name', name, '--label', label,
    '--network', network, '--cpus', '1', '--memory', '1g', '--memory-swap', '1g',
    '--publish', '127.0.0.1::7717', '--mount', `type=volume,source=${activeVolume},target=/data`,
    '--env', 'WM_CONTROL_PLANE_HOME=/data', '--env', 'WM_CONTROL_PLANE_HOST=0.0.0.0',
    '--env', 'WM_CONTROL_PLANE_PORT=7717', '--env', 'WM_HOST_TASK_ADMIN_TOKEN_FILE=/data/benchmark-admin-token',
    '--env', `WM_BENCHMARK_INDEX_SQL=${indexSql}`,
    '--env', `WM_BENCHMARK_STORE_IDENTITIES=${JSON.stringify(restoreDirectory ? snapshotIdentities : [])}`,
    image.Id, 'node', '--expose-gc', '--experimental-sqlite', '--input-type=module', '-e',
    `import {readFileSync,writeFileSync,existsSync,createReadStream} from 'node:fs'; import {randomBytes,createHash} from 'node:crypto';
    import {channel} from 'node:diagnostics_channel';
    const transportErrors=[], lifecycle=[];
    let observedServer=false;
    channel('http.server.request.start').subscribe(({server})=>{
      if(observedServer) return;
      observedServer=true;
      const record=event=>{
        lifecycle.push({event,at:new Date().toISOString(),keepAliveTimeoutMs:server.keepAliveTimeout,
          keepAliveTimeoutBufferMs:server.keepAliveTimeoutBuffer,headersTimeoutMs:server.headersTimeout,
          requestTimeoutMs:server.requestTimeout,socketTimeoutMs:server.timeout});
        writeFileSync('/tmp/wm-benchmark-http-lifecycle.json',JSON.stringify(lifecycle),{mode:0o600});
      };
      record('serving');
      server.once('close',()=>record('closed'));
    });
    channel('undici:request:error').subscribe(({error})=>{
      if(transportErrors.length<20) {
        const causes=[], seen=new Set();
        for(let cause=error;cause && typeof cause==='object' && causes.length<8 && !seen.has(cause);cause=cause.cause) {
          seen.add(cause);
          causes.push({name:cause.name,message:cause.message,code:cause.code});
        }
        transportErrors.push({at:new Date().toISOString(),causes});
        writeFileSync('/tmp/wm-benchmark-transport-errors.json',JSON.stringify(transportErrors),{mode:0o600});
      }
    });
    const verified=[];
    for(const file of JSON.parse(process.env.WM_BENCHMARK_STORE_IDENTITIES)) {
      const hash=createHash('sha256');
      for await(const chunk of createReadStream('/data/'+file.name)) hash.update(chunk);
      const sha256=hash.digest('hex');
      if(sha256!==file.sha256) throw new Error('Stopped synthetic store copy hash mismatch');
      verified.push({name:file.name,sha256});
    }
    writeFileSync('/tmp/wm-benchmark-store-verified.json',JSON.stringify(verified),{mode:0o600});
    if (process.env.WM_BENCHMARK_INDEX_SQL) {
      const path='./out/control-plane/store.js', source=readFileSync(path,'utf8');
      const anchor='CREATE INDEX IF NOT EXISTS idx_resources_kind ON resources (kind);';
      if (!source.includes(anchor)) throw new Error('Expected resource index initialization');
      if (!source.includes('CREATE INDEX IF NOT EXISTS idx_resources_live_kind_updated'))
        writeFileSync(path,source.replace(anchor,anchor+'\\n'+process.env.WM_BENCHMARK_INDEX_SQL));
    }
    if (!existsSync('/data/benchmark-admin-token'))
      writeFileSync('/data/benchmark-admin-token',randomBytes(32).toString('hex'),{mode:0o600});
    await import('./out/control-plane/index.js');`);
  if (backend) docker('cp', `${resolve(backend)}/.`, `${containerId}:/app/out/control-plane/`);
  if (restoreDirectory) {
    for (const file of await readdir(restoreDirectory)) {
      assert.ok([DB_FILE, `${DB_FILE}-wal`, `${DB_FILE}-shm`].includes(file), 'Only the stopped synthetic database may be restored');
      docker('cp', `${restoreDirectory}/${file}`, `${containerId}:/data/${file}`);
    }
    restoreDirectory = undefined;
  }
  docker('start', containerId);
  const inspect = JSON.parse(docker('inspect', containerId))[0];
  assert.equal(inspect.Config.Image, image.Id);
  assert.equal(inspect.Config.Labels['wm.document-benchmark'], run);
  assert.equal(inspect.HostConfig.NanoCpus, 1e9);
  assert.equal(inspect.HostConfig.Memory, 1073741824);
  assert.equal(inspect.HostConfig.MemorySwap, 1073741824);
  assert.deepEqual(Object.keys(inspect.NetworkSettings.Networks), [network]);
  assert.equal(inspect.Mounts.filter(mount => mount.Destination === '/data').length, 1);
  assert.ok(inspect.Mounts.some(mount => mount.Type === 'volume' && mount.Name === activeVolume && mount.Destination === '/data'));
  assert.equal(JSON.parse(docker('volume', 'inspect', activeVolume))[0].Labels['wm.document-benchmark'], run);
  assert.equal(inspect.Mounts.length, 1, 'No borrowed data or credential mounts');
  const net = JSON.parse(docker('network', 'inspect', network))[0];
  assert.equal(net.Labels['wm.document-benchmark'], run);
  assert.deepEqual(Object.keys(net.Containers), [containerId], 'Dedicated network may contain only this benchmark backend');
  const binding = inspect.NetworkSettings.Ports['7717/tcp'][0];
  assert.equal(binding.HostIp, '127.0.0.1');
  assert.ok(!['7717', '7719'].includes(binding.HostPort), 'Never publish synthetic workloads at a live port');
  url = `http://127.0.0.1:${binding.HostPort}`;
  report.container = { name, volume: activeVolume, network, url, id: containerId };
  for (let retry = 0; ; retry++) {
    try { report.health = await http('/health'); break; }
    catch (error) { if (retry >= 59) throw error; await sleep(500); }
  }
  report.restarts ??= [];
  if (backend) {
    const actual = JSON.parse(docker('exec', containerId, 'node', '--input-type=module', '-e', `
      import {readdirSync,readFileSync} from 'node:fs'; import {createHash} from 'node:crypto';
      const hash=createHash('sha256'); let files=0;
      function visit(path,prefix='') {for(const e of readdirSync(path,{withFileTypes:true}).sort((a,b)=>a.name.localeCompare(b.name))) {
        const relative=prefix+e.name; if(e.isDirectory()) visit(path+'/'+e.name,relative+'/');
        else if(e.name.endsWith('.js')) {hash.update(relative).update(readFileSync(path+'/'+e.name));files++;}
      }} visit('/app/out/control-plane'); console.log(JSON.stringify({sha256:hash.digest('hex'),files}));`));
    assert.equal(actual.sha256, report.code[variant].sha256, 'Container code must exactly match the selected compiled backend');
    assert.equal(actual.files, report.code[variant].files);
  }
  const effective = memory();
  assert.equal(effective.limits.memoryMaxBytes, 1073741824);
  assert.equal(effective.limits.swapMaxBytes, 0);
  const [quota, period] = effective.limits.cpuMax.split(/\s+/).map(Number);
  assert.ok(Number.isFinite(quota) && quota > 0 && quota === period, 'Effective CPU quota must be exactly one CPU');
  report.restarts.push({ variant, containerId, url, limitsVerified: true,
    volume: activeVolume, network, imageId: image.Id, memory: effective });
}
async function disconnect() {
  if (!session) return;
  await http('/mcp', { method: 'DELETE', headers: { 'Mcp-Session-Id': session } });
  session = undefined;
}
async function connect() {
  await rpc('initialize', { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'isolated-document-benchmark', version: '2' } });
  await rpc('notifications/initialized', undefined, true);
}
async function stopContainer() {
  await disconnect();
  const own = JSON.parse(docker('inspect', containerId))[0];
  assert.equal(own.Config.Labels['wm.document-benchmark'], run);
  docker('stop', '--time', '10', containerId);
  report.restarts.at(-1).finalState = JSON.parse(docker('inspect', containerId))[0].State;
}
function removeStoppedContainer() {
  const own = JSON.parse(docker('inspect', containerId))[0];
  assert.equal(own.Config.Labels['wm.document-benchmark'], run);
  assert.equal(own.State.Running, false);
  docker('rm', containerId);
  containerId = undefined;
}
async function restart() {
  await stopContainer();
  removeStoppedContainer();
  await startContainer();
  await mkdir(dirname(output), { recursive: true });
  await writeFile(output, JSON.stringify(report, null, 2));
  await connect();
}
async function snapshotStore(stage) {
  const files = memory().dataFiles.map(file => file.name)
    .filter(file => [DB_FILE, `${DB_FILE}-wal`, `${DB_FILE}-shm`].includes(file));
  assert.ok(files.includes(DB_FILE), 'The isolated control-plane database must exist');
  await stopContainer();
  snapshotDirectory = await mkdtemp(resolve(tmpdir(), 'wm-benchmark-store-'));
  const removedByClose = [];
  for (const file of files) {
    try { docker('cp', `${containerId}:/data/${file}`, `${snapshotDirectory}/${file}`); }
    catch (error) {
      if (file === DB_FILE || !error.message.includes('Could not find the file')) throw error;
      removedByClose.push(file);
    }
  }
  const { createHash } = await import('node:crypto');
  stage.snapshot = { sourceVolume: activeVolume, stoppedContainer: containerId, removedByClose,
    files: await Promise.all((await readdir(snapshotDirectory)).sort().map(async name => {
      const hash = createHash('sha256');
      for await (const chunk of createReadStream(`${snapshotDirectory}/${name}`)) hash.update(chunk);
      return { name, sha256: hash.digest('hex') };
    })),
    note: 'Byte copies after stopping the sole SQLite owner; never opened with SQLite on the host. Both variants restore identical files in separate labelled volumes; schema/index changes cannot contaminate baseline.' };
  snapshotIdentities = stage.snapshot.files;
  removeStoppedContainer();
}
function removeClone(volume) {
  const own = JSON.parse(docker('volume', 'inspect', volume))[0];
  assert.equal(own.Labels['wm.document-benchmark'], run);
  docker('volume', 'rm', volume);
  cloneVolumes.delete(volume);
  report.cleanup.controlVolumesRemoved ??= [];
  report.cleanup.controlVolumesRemoved.push(volume);
}
try {
  assert.ok(!docker('volume', 'ls', '--format', '{{.Name}}').split('\n').includes(volume),
    'Benchmark volume must not already exist');
  docker('volume', 'create', '--label', label, volume);
  volumeCreated = true;
  assert.equal(JSON.parse(docker('volume', 'inspect', volume))[0].Labels['wm.document-benchmark'], run,
    'Never attach a volume whose ownership is not this run');
  docker('network', 'create', '--label', label, network);
  networkCreated = true;
  report.code = { baseline: await codeIdentity(backend),
    ...(values['compare-backend-dir'] ? { comparison: await codeIdentity(values['compare-backend-dir']) } : {}) };
  if (values.realistic) {
    host = await startBenchmarkEmbeddings(values['embedding-runtime'], values['embedding-model-directory'], interrupted.signal);
    report.embeddingHost = host.metrics;
  }
  await startContainer();
  token = docker('exec', containerId, 'cat', '/data/benchmark-admin-token');
  const owner = await http('/identity/v1/setup', { method: 'POST', body: { password: randomBytes(32).toString('hex') } });
  token = owner.token;
  assert.ok(token, 'Setup must return an owner token');
  await http('/features/v2', { method: 'POST', body: { search: true } });
  await connect();
  const type = await tool('wm-document-create', { kind: 'TopicType',
    spec: { label: values['keep-for-feedback'] ? 'User Story' : 'Synthetic benchmark',
      icon: 'beaker', description: 'Isolated performance test documents.' } });
  const topicType = type.metadata.id;
  const ids = [], workstreams = [];
  if (values.realistic) {
    for (let i = 0; i < 64; i++) {
      const topic = realisticTopic(values.seed, i);
      const doc = await tool('wm-document-create', { kind: 'Workstream',
        spec: { title: `${topic.title} workstream ${i}`, status: i % 9 === 0 ? 'closed' : 'progress',
          ...(i % 9 === 0 ? { closure: 'Synthetic completed workstream; ineligible for new placement.' } : {}) } });
      workstreams.push(doc.metadata.id);
    }
    await tool('wm-embeddings-configure', { action: 'enable', host: { endpoint: host.endpoint, token: host.token } });
    await tool('wm-embeddings-configure', { action: 'pause' });
  }
  const vocabulary = ['latency', 'database', 'rendering', 'deployment', 'migration', 'authentication', 'monitoring', 'backlog'];
  for (const scale of scales) {
    const from = ids.length;
    const stage = { documents: scale, measurements: [],
      ...(values.realistic ? { dataset: workloadDigest(values.seed, scale) } : {}) };
    report.stages.push(stage);
    const create = async index => {
      const n = from + index;
      const prefix = `# Synthetic benchmark ${n}\ncategory${n % 100} unique${n} ${vocabulary[n % vocabulary.length]}\n`;
      const prose = 'Working memory evidence: investigate latency, document workflow and verify production behavior. ';
      const body = (prefix + prose.repeat(Math.ceil(bodyBytes / prose.length))).slice(0, bodyBytes);
      const realistic = values.realistic ? realisticTopic(values.seed, n) : null;
      const spec = realistic ? { title: realistic.title, body: realistic.body, topicType, status: realistic.status,
        parents: realistic.parentIndexes.map(index => { assert.ok(ids[index]); return ids[index]; }),
        workstreams: realistic.workstreamIndexes.map(index => workstreams[index]) }
        : { title: `Synthetic document ${n}`, body, topicType };
      const doc = await tool('wm-document-create', { kind: 'Topic', spec });
      ids[n] = doc.metadata.id;
    };
    // Parents must exist before production reference validation; seed only the small graph trunk serially.
    if (!from && values.realistic) {
      stage.measurements.push(await measure('create-graph-trunk', Math.min(64, scale), 1, create));
    }
    const trunk = !from && values.realistic ? Math.min(64, scale) : 0;
    if (scale - from - trunk > 0) stage.measurements.push(await measure('create', scale - from - trunk, 4, i => create(i + trunk)));
    assert.equal(ids.filter(Boolean).length, scale, 'Stop if insertion failed; do not misreport scale');
    const counts = await tool('wm-document-query', { kind: 'Topic', limit: 1, bodyLimit: 1 });
    assert.equal(counts.total, scale);
    if (values.realistic) {
      const started = performance.now(), before = memory(), hostBefore = { ...host.metrics };
      let indexed = 0, passages = 0;
      const nextMs = [], submitMs = [];
      for (;;) {
        interrupted.signal.throwIfAborted();
        const nextStarted = performance.now();
        const batch = await tool('wm-embeddings-next', {});
        nextMs.push(performance.now() - nextStarted);
        if (!batch.work) { assert.equal(batch.stats.pending, 0, 'Indexing did not reach readiness'); break; }
        const vectors = await host.embed(batch.work.passages);
        const submitStarted = performance.now();
        const submitted = await tool('wm-embeddings-submit', { id: batch.work.id, sourceVersion: batch.work.sourceVersion,
          contentHash: batch.work.contentHash, model: host.metrics.model, vectors });
        submitMs.push(performance.now() - submitStarted);
        assert.equal(submitted.accepted, true);
        indexed++;
        passages += batch.work.passages.length;
        if (indexed % 1000 === 0) {
          stage.indexingProgress = { indexed, passages, elapsedMs: performance.now() - started, memory: memory() };
          await writeFile(output, JSON.stringify(report, null, 2));
          console.log(JSON.stringify({ indexing: indexed, documents: scale, passages, elapsedMs: performance.now() - started }));
        }
      }
      host.sample();
      stage.indexing = { documents: indexed, passages, elapsedMs: performance.now() - started,
        memoryBefore: before, memoryAfter: memory(), hostBefore, hostAfter: { ...host.metrics },
        throughputDocumentsPerSecond: indexed / ((performance.now() - started) / 1000),
        backendRequestsMs: Object.fromEntries([['next', nextMs], ['submit', submitMs]].map(([name, values]) => {
          values.sort((a, b) => a - b);
          return [name, { count: values.length, p50: percentile(values, .5), p95: percentile(values, .95),
            totalMs: values.reduce((sum, value) => sum + value, 0) }];
        })),
        note: 'Production next/submit tools; host real inference plus bounded exact-text cache. Indexer paused to avoid competing work; enabled/readiness semantics retained.' };
      assert.equal((await tool('wm-semantic-status', {})).ready, true);
      stage.readiness = await tool('wm-semantic-status', {});
    }
    const at = i => (i * 7919) % scale;
    const reference = i => values.realistic ? realisticTopic(values.seed, at(i)).reference : `unique${at(i)}`;
    const category = i => values.realistic ? `service_${realisticTopic(values.seed, at(i)).family}.handler` : `category${i % 100}`;
    const cases = [
        ['read-id', i => tool('wm-document-read', { id: ids[(i * 7919) % scale] })],
        ['read-kind-page', () => tool('wm-document-read', { kind: 'Topic', limit: 20 })],
        ['read-unscoped-page', () => tool('wm-document-read', { limit: 20 })],
        ['read-substring-page', i => tool('wm-document-read', { kind: 'Topic', query: category(i), limit: 20 })],
        ['search-selective', i => tool('wm-document-search', { queries: [reference(i)], limit: 20 })],
        ['search-common', () => tool('wm-document-search', { queries: [values.realistic ? 'evidence' : 'latency'], limit: 20 })],
        ['query-page', () => tool('wm-document-query', { kind: 'Topic', limit: 20, bodyLimit: 2000 })],
        ['query-substring', i => tool('wm-document-query', { kind: 'Topic', query: category(i), limit: 20, bodyLimit: 2000 })],
        ...(values.realistic ? [
          ['query-workstream', i => tool('wm-document-query', { kind: 'Topic', workstream: workstreams[i % 64], limit: 20 })],
          ['query-parent', i => tool('wm-document-query', { kind: 'Topic', parent: ids[i % 64], limit: 20 })],
          ['semantic-status', () => tool('wm-semantic-status', {})],
          ['semantic', i => tool('wm-semantic-search', { queries: ['investigate database transaction recovery'], literalQuery: reference(i), limit: 20 })],
          ['related', async i => {
            const result = await tool('wm-related-topics', { id: ids[at(i)], limit: 6 });
            assert.equal(result.state, 'ready');
            return result;
          }],
          ['placement', async i => {
            const result = await tool('wm-topic-suggest-placement', { id: ids[at(i)], limit: 5 });
            assert.equal(result.state, 'ready');
            return result;
          }],
        ] : []),
      ];
    const controls = new Map();
    if (values['compare-backend-dir']) await snapshotStore(stage);
    for (const name of ['baseline', ...(values['compare-backend-dir'] ? ['comparison'] : [])]) {
      variant = name;
      backend = name === 'baseline' ? values['backend-dir'] : values['compare-backend-dir'];
      if (values['compare-backend-dir']) {
        activeVolume = `${volume}-${scale}-${name}`;
        assert.ok(!docker('volume', 'ls', '--format', '{{.Name}}').split('\n').includes(activeVolume));
        docker('volume', 'create', '--label', label, activeVolume);
        cloneVolumes.add(activeVolume);
        assert.equal(JSON.parse(docker('volume', 'inspect', activeVolume))[0].Labels['wm.document-benchmark'], run);
        restoreDirectory = snapshotDirectory;
        const startup = performance.now();
        await startContainer();
        await connect();
        stage.variantStartup ??= {};
        stage.variantStartup[name] = { elapsedMs: performance.now() - startup, volume: activeVolume,
          readiness: values.realistic ? await tool('wm-semantic-status', {}) : null, memory: memory() };
        if (values.realistic) assert.equal(stage.variantStartup[name].readiness.ready, true);
      } else await restart();
      for (const [label, rawAction] of cases.filter(([label]) => selectedCases.includes(label))) {
        const action = async i => {
          const result = await rawAction(i);
          if (values['compare-backend-dir']) {
            const key = `${label}:${i}`;
            const digest = JSON.stringify(responseDigest(result));
            if (variant === 'baseline') {
              if (controls.has(key)) assert.ok(digest === controls.get(key), 'Baseline response changed without authored writes');
              else controls.set(key, digest);
            } else assert.ok(digest === controls.get(key), `Control response differs for ${key}`);
          }
          return result;
        };
        if (values.realistic) {
          stage.measurements.push(await measure(label, firstSamples, 1, action, restart));
        } else await action(0);
        for (const concurrency of [1, 4]) {
          stage.measurements.push(await measure(label, samples, concurrency, action));
        }
      }
      if (values['compare-backend-dir']) stage.controlResponsesVerified = controls.size;
      if (values['compare-backend-dir']) {
        await stopContainer();
        removeStoppedContainer();
        removeClone(activeVolume);
      }
    }
    if (values['compare-backend-dir']) {
      await rm(snapshotDirectory, { recursive: true });
      snapshotDirectory = undefined;
      variant = 'baseline';
      backend = values['backend-dir'];
      activeVolume = volume;
      await startContainer();
      await connect();
    }
    await mkdir(dirname(output), { recursive: true });
    await writeFile(output, JSON.stringify(report, null, 2));
  }
  report.finalMemory = memory();
  report.errors = report.stages.flatMap(stage => stage.measurements).reduce((sum, value) => sum + value.errors, 0);
  report.errorsByVariant = Object.fromEntries(['baseline', ...(values['compare-backend-dir'] ? ['comparison'] : [])]
    .map(name => [name, report.stages.flatMap(stage => stage.measurements)
      .filter(value => value.variant === name).reduce((sum, value) => sum + value.errors, 0)]));
  if (report.errors) process.exitCode = 1;
  if (values['keep-for-feedback'] && !report.errors) {
    const credentials = resolve(values.credentials);
    assert.ok(!values.realistic, 'Do not retain a backend configured to an ephemeral benchmark inference service');
    await writeFile(credentials, JSON.stringify({ url, token, container: name, volume, network, topicType }, null, 2),
      { mode: 0o600, flag: 'wx' });
    report.feedbackHandoff = { credentials, topicType, cleanupRequired: true };
    retained = true;
  }
} catch (error) {
  report.failure = error.stack;
  process.exitCode = 1;
} finally {
  if (session && token) {
    try { await http('/mcp', { method: 'DELETE', headers: { 'Mcp-Session-Id': session } }); }
    catch (error) { report.sessionCleanupError = error.message; }
  }
  if (containerId && !retained) {
    try {
      const own = JSON.parse(docker('inspect', containerId))[0];
      assert.equal(own.Config.Labels['wm.document-benchmark'], run);
      report.containerState = own.State;
      docker('rm', '--force', containerId);
      report.cleanup.containerRemoved = true;
    } catch (error) { report.cleanup.containerError = error.message; process.exitCode = 1; }
  }
  if (volumeCreated && !retained) {
    try {
      const own = JSON.parse(docker('volume', 'inspect', volume))[0];
      assert.equal(own.Labels['wm.document-benchmark'], run);
      docker('volume', 'rm', volume);
      report.cleanup.volumeRemoved = true;
    } catch (error) { report.cleanup.volumeError = error.message; process.exitCode = 1; }
  }
  for (const volume of cloneVolumes) {
    try { removeClone(volume); }
    catch (error) { report.cleanup.controlVolumeError = error.message; process.exitCode = 1; }
  }
  if (snapshotDirectory) {
    try { await rm(snapshotDirectory, { recursive: true }); report.cleanup.snapshotRemoved = true; }
    catch (error) { report.cleanup.snapshotError = error.message; process.exitCode = 1; }
  }
  if (networkCreated && !retained) {
    try {
      const own = JSON.parse(docker('network', 'inspect', network))[0];
      assert.equal(own.Labels['wm.document-benchmark'], run);
      assert.equal(Object.keys(own.Containers).length, 0);
      docker('network', 'rm', network);
      report.cleanup.networkRemoved = true;
    } catch (error) { report.cleanup.networkError = error.message; process.exitCode = 1; }
  }
  if (host) {
    try { await host.close(); report.cleanup.embeddingHelperStopped = true; }
    catch (error) { report.cleanup.embeddingHelperError = error.message; process.exitCode = 1; }
  }
  if (retained) report.cleanup = { retainedForFeedback: true, container: name, volume, network };
  report.finishedAt = new Date().toISOString();
  await mkdir(dirname(output), { recursive: true });
  await writeFile(output, JSON.stringify(report, null, 2));
  console.log(JSON.stringify({ output, cleanup: report.cleanup, failure: report.failure }));
}
