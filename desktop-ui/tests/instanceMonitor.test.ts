import { randomUUID } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeAll, expect, it, vi } from 'vitest';
import { InstanceMonitor, deliverIncident, formatIncidentToolQueue, type MonitorProbe, type MonitorTarget } from '../src/main/instanceMonitor';
import { incidentReportRequestSchema, type InstanceIncident, type InstanceDiagnostics } from '../../control-plane/src/diagnosticContract';
import { startServer } from '../../control-plane/src/server';
import { openStore } from '../../control-plane/src/store';
import { InstanceIdentity } from '../../control-plane/src/instanceIdentity';
import { loadKinds } from '../../control-plane/src/kinds/loader';
import { ControlPlaneClient } from '../../shared/controlPlaneClient';
import { DesktopInstanceIdentity } from '../src/main/instanceIdentity';
import { HostTaskCredentialVault } from '../src/main/hostTaskBroker';
import { sessionSnapshotSchema } from '../../control-plane/src/sessionPolicy';

const cleanup: Array<() => Promise<void> | void> = [];
beforeAll(() => loadKinds());
afterEach(async () => { vi.useRealTimers(); vi.restoreAllMocks(); for (const close of cleanup.splice(0).reverse()) await close(); });

function fixture() {
  const directory = mkdtempSync(join(tmpdir(), 'wm-monitor-test-'));
  cleanup.push(() => rmSync(directory, { recursive: true, force: true }));
  const file = join(directory, 'incidents.json');
  let now = 1793733600000, selected: { mcpUrl: string } | null = { mcpUrl: 'http://127.0.0.1:7719/mcp' };
  let result: MonitorProbe = { healthy: true, bootId: randomUUID(), diagnostics: null, evidence: '' };
  const probe = vi.fn(async () => result);
  const deliver = vi.fn(async (_target: MonitorTarget, _incident: InstanceIncident, _current: () => boolean, _signal: AbortSignal) => randomUUID());
  const options = { file, selected: () => selected, probe, deliver, clock: () => now };
  const monitor = new InstanceMonitor(options);
  cleanup.push(() => monitor.stop());
  return { file, options, monitor, probe, deliver,
    select: (url: string | null) => { selected = url ? { mcpUrl: url } : null; },
    result: (patch: Partial<MonitorProbe>) => { result = { ...result, ...patch }; },
    advance: (ms = 10000) => { now += ms; },
  };
}

it('requires three failures, persists one outage across app restarts, and retries Inbox delivery without sending feedback', async () => {
  const f = fixture(), url = 'http://127.0.0.1:7719/mcp';
  await f.monitor.tick();
  f.result({ healthy: false, evidence: 'Health deadline exceeded; Docker OOM killed: false.' });
  for (let i = 0; i < 2; i++) { f.advance(); await f.monitor.tick(); }
  expect(f.monitor.incidents(url)).toHaveLength(0);
  f.advance(); await f.monitor.tick();
  expect(f.monitor.incidents(url)).toHaveLength(1);
  expect(f.deliver).not.toHaveBeenCalled();
  const restarted = new InstanceMonitor(f.options);
  cleanup.push(() => restarted.stop());
  await restarted.tick();
  expect(restarted.incidents(url)).toHaveLength(1);
  f.result({ healthy: true, bootId: randomUUID() });
  f.deliver.mockRejectedValueOnce(new Error('Owner sign-in required'));
  vi.spyOn(console, 'error').mockImplementation(() => {});
  await restarted.tick();
  await vi.waitFor(() => expect(restarted.incidents(url)[0]).toMatchObject({ kind: 'restart', topicId: null, deliveryError: 'Owner sign-in required' }));
  await restarted.tick();
  await vi.waitFor(() => expect(restarted.incidents(url)[0].topicId).not.toBeNull());
  expect(f.deliver).toHaveBeenCalledTimes(2);
  expect(JSON.parse(readFileSync(f.file, 'utf8')).incidents).toHaveLength(1);
});

it('persists detection evidence before capture and adds recovery evidence before delivering the report', async () => {
  const f = fixture(), url = 'http://127.0.0.1:7719/mcp';
  const captureEvidence = vi.fn(async (_target: MonitorTarget, _since: number, healthy: boolean) => {
    expect(JSON.parse(readFileSync(f.file, 'utf8')).incidents).toHaveLength(1);
    return healthy ? 'Recovered container logs and persisted tool history' : 'At-hang container logs: SQLITE_BUSY';
  });
  const monitor = new InstanceMonitor({ ...f.options, captureEvidence });
  cleanup.push(() => monitor.stop());
  await monitor.tick();
  f.result({ healthy: false });
  for (let i = 0; i < 3; i++) { f.advance(); await monitor.tick(); }
  const incident = monitor.incidents(url)[0];
  expect(incident.evidence).toContain('At-hang container logs: SQLITE_BUSY');
  expect(captureEvidence).toHaveBeenCalledWith({ mcpUrl: url }, incident.at - 120000, false, expect.any(AbortSignal));
  expect(f.deliver).not.toHaveBeenCalled();
  f.result({ healthy: true, bootId: randomUUID(), evidence: 'Container restarted' });
  await monitor.tick();
  await vi.waitFor(() => expect(monitor.incidents(url)[0].topicId).not.toBeNull());
  const delivered = f.deliver.mock.calls[0][1];
  expect(delivered.kind).toBe('restart');
  expect(delivered.evidence).toContain('At-hang container logs: SQLITE_BUSY');
  expect(delivered.evidence).toContain('Recovery observation');
  expect(delivered.evidence).toContain('Recovered container logs and persisted tool history');
});

it('bounds capture deadlines and report size without losing the queued incident', async () => {
  vi.useFakeTimers();
  const f = fixture(), url = 'http://127.0.0.1:7719/mcp';
  const captureEvidence = vi.fn()
    .mockImplementationOnce(() => new Promise<string>(() => {}))
    .mockResolvedValue('x'.repeat(50000));
  const monitor = new InstanceMonitor({ ...f.options, captureEvidence });
  cleanup.push(() => monitor.stop());
  vi.spyOn(console, 'error').mockImplementation(() => {});
  f.result({ healthy: false });
  await monitor.tick(); await monitor.tick();
  const pending = monitor.tick();
  await vi.advanceTimersByTimeAsync(10000);
  await pending;
  expect(monitor.incidents(url)[0].evidence).toContain('10-second deadline');
  expect(JSON.parse(readFileSync(f.file, 'utf8')).incidents).toHaveLength(1);
  f.result({ healthy: true });
  await monitor.tick();
  await vi.advanceTimersByTimeAsync(0);
  const incident = monitor.incidents(url)[0];
  expect(incident.evidence.length).toBeLessThanOrEqual(20000);
  expect(incident.evidence).toContain('Evidence truncated');
  const { id, environment, at, kind, evidence } = incident;
  expect(incidentReportRequestSchema.safeParse({ id, environment, at, kind, evidence }).success).toBe(true);
  expect(incident.topicId).not.toBeNull();
});

it('never appends or delivers capture results after the selected environment changes', async () => {
  const f = fixture(), url = 'http://127.0.0.1:7719/mcp';
  let release!: (evidence: string) => void;
  const captureEvidence = vi.fn(() => new Promise<string>(resolve => { release = resolve; }));
  const monitor = new InstanceMonitor({ ...f.options, captureEvidence });
  cleanup.push(() => monitor.stop());
  f.result({ healthy: false });
  await monitor.tick(); await monitor.tick();
  const pending = monitor.tick();
  await vi.waitFor(() => expect(captureEvidence).toHaveBeenCalledOnce());
  f.select('http://127.0.0.1:7721/mcp');
  release('Stale capture result');
  await pending;
  expect(monitor.incidents(url)[0].evidence).not.toContain('Stale capture result');
  expect(f.deliver).not.toHaveBeenCalled();
  expect(monitor.incidents('http://127.0.0.1:7721/mcp')).toEqual([]);
});

it('recovers persisted tool activity for a 50-document batch after a real backend restart', async () => {
  const f = fixture();
  const database = join(dirname(f.file), 'batch.sqlite');
  let store = openStore(database);
  const owner = await new InstanceIdentity(store.db).initialize('private batch test password');
  let server = await startServer({ port: 0, store });
  cleanup.push(async () => { await server.close(); store.close(); });
  const url = `${server.url}/mcp`, port = Number(new URL(server.url).port);
  const client = new ControlPlaneClient({ resolveUrl: () => url, getToken: () => owner.token });
  cleanup.push(() => client.dispose());
  const vault = new HostTaskCredentialVault({
    isEncryptionAvailable: () => false, encryptString: vi.fn(), decryptString: vi.fn(),
  }, process.platform, '/not-used');
  vault.setSession(server.url, owner.token, owner.expiresAt);
  const identity = new DesktopInstanceIdentity(vault, async () => '', () => false);
  f.select(url);
  f.result({ diagnostics: await identity.diagnostics(url) });
  const captureEvidence = vi.fn(async (_target: MonitorTarget, _since: number, healthy: boolean) => healthy
    ? formatIncidentToolQueue(await identity.toolQueue(url), Date.now()) : 'Container evidence captured during outage');
  const monitor = new InstanceMonitor({
    ...f.options, captureEvidence,
    deliver: (_target, incident, current, signal) => deliverIncident(identity, incident, current, signal),
  });
  cleanup.push(() => monitor.stop());
  await monitor.tick();
  const topicType = await client.topicTypeCreate({ label: 'Topic', icon: 'file', description: 'Batch fixture' });
  for (let i = 0; i < 50; i++) {
    expect((await client.createDocument({ kind: 'Topic', spec: {
      title: `private batch title ${i}`, body: 'private document contents', topicType: topicType.id,
    } })).available).toBe(true);
  }
  expect(store.listDocuments({ kind: 'Topic' })).toHaveLength(50);
  f.result({ healthy: false, diagnostics: null });
  await monitor.tick(); await monitor.tick(); await monitor.tick();
  await client.dispose();
  await server.close();
  store.close();
  store = openStore(database);
  server = await startServer({ port, store });
  const diagnostics = await vi.waitFor(() => identity.diagnostics(url));
  f.result({ healthy: true, bootId: diagnostics.bootId, diagnostics });
  await monitor.tick();
  await vi.waitFor(() => expect(monitor.incidents(url)[0].topicId).not.toBeNull());
  const incident = monitor.incidents(url)[0];
  const report = store.getDocument({ id: incident.topicId!, kind: 'Topic' })!;
  expect(report.spec.body).toContain('Recovery observation');
  expect(report.spec.body).toContain('wm-document-create completed');
  expect(report.spec.body).toContain('153 lifecycle events, not a complete request count');
  expect(report.spec.body).toContain('wm-document-create: completed 50, started 50, queued 50');
  expect(report.spec.body).not.toContain('private batch title');
  expect(report.spec.body).not.toContain('private document contents');
  expect(store.listDocuments({ kind: 'Topic' })).toHaveLength(51);
});

it('does not confuse successful health probes, transient failures, environment changes or intentional upgrades with crashes', async () => {
  const f = fixture(), url = 'http://127.0.0.1:7719/mcp';
  await f.monitor.tick();
  for (let i = 0; i < 5; i++) {
    f.result({ healthy: false }); await f.monitor.tick();
    f.result({ healthy: true }); await f.monitor.tick();
  }
  expect(f.monitor.incidents(url)).toHaveLength(0);
  f.probe.mockImplementationOnce(async () => {
    f.select('http://127.0.0.1:7720/mcp');
    return { healthy: false, bootId: null, diagnostics: null, evidence: '' };
  });
  await f.monitor.tick();
  expect(f.monitor.incidents(url)).toHaveLength(0);
  const resume = f.monitor.suspend('http://127.0.0.1:7720/mcp');
  const calls = f.probe.mock.calls.length;
  await f.monitor.tick();
  expect(f.probe).toHaveBeenCalledTimes(calls);
  resume();
  f.result({ bootId: randomUUID() });
  await f.monitor.tick();
  expect(f.monitor.incidents('http://127.0.0.1:7720/mcp')).toHaveLength(0);
});

it('deduplicates memory episodes and throttles event-loop incident reports at exact thresholds', async () => {
  const f = fixture(), url = 'http://127.0.0.1:7719/mcp', requestId = randomUUID(), bootId = randomUUID();
  const diagnostics: InstanceDiagnostics = {
    bootId, version: '1.4.1', startedAt: 1793733600000, observedAt: 1793733600000,
    runtime: { heapUsedBytes: 600, heapLimitBytes: 1000, rssBytes: 900, admissionBlocked: true,
      eventLoopMaxMs: 1000, activeRequests: 0, activeSessions: 2 },
    minutes: [], callers: [], events: [{ sequence: 1, at: 1793733600000, code: 'event_loop_stall',
      requestId: null, route: '/runtime', status: 0, durationMs: 1000, count: 1 }],
    samples: [{ at: 1793733600000, bootId, heapUsedBytes: 600, heapLimitBytes: 1000, rssBytes: 900,
      externalBytes: 10, arrayBufferBytes: 1, cpuPercent: 25, eventLoopMaxMs: 1000,
      gcCount: 2, gcDurationMs: 10, queueDepth: 1, runningTools: 0, operations: [] }],
    workQueue: { limits: { running: 4, waiting: 16, waitMs: 5000 }, memoryBlocked: true, running: 0, waiting: 1,
      items: [{ requestId, operation: 'wm-document-query', caller: 'owner', queuedAt: 1793733599000 }],
      events: [{ sequence: 1, at: 1793733600000, requestId, operation: 'wm-document-query', caller: 'owner',
        event: 'completed', waiting: 1, running: 0, waitMs: 0, runMs: 1100 }] },
  };
  f.result({ diagnostics });
  await f.monitor.tick(); await f.monitor.tick();
  expect(f.monitor.incidents(url).map(incident => incident.kind).sort()).toEqual(['event_loop_stall', 'memory_pressure']);
  for (const incident of f.monitor.incidents(url)) {
    expect(incident.evidence).toContain('CPU 25.0%, GC 2/10.0 ms');
    expect(incident.evidence).toContain('wm-document-query, waiting 1000 ms');
    expect(incident.evidence).toContain('wm-document-query completed, wait 0 ms, run 1100 ms');
  }
  f.advance();
  diagnostics.events[0].at += 10000;
  await f.monitor.tick();
  expect(f.monitor.incidents(url)).toHaveLength(2);
  diagnostics.runtime.admissionBlocked = false;
  await f.monitor.tick();
  diagnostics.runtime.admissionBlocked = true;
  await f.monitor.tick();
  expect(f.monitor.incidents(url).filter(incident => incident.kind === 'memory_pressure')).toHaveLength(2);
});

it('preserves a corrupt incident queue instead of overwriting reports', () => {
  const f = fixture();
  writeFileSync(f.file, 'corrupt local queue');
  expect(() => new InstanceMonitor(f.options)).toThrow();
  expect(readFileSync(f.file, 'utf8')).toBe('corrupt local queue');
});

it('includes normalized routes in pre-outage evidence so historical long polls are identifiable', async () => {
  const f = fixture(), url = 'http://127.0.0.1:7719/mcp';
  f.result({ diagnostics: {
    bootId: randomUUID(), version: '1.4.1', startedAt: 1793733600000, observedAt: 1793733600000,
    runtime: { heapUsedBytes: 100, heapLimitBytes: 1000, rssBytes: 200, admissionBlocked: false,
      eventLoopMaxMs: 20, activeRequests: 1, activeSessions: 2 },
    minutes: [], callers: [], events: [{ sequence: 1, at: 1793733600000, code: 'slow_request',
      requestId: null, route: '/changes', status: 200, durationMs: 25000, count: 2 }],
  } });
  await f.monitor.tick();
  f.result({ healthy: false });
  for (let index = 0; index < 3; index++) { f.advance(); await f.monitor.tick(); }
  expect(f.monitor.incidents(url)).toEqual([
    expect.objectContaining({ kind: 'outage', evidence: expect.stringContaining('slow_request /changes: HTTP 200, 25000 ms, count 2') }),
  ]);
});

it('creates one open Inbox Bug topic and deduplicates an ambiguous successful write', async () => {
  const store = openStore(':memory:');
  const owner = await new InstanceIdentity(store.db).initialize('private inbox test password');
  const server = await startServer({ port: 0, store });
  const client = new ControlPlaneClient({ resolveUrl: () => `${server.url}/mcp`, getToken: () => owner.token });
  const vault = new HostTaskCredentialVault({
    isEncryptionAvailable: () => false, encryptString: vi.fn(), decryptString: vi.fn(),
  }, process.platform, '/not-used');
  vault.setSession(server.url, owner.token, owner.expiresAt);
  const identity = new DesktopInstanceIdentity(vault, async () => '', () => false);
  cleanup.push(() => store.close(), () => server.close(), () => client.dispose());
  const bug = await client.topicTypeCreate({ label: 'Bug', icon: 'bug', description: 'Crash reports' });
  const incident: InstanceIncident = { id: randomUUID(), environment: `${server.url}/mcp`,
    at: Date.now(), kind: 'outage', evidence: 'Three probes failed.', topicId: null, deliveryError: null };
  const list = vi.spyOn(store, 'listDocuments').mockImplementation(() => { throw new Error('Unbounded document materialization'); });
  const id = await deliverIncident(identity, incident, () => true);
  expect(await deliverIncident(identity, incident, () => true)).toBe(id);
  expect(list).not.toHaveBeenCalled();
  list.mockRestore();
  expect(await client.wsRead()).toEqual([expect.objectContaining({ title: 'Inbox', status: 'progress' })]);
  expect(await client.topicRead()).toEqual([expect.objectContaining({ id, topicType: bug.id, status: 'open' })]);
  const topics = await client.listDocuments('Topic');
  expect(topics.documents[0].metadata.labels['wm.incident']).toBe(incident.id);
  expect(topics.documents[0].spec.body).toContain('Send feedback when ready');
  const [inbox] = await client.wsRead();
  await client.wsUpdate({ id: inbox.id, status: 'closed', closure: 'User closed Inbox' });
  await expect(deliverIncident(identity, { ...incident, id: randomUUID() }, () => true)).rejects.toThrow('Inbox is closed');
  expect((await client.wsRead())[0].status).toBe('closed');
  await expect(deliverIncident(identity, { ...incident, id: randomUUID() }, () => false)).rejects.toThrow('Selected environment changed');
  expect(await client.topicRead()).toHaveLength(1);
});

it('rejects pre-upgrade probe results even if the upgrade resumes before the probe completes', async () => {
  const f = fixture(), url = 'http://127.0.0.1:7719/mcp';
  await f.monitor.tick();
  let release!: (probe: MonitorProbe) => void;
  f.probe.mockImplementationOnce(() => new Promise(resolve => { release = resolve; }));
  const pending = f.monitor.tick();
  const resume = f.monitor.suspend(url);
  resume();
  release({ healthy: true, bootId: 'old-boot', diagnostics: null, evidence: '' });
  await pending;
  f.result({ bootId: randomUUID() });
  await f.monitor.tick();
  expect(f.monitor.incidents(url)).toHaveLength(0);
});

it('continues probing and saves manual reports while delivery stalls, with a bounded delivery deadline', async () => {
  vi.useFakeTimers();
  const f = fixture(), url = 'http://127.0.0.1:7719/mcp';
  vi.spyOn(console, 'error').mockImplementation(() => {});
  f.result({ healthy: false });
  await f.monitor.tick(); await f.monitor.tick(); await f.monitor.tick();
  f.result({ healthy: true });
  f.deliver.mockImplementationOnce(() => new Promise(() => {}));
  await f.monitor.tick();
  const calls = f.probe.mock.calls.length;
  await f.monitor.tick();
  expect(f.probe).toHaveBeenCalledTimes(calls + 1);
  const snapshot = sessionSnapshotSchema.parse({
    startedAt: 123, policy: { idleMinutes: 60, maxPerClient: 100, maxTotal: 500, handshakesPerMinute: 1000, retentionDays: 10 },
    memory: { heapUsedBytes: 600, heapLimitBytes: 1000, admissionThresholdBytes: 600, admissionBlocked: true },
    active: [], events: [], nextCursor: null,
  });
  const save = vi.fn(async () => randomUUID());
  expect(await f.monitor.recordMemoryReport({ mcpUrl: url }, snapshot, save)).toBeTruthy();
  expect(save).toHaveBeenCalledOnce();
  await vi.advanceTimersByTimeAsync(10000);
  expect(f.monitor.incidents(url)[0].deliveryError).toContain('10-second deadline');
  await f.monitor.tick();
  await vi.advanceTimersByTimeAsync(0);
  expect(f.monitor.incidents(url)[0].topicId).not.toBeNull();
});
