import { afterEach, describe, expect, it } from 'vitest';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { openStore, type Store } from '../control-plane/src/store';
import {
  HostTaskBroker, HOST_TASK_BLOCKED_REASON, HOST_TASK_OPERATION, HOST_TASK_OPERATION_HASH,
  hostTaskHash, isHostTaskCredential as backendCredential, type HostTaskExecutionFixture, type HostTaskFixtureSnapshot,
} from '../control-plane/src/hostTasks';
import { canonicalHostTaskChunkJson, canonicalHostTaskPolicyJson, canonicalHostTaskStateMetadataJson, isHostTaskCredential, type HostTaskOperation, type HostTaskRecord } from '../shared/hostTasks';

const sid = 'S-1-5-21-123-456-789-1001';
const tenant = '12345678-1234-4234-8234-123456789012';
const admin = randomBytes(32).toString('hex');
const approvalBinding = { operationHash: HOST_TASK_OPERATION_HASH, operationVersion: HOST_TASK_OPERATION.version };
const stores: Store[] = [];
const dirs: string[] = [];
afterEach(() => {
  stores.splice(0).forEach(s => { try { s.close(); } catch { /* Already closed for restart. */ } });
  dirs.splice(0).forEach(d => fs.rmSync(d, { recursive: true, force: true }));
});
function fixture(enabled = true, durable = false) {
  let now = Date.parse('2026-10-20T12:00:00Z');
  let verified = true;
  let evidence: HostTaskFixtureSnapshot = {
    asOf: new Date(now).toISOString(), membershipIds: [1], detailIds: [1],
    recordHashes: { '1': hostTaskHash(record()) },
    memberStates: [{ id: 1, type: 'Task', state: 'Active' }],
    stateMetadata: [{ type: 'Task', state: 'Active', category: 'InProgress' }],
  };
  const bridge: HostTaskExecutionFixture = {
    fixtureOnly: true,
    verifyIdentity: identity => verified && identity.windowsSid === sid && identity.tenantId === tenant,
    snapshotEvidence: () => evidence,
  };
  let filename = ':memory:';
  if (durable) {
    const dir = fs.mkdtempSync(path.resolve('.host-task-tests-'));
    dirs.push(dir);
    filename = path.join(dir, 'broker.sqlite');
  }
  let store = openStore(filename);
  stores.push(store);
  const options = { hostTaskAdminCredential: admin, hostTaskClock: () => now,
    hostTaskExecutionFixture: enabled ? bridge : undefined };
  let broker = new HostTaskBroker(store.db, options);
  broker.features.write({ hostTasks: true });
  const call = (p: string, body?: unknown, token = admin, method = 'POST') =>
    broker.dispatch(method, p, token, body).body as any;
  const app = call('/admin/apps', { label: 'Trusted desktop', instanceId: randomUUID() });
  const grant = call('/admin/grants', { ...approvalBinding, appId: app.appId, windowsSid: sid, tenantId: tenant, expiresAt: now + 3600000 });
  const runner = enabled ? call('/admin/runners', { windowsSid: sid, tenantId: tenant }) : undefined;
  const request = (key = 'request-1', extra: object = {}, token = app.credential) =>
    call('/requests', { capability: 'thrive.sync.read', idempotencyKey: key, ...extra }, token);
  const claim = () => call('/runner/claim', {}, runner.credential);
  const status = (id: string) => call(`/jobs/${id}`, undefined, app.credential, 'GET');
  const result = (lease: any, records = [record()]) => ({
    jobId: lease.jobId, attempt: lease.attempt, leaseToken: lease.leaseToken,
    appId: lease.appId, grantId: lease.grantId, grantGeneration: lease.grantGeneration,
    schemaVersion: 1, mode: lease.request.mode, asOf: evidence.asOf,
    membershipIds: [...evidence.membershipIds],
    removedIds: lease.request.knownIds.filter((id: number) => !evidence.membershipIds.includes(id)),
    dataComplete: true,
    classificationComplete: evidence.detailIds.length === evidence.membershipIds.length && evidence.memberStates.every(member => {
      const row = evidence.stateMetadata.find(row => row.type === member.type && row.state === member.state);
      return ['Proposed', 'InProgress', 'Resolved', 'Completed', 'Removed'].includes(row?.category ?? '');
    }),
    stateMetadata: evidence.stateMetadata.map(row => ({ ...row })), stateMetadataVersion: 1,
    stateMetadataHash: createHash('sha256').update(canonicalHostTaskStateMetadataJson(evidence.stateMetadata), 'utf8').digest('hex'),
    policyHash: lease.policyHash, operationHash: HOST_TASK_OPERATION_HASH, requestHash: lease.requestHash, recordCount: records.length,
    chunks: records.length ? [{ index: 0, records, sha256: hostTaskHash(records) }] : [],
  });
  return {
    app, grant, runner, bridge, call, request, claim, status, result,
    get store() { return store; },
    get broker() { return broker; },
    get now() { return now; },
    advance: (ms: number) => { now += ms; },
    verify: (value: boolean) => { verified = value; },
    evidence: (value: Partial<HostTaskFixtureSnapshot>) => {
      evidence = { ...evidence, ...value,
        memberStates: value.memberStates ?? (value.membershipIds
          ? value.membershipIds.map(id => ({ id, type: 'Task', state: 'Active' })) : evidence.memberStates) };
    },
    restart: () => {
      store.close();
      store = openStore(filename); stores.push(store);
      broker = new HostTaskBroker(store.db, options);
    },
  };
}
function record(id = 1) {
  return {
    id, title: 'Synthetic fixture work item', state: 'Active', assignedTo: 'mkubarycz@microsoft.com',
    createdBy: null, type: 'Task', revision: 1, classification: 'OPEN' as const,
    areaPath: 'Customers\\Other', changedAt: '2026-10-20T11:00:00Z',
    url: `https://dev.azure.com/CXPPMO/Customers/_workitems/edit/${id}`,
  };
}
const rejects = (fn: () => unknown, code: string) => expect(fn).toThrow(code);

describe('host-task broker authorization and fixed capability', () => {
  it('keeps shared/native and standalone backend credential validation identical and strict', () => {
    const cases: Array<[unknown, boolean]> = [
      [undefined, false], [null, false], [0, false], [{}, false],
      ['a'.repeat(31), false], ['a'.repeat(32), true], ['a'.repeat(256), true],
      ['a'.repeat(257), false], ['_'.repeat(32), true], ['-'.repeat(32), true],
      [`${'a'.repeat(32)}\n`, false], [` ${'a'.repeat(32)}`, false],
      [`${'a'.repeat(32)}\u202E`, false], ['+'.repeat(32), false],
    ];
    for (const [value, expected] of cases) {
      expect(isHostTaskCredential(value)).toBe(expected);
      expect(backendCredential(value)).toBe(expected);
    }
  });
  it('starts disabled without an explicitly injected admin credential', () => {
    const store = openStore(':memory:'); stores.push(store);
    const broker = new HostTaskBroker(store.db);
    broker.features.write({ hostTasks: true });
    rejects(() => broker.dispatch('GET', '/admin', admin), 'admin_disabled');
  });
  it('rejects weak admin credentials instead of silently enabling bootstrap', () => {
    const store = openStore(':memory:'); stores.push(store);
    expect(() => new HostTaskBroker(store.db, { hostTaskAdminCredential: 'weak' })).toThrow('externally provisioned');
  });
  it('persists only random credential hashes and never includes tokens in snapshots', () => {
    const f = fixture();
    const appRow = f.store.db.prepare('SELECT * FROM host_task_apps').get() as any;
    expect(appRow.credential_hash).toBe(hostTaskHash(f.app.credential));
    expect(f.app.credential).toMatch(/^[0-9a-f]{64}$/);
    const snapshot = JSON.stringify(f.call('/admin', undefined, admin, 'GET'));
    expect(snapshot).not.toContain(f.app.credential);
    expect(snapshot).not.toContain(f.runner.credential);
    expect(snapshot).not.toContain('credential_hash');
    expect(f.store.listDocuments({})).toEqual([]);
  });
  it('separates admin, runner and application principals', () => {
    const f = fixture();
    rejects(() => f.call('/admin', undefined, f.app.credential, 'GET'), 'invalid_credential');
    rejects(() => f.request('x', {}, admin), 'invalid_credential');
    rejects(() => f.request('x', {}, f.runner.credential), 'invalid_credential');
    rejects(() => f.call('/runner/claim', {}, f.app.credential), 'invalid_credential');
    rejects(() => f.call('/admin', undefined, '', 'GET'), 'invalid_credential');
  });
  it('requires an app-specific unexpired approval', () => {
    const f = fixture();
    const other = f.call('/admin/apps', { label: 'Other', instanceId: 'other' });
    expect(f.request('other', {}, other.credential).state).toBe('awaiting-approval');
    f.advance(3600000);
    expect(f.request().state).toBe('awaiting-approval');
  });
  it('never treats a generic Config document with approved:true as broker authority', () => {
    const f = fixture(false);
    f.call(`/admin/grants/${f.grant.id}/revoke`, {});
    f.store.createDocument({
      kind: 'Config',
      slug: 'host-task-approval',
      labels: { capability: 'thrive.sync.read', approved: 'true' },
      spec: {
        approved: true, appId: f.app.appId, grantId: f.grant.id,
        capability: 'thrive.sync.read', windowsSid: sid, tenantId: tenant,
        expiresAt: f.now + 3600000, generation: 999,
      },
      status: { approved: true },
    });
    expect(f.request().state).toBe('awaiting-approval');
    const snapshot = f.call('/admin', undefined, admin, 'GET');
    expect(snapshot.grants).toHaveLength(1);
    expect(snapshot.grants[0].generation).toBe(2);
    expect(snapshot.grants[0].revokedAt).toBe(f.now);
    expect(snapshot.jobs[0].state).toBe('awaiting-approval');
    expect(snapshot.jobs[0].grantId).toBeNull();
  });
  it('keeps useful queued state and denies runner registration without host evidence', () => {
    const f = fixture(false);
    const job = f.request();
    expect(job.state).toBe('queued');
    expect(job.blockedReason).toBe(HOST_TASK_BLOCKED_REASON);
    expect(job.blockedReason).toContain('immutable implementation bytes/publisher');
    expect(job.blockedReason).toContain('current-user effective identity');
    expect(job.blockedReason).toContain('never executable code');
    expect(f.status(job.id).state).toBe('queued');
    rejects(() => f.call('/admin/runners', { windowsSid: sid, tenantId: tenant }), 'execution_blocked');
  });
  it.each([
    { capability: 'shell' }, { command: 'whoami' }, { organization: 'Other' },
    { project: 'Other' }, { identity: 'other@example.com' }, { areaPath: 'Customers' },
    { grantId: 'forged' }, { windowsSid: sid }, { tenantId: tenant },
    { operationHash: HOST_TASK_OPERATION_HASH }, { budgets: { records: 1000 } },
    { actions: ['write'] }, { query: 'SELECT *' },
  ])('rejects caller-controlled authority or operation fields %j', extra => {
    const f = fixture();
    expect(() => f.request('x', extra)).toThrow();
  });
  it('fixes scope, reviewed operation version, query, fields, actions and budgets', () => {
    const f = fixture();
    f.request();
    const lease = f.claim();
    expect(lease.operation).toEqual(HOST_TASK_OPERATION);
    expect(lease.operation.scope).toEqual({
      organization: 'CXPPMO', project: 'Customers',
      identity: 'mkubarycz@microsoft.com', areaPath: 'Customers\\Comcast',
    });
    expect(lease.operationHash).toBe(hostTaskHash(HOST_TASK_OPERATION));
    expect(lease.operation.actions).toEqual(['wit_query/wiql', 'wit_work_item/get', 'wit_work_item/get_type']);
    expect(lease.operation.query).toContain('[System.CreatedBy]');
    expect(lease.operation.budgets.queryCalls).toBe(4);
    expect(lease.operation.fields).not.toContain('System.Description');
  });
  it('rejects wrong tenant, SID, operation evidence and invalid registration metadata', () => {
    const f = fixture();
    rejects(() => f.call('/admin/runners', { windowsSid: sid, tenantId: randomUUID() }), 'execution_blocked');
    rejects(() => f.call('/admin/runners', { windowsSid: 'S-1-5-1', tenantId: tenant }), 'execution_blocked');
    expect(() => f.call('/admin/runners', { windowsSid: sid, tenantId: tenant, verified: true })).toThrow();
    (f.bridge as any).fixtureOnly = false;
    rejects(() => f.call('/admin/runners', { windowsSid: sid, tenantId: tenant }), 'execution_blocked');
  });
  it.each([0, -1, 86400001])('rejects invalid approval expiry offset %s', offset => {
    const f = fixture();
    rejects(() => f.call('/admin/grants', { ...approvalBinding, appId: f.app.appId, windowsSid: sid, tenantId: tenant, expiresAt: f.now + offset }), 'invalid_expiry');
  });
  it('rejects duplicate instance provisioning without exposing an old credential', () => {
    const f = fixture();
    f.call('/admin/apps', { label: 'New', instanceId: 'fixed-instance' });
    rejects(() => f.call('/admin/apps', { label: 'New', instanceId: 'fixed-instance' }), 'instance_already_provisioned');
  });
  it.each(['\u200B', '\u200E', '\u202E', '\u2066', '\u0085', '\u2028'])(
    'rejects invisible/bidi/control app identity metadata U+%s', control => {
      const f = fixture();
      expect(() => f.call('/admin/apps', { label: `Synthetic${control}desktop`, instanceId: 'synthetic-new' })).toThrow();
      expect(() => f.call('/admin/apps', { label: 'Synthetic desktop', instanceId: `synthetic${control}instance` })).toThrow();
      expect(f.call('/admin', undefined, admin, 'GET').apps).toHaveLength(1);
    });
  it('persists and publicly returns the exact immutable reviewed grant descriptor', () => {
    const f = fixture();
    expect(f.grant.operationHash).toBe(HOST_TASK_OPERATION_HASH);
    expect(f.grant.policyHash).toBe(HOST_TASK_OPERATION_HASH);
    expect(f.grant.operation).toEqual(HOST_TASK_OPERATION);
    const row = f.store.db.prepare('SELECT * FROM host_task_grants WHERE id=?').get(f.grant.id) as any;
    expect(row.operation_hash).toBe(HOST_TASK_OPERATION_HASH);
    expect(hostTaskHash(JSON.parse(row.operation_json))).toBe(HOST_TASK_OPERATION_HASH);
    expect(f.grant.operation.actions).not.toContain('wit_work_item/get_batch');
    expect(f.grant.operation.outputFields).not.toContain('description');
    expect(f.call('/admin', undefined, admin, 'GET').policy).toEqual({
      policyHash: HOST_TASK_OPERATION_HASH, operationHash: HOST_TASK_OPERATION_HASH,
      operationVersion: HOST_TASK_OPERATION.version, scope: HOST_TASK_OPERATION.scope,
      outputFields: HOST_TASK_OPERATION.outputFields, actions: HOST_TASK_OPERATION.actions,
      budgets: HOST_TASK_OPERATION.budgets, operation: HOST_TASK_OPERATION,
    });
    const policyJson = canonicalHostTaskPolicyJson(f.grant.operation as HostTaskOperation);
    expect(createHash('sha256').update(policyJson, 'utf8').digest('hex')).toBe(HOST_TASK_OPERATION_HASH);
    const snapshot = f.call('/admin', undefined, admin, 'GET');
    expect(snapshot.operation).toEqual(snapshot.policy.operation);
    expect(snapshot.operationHash).toBe(snapshot.policy.policyHash);
  });
  it('requires native confirmation to bind the current policy hash/version before approval', () => {
    const f = fixture();
    const input = {
      ...approvalBinding, appId: f.app.appId, windowsSid: sid, tenantId: tenant, expiresAt: f.now + 3600000,
    };
    expect(() => f.call('/admin/grants', { ...input, operationHash: undefined })).toThrow();
    expect(() => f.call('/admin/grants', { ...input, operationVersion: undefined })).toThrow();
    rejects(() => f.call('/admin/grants', { ...input, operationHash: '0'.repeat(64) }), 'policy_changed');
    rejects(() => f.call('/admin/grants', { ...input, operationVersion: HOST_TASK_OPERATION.version + 1 }), 'policy_changed');
    const grants = f.call('/admin', undefined, admin, 'GET').grants;
    expect(grants).toHaveLength(1);
    expect(grants[0].id).toBe(f.grant.id);
    expect(grants[0].revokedAt).toBeNull();
    expect(grants[0].generation).toBe(1);
  });
  it('accepts canonical policyHash approval and rejects contradictory compatibility hashes', () => {
    const f = fixture();
    const input = {
      appId: f.app.appId, windowsSid: sid, tenantId: tenant, expiresAt: f.now + 3600000,
      policyHash: HOST_TASK_OPERATION_HASH, operationVersion: HOST_TASK_OPERATION.version,
    };
    const grant = f.call('/admin/grants', input);
    expect(grant.policyHash).toBe(HOST_TASK_OPERATION_HASH);
    rejects(() => f.call('/admin/grants', { ...input, operationHash: '0'.repeat(64) }), 'policy_changed');
    rejects(() => f.call('/admin/grants', { ...input, policyHash: '0'.repeat(64), operationHash: HOST_TASK_OPERATION_HASH }), 'policy_changed');
    const current = f.call('/admin', undefined, admin, 'GET').grants.find((row: any) => row.id === grant.id);
    expect(current.revokedAt).toBeNull();
  });
  it('revokes app credentials durably, cancels leases, and scrubs already released results', () => {
    const f = fixture(true, true);
    const job = f.request(), lease = f.claim();
    f.call('/runner/results', f.result(lease), f.runner.credential);
    const revoked = f.call(`/admin/apps/${f.app.appId}/revoke`, {});
    expect(revoked.revokedAt).toBe(f.now);
    expect(revoked.id).toBe(f.app.appId);
    f.restart();
    rejects(() => f.request('another'), 'invalid_credential');
    rejects(() => f.status(job.id), 'invalid_credential');
    rejects(() => f.call(`/jobs/${job.id}/results`, undefined, f.app.credential, 'GET'), 'invalid_credential');
    const row = f.store.db.prepare('SELECT * FROM host_task_jobs WHERE id=?').get(job.id) as any;
    expect(row.state).toBe('cancelled');
    expect(row.result_json).toBeNull();
    expect(row.result_hash).toBeNull();
    rejects(() => f.call('/admin/grants', {
      ...approvalBinding,
      appId: f.app.appId, windowsSid: sid, tenantId: tenant, expiresAt: f.now + 3600000,
    }), 'app_not_found');
  });
  it('app revocation invalidates in-flight runner attempts without trusting old app auth', () => {
    const f = fixture();
    f.request(); const lease = f.claim();
    f.call(`/admin/apps/${f.app.appId}/revoke`, {});
    rejects(() => f.call('/runner/results', f.result(lease), f.runner.credential), 'stale_lease');
    expect(f.claim()).toEqual({ job: null });
  });
  it('revokes runner credentials durably and scrubs results from that runner', () => {
    const f = fixture(true, true);
    const job = f.request(), lease = f.claim();
    f.call('/runner/results', f.result(lease), f.runner.credential);
    const revoked = f.call(`/admin/runners/${f.runner.runnerId}/revoke`, {});
    expect(revoked.id).toBe(f.runner.runnerId);
    expect(revoked.revokedAt).toBe(f.now);
    f.restart();
    rejects(() => f.claim(), 'invalid_credential');
    rejects(() => f.call('/runner/results', f.result(lease), f.runner.credential), 'invalid_credential');
    expect(f.status(job.id).state).toBe('cancelled');
    expect((f.store.db.prepare('SELECT result_json FROM host_task_jobs WHERE id=?').get(job.id) as any).result_json).toBeNull();
  });
  it('runner revocation fences in-flight work while allowing a distinct freshly provisioned runner', () => {
    const f = fixture();
    const job = f.request(), lease = f.claim();
    f.call(`/admin/runners/${f.runner.runnerId}/revoke`, {});
    rejects(() => f.call('/runner/results', f.result(lease), f.runner.credential), 'invalid_credential');
    const replacement = f.call('/admin/runners', { windowsSid: sid, tenantId: tenant });
    expect(replacement.credential).not.toBe(f.runner.credential);
    expect(f.call('/runner/claim', {}, replacement.credential)).toEqual({ job: null });
    expect(f.status(job.id).state).toBe('cancelled');
    f.advance(300000);
    const future = f.request('future-after-runner-revoke');
    rejects(() => f.claim(), 'invalid_credential');
    const nextLease = f.call('/runner/claim', {}, replacement.credential);
    expect(nextLease.jobId).toBe(future.id);
    rejects(() => f.call('/runner/results', f.result(nextLease), f.runner.credential), 'invalid_credential');
    f.call('/runner/results', f.result(nextLease), replacement.credential);
    expect(f.status(future.id).state).toBe('succeeded');
  });
});

describe('durable idempotency, admission and lifecycle', () => {
  it('durably awaits explicit approval and only then queues the bound app request', () => {
    const f = fixture(false, true);
    f.call(`/admin/grants/${f.grant.id}/revoke`, {});
    const job = f.request();
    expect(job.state).toBe('awaiting-approval');
    expect(job.grantId).toBeNull();
    f.restart();
    expect(f.request().id).toBe(job.id);
    rejects(() => f.request('another-pending'), 'approval_pending');
    const grant = f.call('/admin/grants', {
      ...approvalBinding,
      appId: f.app.appId, windowsSid: sid, tenantId: tenant, expiresAt: f.now + 3600000,
    });
    const queued = f.status(job.id);
    expect(queued.state).toBe('queued');
    expect(queued.grantId).toBe(grant.id);
    expect(queued.blockedReason).toContain('verified Windows');
  });
  it('binds normalized incremental mode, checkpoint and cache IDs into the durable request hash', () => {
    const f = fixture(true, true);
    const extra = { mode: 'incremental', checkpoint: '2026-10-20T11:00:00.000Z', knownIds: [3, 1] };
    const job = f.request('incremental', extra);
    f.restart();
    expect(f.request('incremental', { ...extra, knownIds: [1, 3] }).id).toBe(job.id);
    rejects(() => f.request('incremental', { ...extra, knownIds: [1] }), 'idempotency_conflict');
    rejects(() => f.request('incremental', { ...extra, checkpoint: '2026-10-20T10:00:00.000Z' }), 'idempotency_conflict');
    const lease = f.claim();
    expect(lease.request).toMatchObject({ ...extra, knownIds: [1, 3] });
    expect(lease.requestHash).toBe(hostTaskHash({ ...lease.request, operationHash: HOST_TASK_OPERATION_HASH }));
    expect(lease.operation.query).not.toContain('3,1');
    expect(lease.operation.actions).toEqual(['wit_query/wiql', 'wit_work_item/get', 'wit_work_item/get_type']);
  });
  it.each([
    { mode: 'incremental' }, { mode: 'arbitrary' },
    { mode: 'full', checkpoint: '2026-10-20T11:00:00.000Z' },
    { mode: 'incremental', checkpoint: '2026-10-20T13:00:00.000Z' },
    { mode: 'incremental', checkpoint: '2026-10-20T11:00:00Z' },
    { knownIds: [1, 1] }, { knownIds: [-1] }, { knownIds: [1.2] },
    { knownIds: Array.from({ length: 201 }, (_, i) => i + 1) },
  ])('rejects unbounded or inconsistent snapshot hints %j', extra => {
    const f = fixture();
    expect(() => f.request('bad', extra)).toThrow();
  });
  it('expires or cancels awaiting approval without creating authority', () => {
    const f = fixture(false);
    f.call(`/admin/grants/${f.grant.id}/revoke`, {});
    const pending = f.request();
    f.advance(900000);
    expect(f.status(pending.id).state).toBe('expired');
    const next = f.request('next');
    f.call(`/jobs/${next.id}/cancel`, {}, f.app.credential);
    expect(f.status(next.id).state).toBe('cancelled');
  });
  it('binds idempotency to normalized payload and survives reopening the sole Store', () => {
    const f = fixture(true, true);
    const job = f.request();
    f.restart();
    expect(f.request().id).toBe(job.id);
    rejects(() => f.request('request-1', { manualRefresh: true }), 'idempotency_conflict');
    expect(f.claim().jobId).toBe(job.id);
  });
  it('isolates idempotency and status/result/ack/cancel between apps', () => {
    const f = fixture();
    const job = f.request();
    const other = f.call('/admin/apps', { label: 'Other', instanceId: 'other' });
    for (const suffix of ['', '/results', '/ack', '/cancel']) {
      rejects(() => f.call(`/jobs/${job.id}${suffix}`, suffix === '/ack' || suffix === '/cancel' ? {} : undefined,
        other.credential, suffix === '/ack' || suffix === '/cancel' ? 'POST' : 'GET'), 'job_not_found');
    }
    expect(f.request('request-1', {}, other.credential).state).toBe('awaiting-approval');
  });
  it('permits only one active job per app/scope while isolating other approved apps', () => {
    const f = fixture();
    f.request();
    rejects(() => f.request('second'), 'scope_busy');
    const other = f.call('/admin/apps', { label: 'Other', instanceId: 'other' });
    f.call('/admin/grants', { ...approvalBinding, appId: other.appId, windowsSid: sid, tenantId: tenant, expiresAt: f.now + 3600000 });
    expect(f.request('second', {}, other.credential).state).toBe('queued');
  });
  it('enforces five-minute cadence even after cancellation and a bounded manual refresh', () => {
    const f = fixture();
    const job = f.request();
    f.call(`/jobs/${job.id}/cancel`, {}, f.app.credential);
    rejects(() => f.request('normal-2'), 'refresh_rate_limited');
    f.advance(60000);
    const manual = f.request('manual-1', { manualRefresh: true });
    f.call(`/jobs/${manual.id}/cancel`, {}, f.app.credential);
    f.advance(60000);
    const manual2 = f.request('manual-2', { manualRefresh: true });
    f.call(`/jobs/${manual2.id}/cancel`, {}, f.app.credential);
    f.advance(60000);
    rejects(() => f.request('manual-3', { manualRefresh: true }), 'manual_refresh_limit');
    f.advance(240000);
    expect(f.request('normal-2').state).toBe('queued');
  });
  it('expires queued work at the fixed lifetime', () => {
    const f = fixture(false);
    const job = f.request();
    f.advance(900000);
    expect(f.status(job.id).state).toBe('expired');
  });
  it('revocation cancels queued work, increments generation and removes approval', () => {
    const f = fixture();
    const job = f.request();
    const grant = f.call(`/admin/grants/${f.grant.id}/revoke`, {});
    expect(grant.generation).toBe(2);
    expect(f.status(job.id).state).toBe('cancelled');
    expect(f.claim()).toEqual({ job: null });
    f.advance(300000);
    expect(f.request('new').state).toBe('awaiting-approval');
  });
  it('reapproval invalidates old grant/job instead of silently moving their authority', () => {
    const f = fixture();
    const job = f.request();
    const replacement = f.call('/admin/grants', { ...approvalBinding, appId: f.app.appId, windowsSid: sid, tenantId: tenant, expiresAt: f.now + 1800000 });
    expect(replacement.id).not.toBe(f.grant.id);
    expect(f.status(job.id).state).toBe('cancelled');
  });
  it('admin denial invalidates an active lease and does not forge success', () => {
    const f = fixture();
    const job = f.request(), lease = f.claim();
    f.call(`/admin/jobs/${job.id}/deny`, {});
    expect(f.status(job.id).state).toBe('denied');
    rejects(() => f.call('/runner/results', f.result(lease), f.runner.credential), 'stale_lease');
  });
  it.each([
    ["operation_hash", 'forged'],
    ["payload_hash", 'forged'],
    ["grant_generation", 99],
    ["manual_refresh", 1],
  ])('fences tampered job field %s before dispatch', (field, value) => {
    const f = fixture();
    const job = f.request();
    f.store.db.prepare(`UPDATE host_task_jobs SET ${field}=? WHERE id=?`).run(value, job.id);
    expect(f.claim()).toEqual({ job: null });
    expect(f.status(job.id).state).toBe('expired');
  });
  it.each([
    ["windows_sid", 'S-1-5-99'], ["tenant_id", '12345678-1234-4234-8234-000000000000'],
    ["expires_at", 9999999999999], ["app_id", 'forged-app'],
  ])('binds original reviewed grant metadata, rejecting tampered %s', (field, value) => {
    const f = fixture();
    const job = f.request();
    const replacement = field === 'app_id'
      ? f.call('/admin/apps', { label: 'Other', instanceId: 'other' }).appId : value;
    f.store.db.prepare(`UPDATE host_task_grants SET ${field}=? WHERE id=?`).run(replacement, f.grant.id);
    expect(f.claim()).toEqual({ job: null });
    expect(f.status(job.id).state).toBe('expired');
  });
  it.each(['operation_hash', 'operation_json'])('fences tampered reviewed grant descriptor %s', field => {
    const f = fixture();
    const job = f.request();
    const changed = { ...HOST_TASK_OPERATION, actions: ['wit_work_item/get_batch'] };
    f.store.db.prepare(`UPDATE host_task_grants SET ${field}=? WHERE id=?`).run(
      field === 'operation_hash' ? hostTaskHash(changed) : JSON.stringify(changed), f.grant.id);
    expect(f.claim()).toEqual({ job: null });
    expect(f.status(job.id).state).toBe('expired');
  });
});

describe('lease fencing and result acceptance races', () => {
  it('physically clears expired live result values through trusted maintenance without an app request', () => {
    const f = fixture();
    const job = f.request(), lease = f.claim();
    f.call('/runner/results', f.result(lease), f.runner.credential);
    f.advance(1800000);
    expect((f.store.db.prepare('SELECT result_json FROM host_task_jobs WHERE id=?').get(job.id) as any).result_json).not.toBeNull();
    f.broker.cleanup();
    const row = f.store.db.prepare('SELECT * FROM host_task_jobs WHERE id=?').get(job.id) as any;
    expect(row.state).toBe('expired');
    expect(row.result_json).toBeNull();
    expect(row.result_hash).toBeNull();
    expect(row.result_until).toBeNull();
  });
  it('performs expiry cleanup on durable broker startup before serving any request', () => {
    const f = fixture(true, true);
    const job = f.request(), lease = f.claim();
    f.call('/runner/results', f.result(lease), f.runner.credential);
    f.advance(1800000);
    f.restart();
    const row = f.store.db.prepare('SELECT * FROM host_task_jobs WHERE id=?').get(job.id) as any;
    expect(row.state).toBe('expired');
    expect(row.result_json).toBeNull();
    expect(row.result_hash).toBeNull();
  });
  it('uses the documented shared canonical chunk encoding independent of input key order', () => {
    const original = record();
    const reordered = Object.fromEntries(Object.entries(original).reverse()) as unknown as HostTaskRecord;
    expect(canonicalHostTaskChunkJson([original])).toBe(canonicalHostTaskChunkJson([reordered]));
    const producerHash = createHash('sha256').update(canonicalHostTaskChunkJson([reordered]), 'utf8').digest('hex');
    expect(producerHash).toBe(hostTaskHash([original]));
    const f = fixture();
    f.request(); const lease = f.claim();
    const input = f.result(lease, [reordered as any]);
    input.chunks[0].sha256 = producerHash;
    f.call('/runner/results', input, f.runner.credential);
    expect(f.status(lease.jobId).state).toBe('succeeded');
  });
  it('commits expired-lease recovery even when the submitted stale result is rejected', () => {
    const f = fixture();
    const job = f.request(), lease = f.claim();
    f.advance(60000);
    rejects(() => f.call('/runner/results', f.result(lease), f.runner.credential), 'stale_lease');
    const row = f.store.db.prepare('SELECT * FROM host_task_jobs WHERE id=?').get(job.id) as any;
    expect(row.state).toBe('queued');
    expect(row.lease_hash).toBeNull();
    expect(row.lease_until).toBeNull();
    expect(row.result_json).toBeNull();
  });
  it.each(['expiry', 'grant-tamper', 'request-tamper'])('persists %s invalidation despite rejected result transaction', scenario => {
    const f = fixture();
    const job = f.request(), lease = f.claim();
    if (scenario === 'expiry') f.advance(3600000);
    if (scenario === 'grant-tamper') f.store.db.prepare('UPDATE host_task_grants SET generation=generation+1 WHERE id=?').run(f.grant.id);
    if (scenario === 'request-tamper') f.store.db.prepare('UPDATE host_task_jobs SET payload_hash=? WHERE id=?').run('tampered', job.id);
    rejects(() => f.call('/runner/results', f.result(lease), f.runner.credential), 'stale_lease');
    const row = f.store.db.prepare('SELECT * FROM host_task_jobs WHERE id=?').get(job.id) as any;
    expect(row.state).toBe('expired');
    expect(row.lease_hash).toBeNull();
    expect(row.result_json).toBeNull();
  });
  it.each([
    ['needs-sign-in', 'needs-sign-in'],
    ['upstream-unavailable', 'failed'],
    ['incomplete-result', 'failed'],
    ['budget-exceeded', 'failed'],
  ])('records only allowlisted actionable runner failure %s as %s', (code, state) => {
    const f = fixture();
    const job = f.request(), lease = f.claim();
    const input = {
      jobId: job.id, attempt: lease.attempt, leaseToken: lease.leaseToken,
      requestHash: lease.requestHash, code,
    };
    expect(f.call('/runner/failure', input, f.runner.credential)).toEqual({ accepted: true });
    expect(f.status(job.id).state).toBe(state);
    expect(f.status(job.id).blockedReason).toBe(code);
    rejects(() => f.call('/runner/results', f.result(lease), f.runner.credential), 'stale_lease');
  });
  it('rejects raw upstream failure details and failure/result cross-request binding', () => {
    const f = fixture();
    f.request(); const lease = f.claim();
    const failure = {
      jobId: lease.jobId, attempt: lease.attempt, leaseToken: lease.leaseToken,
      requestHash: lease.requestHash, code: 'needs-sign-in',
    };
    expect(() => f.call('/runner/failure', { ...failure, message: 'raw sensitive upstream exception' }, f.runner.credential)).toThrow();
    rejects(() => f.call('/runner/failure', { ...failure, requestHash: '0'.repeat(64) }, f.runner.credential), 'request_binding_mismatch');
    rejects(() => f.call('/runner/results', { ...f.result(lease), requestHash: '0'.repeat(64) }, f.runner.credential), 'request_binding_mismatch');
    expect(f.status(lease.jobId).state).toBe('running');
  });
  it('recovers expired leases after restart, fences stale attempts and caps retries', () => {
    const f = fixture(true, true);
    const job = f.request(), first = f.claim();
    f.advance(60000); f.restart();
    const second = f.claim();
    expect(second.attempt).toBe(2);
    expect(second.leaseToken).not.toBe(first.leaseToken);
    rejects(() => f.call('/runner/results', f.result(first), f.runner.credential), 'stale_lease');
    f.advance(60000);
    const third = f.claim();
    expect(third.attempt).toBe(3);
    f.advance(60000);
    expect(f.claim()).toEqual({ job: null });
    expect(f.status(job.id).state).toBe('expired');
  });
  it('heartbeats never extend the fixed execution time budget', () => {
    const f = fixture();
    f.request(); const lease = f.claim(); f.advance(30000);
    const payload = { jobId: lease.jobId, attempt: lease.attempt, leaseToken: lease.leaseToken };
    expect(f.call('/runner/heartbeat', payload, f.runner.credential).leaseUntil).toBe(lease.leaseUntil);
    f.advance(30000);
    rejects(() => f.call('/runner/heartbeat', payload, f.runner.credential), 'stale_lease');
  });
  it('rejects another independently authenticated runner lease replay', () => {
    const f = fixture();
    f.request(); const lease = f.claim();
    const runner2 = f.call('/admin/runners', { windowsSid: sid, tenantId: tenant });
    rejects(() => f.call('/runner/results', f.result(lease), runner2.credential), 'stale_lease');
  });
  it.each(['revoked', 'expired', 'cancelled', 'identity-lost', 'operation-changed'])('rechecks authority on result acceptance after %s', scenario => {
    const f = fixture();
    const job = f.request(), lease = f.claim();
    if (scenario === 'revoked') f.call(`/admin/grants/${f.grant.id}/revoke`, {});
    if (scenario === 'expired') f.advance(3600000);
    if (scenario === 'cancelled') f.call(`/jobs/${job.id}/cancel`, {}, f.app.credential);
    if (scenario === 'identity-lost') f.verify(false);
    if (scenario === 'operation-changed') (f.bridge as any).fixtureOnly = false;
    expect(() => f.call('/runner/results', f.result(lease), f.runner.credential)).toThrow();
    expect(() => f.call(`/jobs/${job.id}/results`, undefined, f.app.credential, 'GET')).toThrow();
  });
  it('rechecks grant validity when trusted identity evidence changes during dispatch', () => {
    const f = fixture();
    const job = f.request();
    f.bridge.verifyIdentity = () => {
      f.store.db.prepare('UPDATE host_task_grants SET revoked_at=? WHERE id=?').run(f.now, f.grant.id);
      return true;
    };
    expect(f.claim()).toEqual({ job: null });
    expect(f.status(job.id).state).toBe('expired');
  });
  it('rechecks grant validity when evidence changes during result acceptance', () => {
    const f = fixture();
    f.request(); const lease = f.claim();
    f.bridge.verifyIdentity = () => {
      f.store.db.prepare('UPDATE host_task_grants SET generation=generation+1 WHERE id=?').run(f.grant.id);
      return true;
    };
    rejects(() => f.call('/runner/results', f.result(lease), f.runner.credential), 'stale_lease');
  });
  it('rechecks grant generation during the final result-release evidence check', () => {
    const f = fixture();
    const job = f.request(), lease = f.claim();
    f.call('/runner/results', f.result(lease), f.runner.credential);
    f.bridge.verifyIdentity = () => {
      f.store.db.prepare('UPDATE host_task_grants SET generation=generation+1 WHERE id=?').run(f.grant.id);
      return true;
    };
    rejects(() => f.call(`/jobs/${job.id}/results`, undefined, f.app.credential, 'GET'), 'result_not_available');
  });
  it('atomically accepts normalized bounded results, releases own data, then scrubs on acknowledgment', () => {
    const f = fixture();
    const job = f.request(), lease = f.claim();
    expect(f.call('/runner/results', f.result(lease), f.runner.credential)).toEqual({ accepted: true });
    expect(f.status(job.id).state).toBe('succeeded');
    const result = f.call(`/jobs/${job.id}/results`, undefined, f.app.credential, 'GET');
    expect(result.chunks[0].records).toEqual([record()]);
    expect(result.appId).toBe(f.app.appId);
    expect(result.grantId).toBe(f.grant.id);
    expect(result.grantGeneration).toBe(f.grant.generation);
    expect(result.attempt).toBe(lease.attempt);
    expect(result.schemaVersion).toBe(1);
    expect(JSON.stringify(result)).not.toContain('leaseToken');
    f.call(`/jobs/${job.id}/ack`, {}, f.app.credential);
    expect(f.status(job.id).state).toBe('acknowledged');
    expect((f.store.db.prepare('SELECT result_json FROM host_task_jobs').get() as any).result_json).toBeNull();
    rejects(() => f.call(`/jobs/${job.id}/results`, undefined, f.app.credential, 'GET'), 'result_not_available');
  });
  it('permits an explicitly complete empty result but never fabricates one for queued work', () => {
    const f = fixture();
    const job = f.request();
    rejects(() => f.call(`/jobs/${job.id}/results`, undefined, f.app.credential, 'GET'), 'result_not_available');
    const lease = f.claim();
    f.evidence({ membershipIds: [], detailIds: [], recordHashes: {} });
    f.call('/runner/results', f.result(lease, []), f.runner.credential);
    expect(f.call(`/jobs/${job.id}/results`, undefined, f.app.credential, 'GET').recordCount).toBe(0);
  });
  it.each(['hash', 'gap', 'missing', 'duplicate', 'wrong-job', 'wrong-operation', 'wrong-policy', 'wrong-attempt', 'wrong-lease', 'unknown-field'])('rejects incomplete or unbound manifest: %s', scenario => {
    const f = fixture();
    const job = f.request(), lease = f.claim(), result = f.result(lease) as any;
    if (scenario === 'hash') result.chunks[0].sha256 = '0'.repeat(64);
    if (scenario === 'gap') result.chunks[0].index = 1;
    if (scenario === 'missing') result.recordCount = 2;
    if (scenario === 'duplicate') {
      result.chunks[0].records.push(record()); result.recordCount = 2;
      result.chunks[0].sha256 = hostTaskHash(result.chunks[0].records);
    }
    if (scenario === 'wrong-job') result.jobId = randomUUID();
    if (scenario === 'wrong-operation') result.operationHash = '0'.repeat(64);
    if (scenario === 'wrong-policy') result.policyHash = '0'.repeat(64);
    if (scenario === 'wrong-attempt') result.attempt++;
    if (scenario === 'wrong-lease') result.leaseToken = '0'.repeat(64);
    if (scenario === 'unknown-field') result.rawError = 'sensitive upstream data';
    expect(() => f.call('/runner/results', result, f.runner.credential)).toThrow();
    expect(f.status(job.id).state).toBe('running');
    expect((f.store.db.prepare('SELECT result_json FROM host_task_jobs').get() as any).result_json).toBeNull();
  });
  it.each(['appId', 'grantId', 'grantGeneration'])('rejects forged principal result binding %s', field => {
    const f = fixture();
    f.request(); const lease = f.claim(), result = f.result(lease) as any;
    result[field] = field === 'grantGeneration' ? 999 : randomUUID();
    rejects(() => f.call('/runner/results', result, f.runner.credential), 'principal_binding_mismatch');
    expect(f.status(lease.jobId).state).toBe('running');
  });
  it.each(['body', 'description', 'rawError', 'title', 'url', 'scope', 'date'])('rejects sensitive/unbounded or out-of-scope normalized record: %s', field => {
    const f = fixture();
    f.request(); const lease = f.claim(), r = record() as any;
    if (['body', 'description', 'rawError'].includes(field)) r[field] = 'secret';
    if (field === 'title') r.title = 'x'.repeat(201);
    if (field === 'url') r.url = 'https://attacker.example/redirect';
    if (field === 'scope') { r.assignedTo = 'other@example.com'; r.areaPath = 'Customers\\ComcastEvil'; }
    if (field === 'date') r.changedAt = 'yesterday';
    expect(() => f.call('/runner/results', f.result(lease, [r]), f.runner.credential)).toThrow();
  });
  it('allows the fixed area subtree OR fixed identity, not just an exact area match', () => {
    const f = fixture();
    f.request(); const lease = f.claim();
    const r = { ...record(), assignedTo: null, areaPath: 'Customers\\Comcast\\Subarea' };
    f.evidence({ recordHashes: { '1': hostTaskHash(r) } });
    f.call('/runner/results', f.result(lease, [r as any]), f.runner.credential);
    expect(f.status(lease.jobId).state).toBe('succeeded');
  });
  it('does not reuse identity-label restrictions to rewrite normalized Unicode fixture titles', () => {
    const f = fixture();
    f.request(); const lease = f.claim();
    const r = { ...record(), title: 'Synthetic fixture 日本語\u200B title' };
    f.evidence({ recordHashes: { '1': hostTaskHash(r) } });
    f.call('/runner/results', f.result(lease, [r]), f.runner.credential);
    const released = f.call(`/jobs/${lease.jobId}/results`, undefined, f.app.credential, 'GET');
    expect(released.chunks[0].records[0].title).toBe(r.title);
  });
  it('accepts a host-verified creator-only match independently of assigned identity and area', () => {
    const f = fixture();
    f.request(); const lease = f.claim();
    const r = { ...record(), assignedTo: 'other@example.com', createdBy: 'mkubarycz@microsoft.com' };
    f.evidence({ recordHashes: { '1': hostTaskHash(r) } });
    f.call('/runner/results', f.result(lease, [r]), f.runner.credential);
    expect(f.status(lease.jobId).state).toBe('succeeded');
  });
  it('does not treat forged scope fields or container cache IDs as host-verified membership', () => {
    const f = fixture();
    f.request('known-ids', { knownIds: [2] }); const lease = f.claim();
    const forged = record(2);
    const result = f.result(lease, [forged]);
    result.membershipIds = [2];
    result.removedIds = [];
    rejects(() => f.call('/runner/results', result, f.runner.credential), 'snapshot_evidence_mismatch');
    expect(f.status(lease.jobId).state).toBe('running');
  });
  it.each(['record-fields', 'classification', 'coverage', 'asOf', 'removals', 'schema', 'incomplete'])(
    'rejects forged or incomplete host snapshot manifest %s', scenario => {
      const f = fixture();
      f.request(); const lease = f.claim(), result = f.result(lease) as any;
      if (scenario === 'record-fields') result.chunks[0].records[0].title = 'Forged but in scope';
      if (scenario === 'classification') result.chunks[0].records[0].classification = 'CLOSED';
      if (scenario === 'coverage') f.evidence({ membershipIds: [1, 2], detailIds: [1, 2] });
      if (scenario === 'asOf') result.asOf = '2026-10-20T11:00:00.000Z';
      if (scenario === 'removals') result.removedIds = [2];
      if (scenario === 'schema') result.schemaVersion = 999;
      if (scenario === 'incomplete') result.dataComplete = false;
      if (['record-fields', 'classification'].includes(scenario)) {
        result.chunks[0].sha256 = hostTaskHash(result.chunks[0].records);
      }
      expect(() => f.call('/runner/results', result, f.runner.credential)).toThrow();
      expect(f.status(lease.jobId).state).toBe('running');
    });
  it('marks unfamiliar type-state metadata unclassified without inventing a fallback category', () => {
    const f = fixture();
    f.request(); const lease = f.claim();
    const r = { ...record(), classification: 'UNCLASSIFIED' as const };
    f.evidence({ recordHashes: { '1': hostTaskHash(r) }, stateMetadata: [] });
    const result = f.result(lease, [r as any]);
    expect(result.classificationComplete).toBe(false);
    f.call('/runner/results', result, f.runner.credential);
    const released = f.call(`/jobs/${lease.jobId}/results`, undefined, f.app.credential, 'GET');
    expect(released.chunks[0].records[0].classification).toBe('UNCLASSIFIED');
    expect(released.classificationComplete).toBe(false);
  });
  it('accepts bounded incremental historical details only from independent fixture membership and coverage', () => {
    const f = fixture();
    f.request('incremental', { mode: 'incremental', checkpoint: '2026-10-20T11:00:00.000Z', knownIds: [1, 3] });
    const lease = f.claim(), r = record(2);
    f.evidence({ membershipIds: [1, 2], detailIds: [2], recordHashes: { '2': hostTaskHash(r) } });
    const result = f.result(lease, [r]);
    expect(result.removedIds).toEqual([3]);
    f.call('/runner/results', result, f.runner.credential);
    expect(f.status(lease.jobId).state).toBe('succeeded');
  });
  it('returns independently verified metadata so unchanged cached members can be reclassified', () => {
    const f = fixture();
    f.request('metadata-delta', { mode: 'incremental', checkpoint: '2026-10-20T11:00:00.000Z', knownIds: [1, 2] });
    const lease = f.claim(), r = record(2);
    f.evidence({
      membershipIds: [1, 2], detailIds: [2], recordHashes: { '2': hostTaskHash(r) },
      memberStates: [{ id: 1, type: 'Bug', state: 'Finished' }, { id: 2, type: 'Task', state: 'Active' }],
      stateMetadata: [
        { type: 'Task', state: 'Active', category: 'InProgress' },
        { type: 'Bug', state: 'Finished', category: 'Completed' },
      ],
    });
    const result = f.result(lease, [r]);
    f.call('/runner/results', result, f.runner.credential);
    const released = f.call(`/jobs/${lease.jobId}/results`, undefined, f.app.credential, 'GET');
    expect(released.recordCount).toBe(1);
    expect(released.membershipIds).toHaveLength(2);
    expect(released.stateMetadata).toContainEqual({ type: 'Bug', state: 'Finished', category: 'Completed' });
    expect(released.stateMetadataHash).toBe(createHash('sha256')
      .update(canonicalHostTaskStateMetadataJson(released.stateMetadata), 'utf8').digest('hex'));
    expect(released.stateMetadataVersion).toBe(1);
    expect(released.classificationComplete).toBe(false);
  });
  it('never claims empty incremental detail deltas classify retained membership completely', () => {
    const f = fixture();
    f.request('empty-delta', { mode: 'incremental', checkpoint: '2026-10-20T11:00:00.000Z', knownIds: [1] });
    const lease = f.claim();
    f.evidence({ membershipIds: [1], detailIds: [], recordHashes: {} });
    const result = f.result(lease, []);
    expect(result.classificationComplete).toBe(false);
    rejects(() => f.call('/runner/results', { ...result, classificationComplete: true }, f.runner.credential), 'snapshot_classification_mismatch');
    f.call('/runner/results', result, f.runner.credential);
    const released = f.call(`/jobs/${lease.jobId}/results`, undefined, f.app.credential, 'GET');
    expect(released.recordCount).toBe(0);
    expect(released.membershipIds).toEqual([1]);
    expect(released.classificationComplete).toBe(false);
    expect(released.stateMetadata).toContainEqual({ type: 'Task', state: 'Active', category: 'InProgress' });
  });
  it('computes partial classification over unchanged membership, not just changed detail records', () => {
    const f = fixture();
    f.request('unknown-unchanged', { mode: 'incremental', checkpoint: '2026-10-20T11:00:00.000Z', knownIds: [1, 2] });
    const lease = f.claim(), r = record(2);
    f.evidence({
      membershipIds: [1, 2], detailIds: [2], recordHashes: { '2': hostTaskHash(r) },
      memberStates: [{ id: 1, type: 'Bug', state: 'Novel' }, { id: 2, type: 'Task', state: 'Active' }],
    });
    const result = f.result(lease, [r]);
    expect(result.classificationComplete).toBe(false);
    expect(result.chunks[0].records[0].classification).toBe('OPEN');
    rejects(() => f.call('/runner/results', { ...result, classificationComplete: true }, f.runner.credential), 'snapshot_classification_mismatch');
    f.call('/runner/results', result, f.runner.credential);
    expect(f.call(`/jobs/${lease.jobId}/results`, undefined, f.app.credential, 'GET').classificationComplete).toBe(false);
  });
  it.each(['hash', 'rows', 'version'])('rejects forged normalized state metadata %s', scenario => {
    const f = fixture();
    f.request(); const lease = f.claim(), result = f.result(lease) as any;
    if (scenario === 'hash') result.stateMetadataHash = '0'.repeat(64);
    if (scenario === 'version') result.stateMetadataVersion = 99;
    if (scenario === 'rows') {
      result.stateMetadata[0] = { type: 'Task', state: 'Active', category: 'Completed' };
      result.stateMetadataHash = createHash('sha256')
        .update(canonicalHostTaskStateMetadataJson(result.stateMetadata), 'utf8').digest('hex');
    }
    expect(() => f.call('/runner/results', result, f.runner.credential)).toThrow();
    expect(f.status(lease.jobId).state).toBe('running');
  });
  it('rejects missing historical details even when runner claims complete and supplied cache IDs look scoped', () => {
    const f = fixture();
    f.request('incremental', { mode: 'incremental', checkpoint: '2026-10-20T11:00:00.000Z', knownIds: [1] });
    const lease = f.claim();
    f.evidence({ membershipIds: [1, 2], detailIds: [1], recordHashes: { '1': hostTaskHash(record()) } });
    rejects(() => f.call('/runner/results', f.result(lease), f.runner.credential), 'snapshot_evidence_mismatch');
  });
  it('rechecks revocation after independent snapshot evidence is obtained', () => {
    const f = fixture();
    f.request(); const lease = f.claim();
    const original = f.bridge.snapshotEvidence;
    f.bridge.snapshotEvidence = input => {
      f.store.db.prepare('UPDATE host_task_grants SET revoked_at=? WHERE id=?').run(f.now, f.grant.id);
      return original(input);
    };
    rejects(() => f.call('/runner/results', f.result(lease), f.runner.credential), 'stale_lease');
  });
  it('rejects oversized chunks and excess chunks', () => {
    const f = fixture();
    f.request(); const lease = f.claim();
    expect(() => f.call('/runner/results', f.result(lease, Array.from({ length: 51 }, (_, i) => record(i + 1))), f.runner.credential)).toThrow();
    const result = f.result(lease);
    result.chunks = Array.from({ length: 5 }, (_, index) => ({ ...result.chunks[0], index }));
    expect(() => f.call('/runner/results', result, f.runner.credential)).toThrow();
  });
  it.each(['revoke', 'expiry', 'retention', 'identity', 'tamper'])('rechecks authority/integrity at release after %s', scenario => {
    const f = fixture();
    const job = f.request(), lease = f.claim();
    f.call('/runner/results', f.result(lease), f.runner.credential);
    if (scenario === 'revoke') f.call(`/admin/grants/${f.grant.id}/revoke`, {});
    if (scenario === 'expiry') f.advance(3600000);
    if (scenario === 'retention') f.advance(1800000);
    if (scenario === 'identity') f.verify(false);
    if (scenario === 'tamper') {
      const r = f.result(lease); r.chunks[0].records[0].title = 'Changed';
      f.store.db.prepare('UPDATE host_task_jobs SET result_json=? WHERE id=?')
        .run(JSON.stringify({ jobId: r.jobId, operationHash: r.operationHash, requestHash: r.requestHash, recordCount: r.recordCount, chunks: r.chunks }), job.id);
    }
    expect(() => f.call(`/jobs/${job.id}/results`, undefined, f.app.credential, 'GET')).toThrow();
    if (scenario === 'retention' || scenario === 'expiry' || scenario === 'revoke') {
      expect((f.store.db.prepare('SELECT result_json FROM host_task_jobs WHERE id=?').get(job.id) as any).result_json).toBeNull();
    }
  });
  it('keeps audit metadata redacted and never stores credentials, payloads or upstream text', () => {
    const f = fixture();
    const job = f.request(), lease = f.claim();
    f.call('/runner/results', f.result(lease), f.runner.credential);
    f.call(`/jobs/${job.id}/ack`, {}, f.app.credential);
    const audit = JSON.stringify(f.store.db.prepare('SELECT * FROM host_task_audit').all());
    expect(audit).toContain('result_committed');
    for (const secret of [admin, f.app.credential, f.runner.credential, lease.leaseToken, record().title, 'mkubarycz']) {
      expect(audit).not.toContain(secret);
    }
  });
});
