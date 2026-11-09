import assert from 'node:assert/strict';
import { Session } from 'node:inspector/promises';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { performance, monitorEventLoopDelay } from 'node:perf_hooks';
import { getHeapSpaceStatistics } from 'node:v8';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { startServer } from '../out/control-plane/server.js';
import { openStore } from '../out/control-plane/store.js';
import { InstanceIdentity } from '../out/control-plane/instanceIdentity.js';
import { loadKinds } from '../out/control-plane/kinds/loader.js';

if (!global.gc || !process.argv[2]) throw new Error('Run node --expose-gc scripts/test-mcp-heap.mjs <output-directory> after npm run compile.');
const output = resolve(process.argv[2]);
await mkdir(output, { recursive: true });
await loadKinds();
const store = openStore(':memory:');
let now = Date.now();
const identity = new InstanceIdentity(store.db, () => now);
const owner = await identity.initialize('synthetic heap reproduction password');
const server = await startServer({ port: 0, store, hostTaskClock: () => now, sessionDiagnostics: { clock: () => now } });
const profiler = new Session();
profiler.connect();
const lag = monitorEventLoopDelay({ resolution: 20 });
lag.enable();
const samples = [], latencies = [];
const headers = { Authorization: `Bearer ${owner.token}`, 'Content-Type': 'application/json' };
const diagnostics = async () => {
  const response = await fetch(`${server.url}/identity/v1/sessions`, { headers });
  assert.equal(response.status, 200);
  return response.json();
};
const tick = () => new Promise(resolve => setImmediate(resolve));
function allocationOwners(profile) {
  const totals = new Map();
  const walk = (node, stack = []) => {
    const frame = { function: node.callFrame.functionName || '(anonymous)', file: node.callFrame.url,
      line: node.callFrame.lineNumber + 1 };
    const next = [...stack, frame];
    if (node.selfSize) {
      const owner = [...next].reverse().find(entry => entry.file.includes('/control-plane/')) ?? frame;
      const key = `${owner.file}:${owner.line}:${owner.function}`;
      const value = totals.get(key) ?? { ...owner, sampledBytes: 0 };
      value.sampledBytes += node.selfSize;
      totals.set(key, value);
    }
    for (const child of node.children) walk(child, next);
  };
  walk(profile.head);
  return [...totals.values()].sort((a, b) => b.sampledBytes - a.sampledBytes).slice(0, 30);
}
async function sample(label) {
  await tick(); global.gc(); await tick(); global.gc(); await tick();
  const snapshot = await diagnostics();
  const memory = process.memoryUsage();
  const value = { label, heapUsed: memory.heapUsed, rss: memory.rss, activeSessions: snapshot.active.length,
    heapSpaces: getHeapSpaceStatistics().map(space => ({ name: space.space_name, used: space.space_used_size })) };
  samples.push(value);
  console.log(JSON.stringify(value));
  return value;
}
async function connect() {
  const client = new Client({ name: 'synthetic-heap-reconnect', version: '1' });
  const transport = new StreamableHTTPClientTransport(new URL('/mcp', server.url), {
    requestInit: { headers },
    fetch: (input, init) => init?.method === 'GET' ? Promise.resolve(new Response(null, { status: 405 })) : fetch(input, init),
  });
  const start = performance.now();
  try {
    await client.connect(transport);
    await client.listTools();
    await client.callTool({ name: 'wm-ping', arguments: {} });
    latencies.push(performance.now() - start);
    return { client, transport };
  } catch (error) {
    await client.close();
    throw error;
  }
}
try {
  const policy = await fetch(`${server.url}/identity/v1/sessions`, { method: 'POST', headers,
    body: JSON.stringify({ idleMinutes: 1, maxPerClient: 1000, maxTotal: 1000, handshakesPerMinute: 100000, retentionDays: 10 }) });
  assert.equal(policy.status, 200);
  await profiler.post('HeapProfiler.startSampling', { samplingInterval: 32768 });
  for (let i = 0; i < 20; i++) {
    const { client, transport } = await connect();
    await transport.terminateSession(); await client.close();
  }
  for (let i = 0; i < 512; i++) {
    store.createDocument({ kind: 'Topic', spec: {
      title: `Synthetic heap topic ${i}`, body: 'Synthetic allocation diagnostic text. '.repeat(58),
    } });
  }
  const reader = await connect();
  const readAllTopics = async () => {
    const response = await reader.client.callTool({ name: 'ws-topic-read', arguments: {} });
    assert.notEqual(response.isError, true);
    assert.ok(JSON.stringify(response).length > 1048576, 'Exercise responses larger than 1 MiB.');
  };
  for (let i = 0; i < 5; i++) await readAllTopics();
  const readBaseline = await sample('open-session-large-response-warmup');
  let openReadPeakHeapUsed = readBaseline.heapUsed;
  for (let i = 0; i < 100; i++) {
    await readAllTopics();
    openReadPeakHeapUsed = Math.max(openReadPeakHeapUsed, process.memoryUsage().heapUsed);
  }
  const readFinal = await sample('open-session-after-100-large-responses');
  assert.equal(readFinal.activeSessions, 1, 'Measure response retention before terminating the session.');
  const openSessionResponseGrowthBytes = readFinal.heapUsed - readBaseline.heapUsed;
  assert.ok(openSessionResponseGrowthBytes <= 16 * 1048576,
    'Completed JSON responses retained more than 16 MiB across 100 large reads in one open session.');
  await reader.transport.terminateSession(); await reader.client.close();
  const baseline = await sample('warmup');
  for (let batch = 1; batch <= 10; batch++) {
    for (let i = 0; i < 100; i++) {
      const { client, transport } = await connect();
      await transport.terminateSession(); await client.close();
    }
    const value = await sample(`clean-reconnects-${batch * 100}`);
    assert.equal(value.activeSessions, 0, 'Explicit DELETE must reclaim every session.');
  }
  const cleanFinal = samples.at(-1);
  for (let i = 0; i < 100; i++) {
    const { client } = await connect();
    await client.close();
  }
  const abandoned = await sample('client-close-without-delete-100');
  assert.equal(abandoned.activeSessions, 100, 'Client.close alone should leave server sessions until idle expiry.');
  const abandonedProfile = (await profiler.post('HeapProfiler.getSamplingProfile')).profile;
  await writeFile(join(output, 'mcp-abandoned-sessions.heapprofile'), JSON.stringify(abandonedProfile));
  const abandonedAllocationOwners = allocationOwners(abandonedProfile);
  console.log(JSON.stringify({ abandonedAllocationOwners }));
  now += 61000;
  // Admission invokes the same sweep used by the production cleanup timer.
  const { client, transport } = await connect();
  await transport.terminateSession(); await client.close();
  await tick(); await tick();
  const reclaimed = await sample('after-idle-expiry');
  assert.equal(reclaimed.activeSessions, 0, 'Idle expiry must reclaim abandoned session resources.');
  for (let i = 0; i < 100; i++) {
    const start = performance.now();
    const response = await fetch(`${server.url}/mcp`, { method: 'POST',
      headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({
        jsonrpc: '2.0', id: 1, method: 'initialize',
        params: { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'synthetic-unauthenticated', version: '1' } },
      }) });
    assert.equal(response.status, 401);
    assert.ok(response.headers.get('www-authenticate'));
    await response.text();
    assert.ok(performance.now() - start < 1000, 'A local OAuth challenge must not turn into a timeout.');
  }
  await sample('after-100-auth-challenges');
  const { profile } = await profiler.post('HeapProfiler.stopSampling');
  await writeFile(join(output, 'mcp-allocation.heapprofile'), JSON.stringify(profile));
  const allocations = [];
  const walk = node => {
    if (node.selfSize) allocations.push({ function: node.callFrame.functionName || '(anonymous)',
      file: node.callFrame.url, line: node.callFrame.lineNumber + 1, sampledBytes: node.selfSize });
    for (const child of node.children) walk(child);
  };
  walk(profile.head);
  latencies.sort((a, b) => a - b);
  const report = {
    runtime: process.version, syntheticDataOnly: true, reconnects: 1000,
    openSessionLargeReads: 100, openSessionResponseGrowthBytes, openReadPeakHeapUsed,
    cleanHeapGrowthBytes: cleanFinal.heapUsed - baseline.heapUsed,
    cleanHeapGrowthRatio: cleanFinal.heapUsed / baseline.heapUsed,
    abandonedSessionHeapBytes: abandoned.heapUsed - cleanFinal.heapUsed,
    recoveredHeapBytes: abandoned.heapUsed - reclaimed.heapUsed,
    connectionAndDiscoveryP95Ms: latencies[Math.floor(latencies.length * 0.95)],
    connectionAndDiscoveryMaxMs: latencies.at(-1), eventLoopMaxMs: lag.max / 1e6,
    samples, abandonedAllocationOwners,
    largestSampledAllocations: allocations.sort((a, b) => b.sampledBytes - a.sampledBytes).slice(0, 20),
    regressionBudget: { openSessionResponseGrowthBytes: 16 * 1048576,
      abandonedBytesPerSession: 1048576, cleanHeapGrowthRatio: 1.2, connectionP95Ms: 1000 },
  };
  await writeFile(join(output, 'mcp-heap-report.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify({ ...report, samples: undefined, abandonedAllocationOwners: undefined, largestSampledAllocations: undefined }));
  assert.ok(report.abandonedSessionHeapBytes / 100 <= report.regressionBudget.abandonedBytesPerSession,
    'Retained session heap exceeded the 1 MiB/session regression budget.');
  assert.ok(report.cleanHeapGrowthRatio <= report.regressionBudget.cleanHeapGrowthRatio,
    'Post-GC heap grew more than 20% across 1,000 clean reconnects.');
  assert.ok(report.connectionAndDiscoveryP95Ms < report.regressionBudget.connectionP95Ms,
    'Local initialization + discovery + ping p95 exceeded one second.');
} finally {
  lag.disable(); profiler.disconnect();
  await server.close(); store.close();
}
