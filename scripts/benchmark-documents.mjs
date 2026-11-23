import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { performance } from 'node:perf_hooks';
import { parseArgs } from 'node:util';

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
  help: { type: 'boolean' },
} });
if (values.help) {
  console.log('node scripts/benchmark-documents.mjs --image <existing-local-image> --output <report.json> [--scales 10000,30000] [--samples 100] [--body-bytes 2048] [--cases read-id,read-kind-page]\nCreates an isolated 1 CPU/1 GiB Docker container and named volume; removes only those exact artifacts. Uses production HTTP setup/features and MCP tools. No npm dependencies or live-instance access.\nControlled index experiment: --ordered-index adds the current store.ts live ordered index during startup of this disposable container only, leaving the supplied image unchanged.\nExplicit feedback handoff: --keep-for-feedback --credentials <private-new-file.json> retains the isolated backend and writes its owner credential with mode 0600. Caller must remove the exact reported container and volume after use.');
  process.exit(0);
}
assert.ok(values.image && values.output, '--image and --output are required');
assert.equal(Boolean(values['keep-for-feedback']), Boolean(values.credentials),
  '--keep-for-feedback and --credentials must be specified together');
const scales = values.scales.split(',').map(Number);
const samples = Number(values.samples);
const bodyBytes = Number(values['body-bytes']);
const allCases = ['read-id', 'read-kind-page', 'read-unscoped-page', 'read-substring-page',
  'search-selective', 'search-common', 'query-page', 'query-substring'];
const selectedCases = values.cases ? values.cases.split(',') : allCases;
assert.ok(selectedCases.length && selectedCases.every(name => allCases.includes(name)), 'Unknown read case');
assert.ok(scales.length && scales.every((n, i) => Number.isSafeInteger(n) && n > 0 && (!i || n > scales[i - 1])), 'Scales must be increasing positive integers');
assert.ok(Number.isSafeInteger(samples) && samples > 0);
assert.ok(Number.isSafeInteger(bodyBytes) && bodyBytes >= 128 && bodyBytes <= 65536);
const output = resolve(values.output);
assert.ok(!values.credentials || resolve(values.credentials) !== output,
  'Credentials and report must use different files');
const run = randomUUID();
const name = `wm-document-benchmark-${run}`;
const volume = `${name}-data`;
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
  resources: { cpus: 1, memoryBytes: 1073741824, swapBytes: 1073741824 },
  workload: { scales, samplesPerReadCase: samples, bodyBytes, createConcurrency: 4,
    readConcurrency: [1, 4], readCases: selectedCases, kinds: ['Topic'], transport: 'Streamable HTTP MCP, one persistent session',
    notes: 'Deterministic ASCII Markdown; 100 evenly distributed category tokens, one unique token per document. Warm steady-state reads after complete insertion. Embeddings disabled. Loopback Docker network latency included.' },
  stages: [], cleanup: {},
};
let containerId, volumeCreated = false, token, session, url, requestId = 0;
let retained = false;
const interrupted = new AbortController();
for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => interrupted.abort(new Error(`Benchmark interrupted by ${signal}`)));
}
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
function percentile(sorted, fraction) {
  return sorted[Math.max(0, Math.ceil(sorted.length * fraction) - 1)] ?? null;
}
async function http(path, { method = 'GET', body, headers = {} } = {}) {
  const response = await fetch(`${url}${path}`, { method,
    headers: { Accept: 'application/json, text/event-stream', ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(body === undefined ? {} : { 'Content-Type': 'application/json' }), ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.any([AbortSignal.timeout(30000), interrupted.signal]),
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
  return JSON.parse(docker('exec', containerId, 'node', '--input-type=module', '-e', `
    import {readFileSync,readdirSync,statSync} from 'node:fs';
    const read = p => readFileSync(p,'utf8');
    const stat = Object.fromEntries(read('/sys/fs/cgroup/memory.stat').trim().split('\\n').map(x=>x.split(' ')).map(([k,v])=>[k,Number(v)]));
    const rss = Number(read('/proc/1/status').match(/^VmRSS:\\s+(\\d+)/m)?.[1] ?? 0)*1024;
    console.log(JSON.stringify({cgroupBytes:Number(read('/sys/fs/cgroup/memory.current')),
      cgroupPeakBytes:Number(read('/sys/fs/cgroup/memory.peak')),anonymousBytes:stat.anon,fileCacheBytes:stat.file,
      processRssBytes:rss,cpuStat:read('/sys/fs/cgroup/cpu.stat').trim(),
      dataFiles:readdirSync('/data').map(name=>({name,bytes:statSync('/data/'+name).size}))}));`));
}
async function measure(label, count, concurrency, action) {
  let next = 0;
  const latencies = [], errors = [];
  const before = memory();
  const start = performance.now();
  await Promise.all(Array.from({ length: concurrency }, async () => {
    while (next < count) {
      interrupted.signal.throwIfAborted();
      const i = next++;
      const t = performance.now();
      try { await action(i); }
      catch (error) { errors.push({ index: i, message: error.message }); }
      latencies.push(performance.now() - t);
    }
  }));
  const elapsedMs = performance.now() - start;
  latencies.sort((a, b) => a - b);
  const result = { label, count, concurrency, elapsedMs, successes: count - errors.length,
    errors: errors.length, errorExamples: errors.slice(0, 5),
    throughputPerSecond: (count - errors.length) / (elapsedMs / 1000),
    latencyMs: { p50: percentile(latencies, .5), p95: percentile(latencies, .95), max: latencies.at(-1) },
    memoryBefore: before, memoryAfter: memory() };
  console.log(JSON.stringify({ label, count, concurrency, errors: result.errors,
    throughputPerSecond: result.throughputPerSecond, latencyMs: result.latencyMs,
    cgroupPeakBytes: result.memoryAfter.cgroupPeakBytes, processRssBytes: result.memoryAfter.processRssBytes }));
  return result;
}
try {
  assert.ok(!docker('volume', 'ls', '--format', '{{.Name}}').split('\n').includes(volume),
    'Benchmark volume must not already exist');
  docker('volume', 'create', '--label', label, volume);
  volumeCreated = true;
  containerId = docker('run', '--detach', '--name', name, '--label', label,
    '--cpus', '1', '--memory', '1g', '--memory-swap', '1g',
    '--publish', '127.0.0.1::7717', '--mount', `type=volume,source=${volume},target=/data`,
    '--env', 'WM_CONTROL_PLANE_HOME=/data', '--env', 'WM_CONTROL_PLANE_HOST=0.0.0.0',
    '--env', 'WM_CONTROL_PLANE_PORT=7717', '--env', 'WM_HOST_TASK_ADMIN_TOKEN_FILE=/data/benchmark-admin-token',
    '--env', `WM_BENCHMARK_INDEX_SQL=${indexSql}`,
    image.Id, 'node', '--expose-gc', '--experimental-sqlite', '--input-type=module', '-e',
    `import {readFileSync,writeFileSync} from 'node:fs'; import {randomBytes} from 'node:crypto';
    if (process.env.WM_BENCHMARK_INDEX_SQL) {
      const path='./out/control-plane/store.js', source=readFileSync(path,'utf8');
      const anchor='CREATE INDEX IF NOT EXISTS idx_resources_kind ON resources (kind);';
      if (!source.includes(anchor)) throw new Error('Expected resource index initialization');
      if (!source.includes('CREATE INDEX IF NOT EXISTS idx_resources_live_kind_updated'))
        writeFileSync(path,source.replace(anchor,anchor+'\\n'+process.env.WM_BENCHMARK_INDEX_SQL));
    }
    writeFileSync('/data/benchmark-admin-token',randomBytes(32).toString('hex'),{mode:0o600});
    await import('./out/control-plane/index.js');`);
  const inspect = JSON.parse(docker('inspect', containerId))[0];
  assert.equal(inspect.HostConfig.NanoCpus, 1e9);
  assert.equal(inspect.HostConfig.Memory, 1073741824);
  assert.equal(inspect.HostConfig.MemorySwap, 1073741824);
  const binding = inspect.NetworkSettings.Ports['7717/tcp'][0];
  assert.equal(binding.HostIp, '127.0.0.1');
  url = `http://127.0.0.1:${binding.HostPort}`;
  report.container = { name, volume, url, id: containerId };
  for (let retry = 0; ; retry++) {
    try { report.health = await http('/health'); break; }
    catch (error) { if (retry >= 59) throw error; await sleep(1000); }
  }
  token = docker('exec', containerId, 'cat', '/data/benchmark-admin-token');
  const owner = await http('/identity/v1/setup', { method: 'POST', body: { password: randomBytes(32).toString('hex') } });
  token = owner.token;
  assert.ok(token, 'Setup must return an owner token');
  await http('/features/v2', { method: 'POST', body: { search: true } });
  await rpc('initialize', { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'isolated-document-benchmark', version: '1' } });
  await rpc('notifications/initialized', undefined, true);
  const type = await tool('wm-document-create', { kind: 'TopicType',
    spec: { label: values['keep-for-feedback'] ? 'User Story' : 'Synthetic benchmark',
      icon: 'beaker', description: 'Isolated performance test documents.' } });
  const topicType = type.metadata.id;
  const ids = [];
  const vocabulary = ['latency', 'database', 'rendering', 'deployment', 'migration', 'authentication', 'monitoring', 'backlog'];
  for (const scale of scales) {
    const from = ids.length;
    const stage = { documents: scale, measurements: [] };
    report.stages.push(stage);
    stage.measurements.push(await measure('create', scale - from, 4, async index => {
      const n = from + index;
      const prefix = `# Synthetic benchmark ${n}\ncategory${n % 100} unique${n} ${vocabulary[n % vocabulary.length]}\n`;
      const prose = 'Working memory evidence: investigate latency, document workflow and verify production behavior. ';
      const body = (prefix + prose.repeat(Math.ceil(bodyBytes / prose.length))).slice(0, bodyBytes);
      const doc = await tool('wm-document-create', { kind: 'Topic',
        spec: { title: `Synthetic document ${n}`, body, topicType } });
      ids[n] = doc.metadata.id;
    }));
    assert.equal(ids.filter(Boolean).length, scale, 'Stop if insertion failed; do not misreport scale');
    const counts = await tool('wm-document-query', { kind: 'Topic', limit: 1, bodyLimit: 1 });
    assert.equal(counts.total, scale);
    for (const concurrency of [1, 4]) {
      const cases = [
        ['read-id', i => tool('wm-document-read', { id: ids[(i * 7919) % scale] })],
        ['read-kind-page', () => tool('wm-document-read', { kind: 'Topic', limit: 20 })],
        ['read-unscoped-page', () => tool('wm-document-read', { limit: 20 })],
        ['read-substring-page', i => tool('wm-document-read', { kind: 'Topic', query: `category${i % 100}`, limit: 20 })],
        ['search-selective', i => tool('wm-document-search', { queries: [`unique${(i * 7919) % scale}`], limit: 20 })],
        ['search-common', () => tool('wm-document-search', { queries: ['latency'], limit: 20 })],
        ['query-page', () => tool('wm-document-query', { kind: 'Topic', limit: 20, bodyLimit: 2000 })],
        ['query-substring', i => tool('wm-document-query', { kind: 'Topic', query: `category${i % 100}`, limit: 20, bodyLimit: 2000 })],
      ];
      for (const [label, action] of cases.filter(([label]) => selectedCases.includes(label))) {
        await action(0);
        stage.measurements.push(await measure(label, samples, concurrency, action));
      }
    }
    await mkdir(dirname(output), { recursive: true });
    await writeFile(output, JSON.stringify(report, null, 2));
  }
  report.finalMemory = memory();
  report.errors = report.stages.flatMap(stage => stage.measurements).reduce((sum, value) => sum + value.errors, 0);
  if (report.errors) process.exitCode = 1;
  if (values['keep-for-feedback'] && !report.errors) {
    const credentials = resolve(values.credentials);
    await writeFile(credentials, JSON.stringify({ url, token, container: name, volume, topicType }, null, 2),
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
  if (retained) report.cleanup = { retainedForFeedback: true, container: name, volume };
  report.finishedAt = new Date().toISOString();
  await mkdir(dirname(output), { recursive: true });
  await writeFile(output, JSON.stringify(report, null, 2));
  console.log(JSON.stringify({ output, cleanup: report.cleanup, failure: report.failure }));
}
