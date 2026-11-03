import { randomUUID } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeAll, expect, it, vi } from 'vitest';
import { InstanceMonitor, deliverIncident, type MonitorProbe } from '../src/main/instanceMonitor';
import { type InstanceIncident, type InstanceDiagnostics } from '../../control-plane/src/diagnosticContract';
import { startServer } from '../../control-plane/src/server';
import { openStore } from '../../control-plane/src/store';
import { InstanceIdentity } from '../../control-plane/src/instanceIdentity';
import { loadKinds } from '../../control-plane/src/kinds/loader';
import { ControlPlaneClient } from '../../shared/controlPlaneClient';

const cleanup: Array<() => Promise<void> | void> = [];
beforeAll(() => loadKinds());
afterEach(async () => { vi.restoreAllMocks(); for (const close of cleanup.splice(0).reverse()) await close(); });

function fixture() {
  const directory = mkdtempSync(join(tmpdir(), 'wm-monitor-test-'));
  cleanup.push(() => rmSync(directory, { recursive: true, force: true }));
  const file = join(directory, 'incidents.json');
  let now = 1793733600000, selected: { mcpUrl: string } | null = { mcpUrl: 'http://127.0.0.1:7719/mcp' };
  let result: MonitorProbe = { healthy: true, bootId: randomUUID(), diagnostics: null, evidence: '' };
  const probe = vi.fn(async () => result);
  const deliver = vi.fn(async () => randomUUID());
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
  expect(restarted.incidents(url)[0]).toMatchObject({ kind: 'restart', topicId: null, deliveryError: 'Owner sign-in required' });
  await restarted.tick();
  expect(restarted.incidents(url)[0].topicId).not.toBeNull();
  expect(f.deliver).toHaveBeenCalledTimes(2);
  expect(JSON.parse(readFileSync(f.file, 'utf8')).incidents).toHaveLength(1);
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
  const f = fixture(), url = 'http://127.0.0.1:7719/mcp';
  const diagnostics: InstanceDiagnostics = {
    bootId: randomUUID(), version: '1.4.1', startedAt: 1793733600000, observedAt: 1793733600000,
    runtime: { heapUsedBytes: 600, heapLimitBytes: 1000, rssBytes: 900, admissionBlocked: true,
      eventLoopMaxMs: 1000, activeRequests: 0, activeSessions: 2 },
    minutes: [], callers: [], events: [{ sequence: 1, at: 1793733600000, code: 'event_loop_stall',
      requestId: null, route: '/runtime', status: 0, durationMs: 1000, count: 1 }],
  };
  f.result({ diagnostics });
  await f.monitor.tick(); await f.monitor.tick();
  expect(f.monitor.incidents(url).map(incident => incident.kind).sort()).toEqual(['event_loop_stall', 'memory_pressure']);
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

it('creates one open Inbox Bug topic and deduplicates an ambiguous successful write', async () => {
  const store = openStore(':memory:');
  const owner = await new InstanceIdentity(store.db).initialize('private inbox test password');
  const server = await startServer({ port: 0, store });
  const client = new ControlPlaneClient({ resolveUrl: () => `${server.url}/mcp`, getToken: () => owner.token });
  cleanup.push(() => store.close(), () => server.close(), () => client.dispose());
  const bug = await client.topicTypeCreate({ label: 'Bug', icon: 'bug', description: 'Crash reports' });
  const incident: InstanceIncident = { id: randomUUID(), environment: `${server.url}/mcp`,
    at: Date.now(), kind: 'outage', evidence: 'Three probes failed.', topicId: null, deliveryError: null };
  const id = await deliverIncident(client, incident, () => true);
  expect(await deliverIncident(client, incident, () => true)).toBe(id);
  expect(await client.wsRead()).toEqual([expect.objectContaining({ title: 'Inbox', status: 'progress' })]);
  expect(await client.topicRead()).toEqual([expect.objectContaining({ id, topicType: bug.id, status: 'open' })]);
  const topics = await client.listDocuments('Topic');
  expect(topics.documents[0].metadata.labels['wm.incident']).toBe(incident.id);
  expect(topics.documents[0].spec.body).toContain('Send feedback when ready');
  const [inbox] = await client.wsRead();
  await client.wsUpdate({ id: inbox.id, status: 'closed', closure: 'User closed Inbox' });
  await expect(deliverIncident(client, { ...incident, id: randomUUID() }, () => true)).rejects.toThrow('Inbox is closed');
  expect((await client.wsRead())[0].status).toBe('closed');
  await expect(deliverIncident(client, { ...incident, id: randomUUID() }, () => false)).rejects.toThrow('Selected environment changed');
  expect(await client.topicRead()).toHaveLength(1);
});
