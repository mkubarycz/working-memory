import { randomBytes, randomUUID } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openStore, type Store } from '../src/store';
import { HostTaskBroker } from '../src/hostTasks';
import {
  scriptDefinitionSchema, scriptDefinitionHash, scriptJobSchema, scriptLeaseSchema,
  scriptTaskSchema, scriptParametersSchema, validateScriptArguments,
} from '../src/hostScriptPolicy';
import { z } from 'zod';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import { ensureHostScriptSchema } from '../src/hostScripts';
import { scriptDetailsSchema, scriptVersionSchema, exampleScriptArguments } from '../src/hostScriptPolicy';

it('upgrades legacy script tables once without changing approved bytes', () => {
  const db = new DatabaseSync(':memory:');
  try {
    db.exec(readFileSync(new URL('../../schema/022_host_scripts.sql', import.meta.url), 'utf8'));
    const definition = scriptDefinitionSchema.parse({ name: 'Legacy', description: '', hostId: randomUUID(),
      source: 'module.exports = () => true;', parameters: {}, timeoutMs: 1000 });
    const id = randomUUID(), hash = scriptDefinitionHash(definition);
    db.prepare('INSERT INTO host_script_tasks VALUES(?,?,?,?,NULL)').run(id, JSON.stringify(definition), hash, 100);
    ensureHostScriptSchema(db);
    ensureHostScriptSchema(db);
    expect(db.prepare('SELECT published_version,definition_hash FROM host_script_tasks').get())
      .toMatchObject({ published_version: 1, definition_hash: hash });
    expect(db.prepare('SELECT version,definition_json FROM host_script_versions').all())
      .toEqual([{ version: 1, definition_json: JSON.stringify(definition) }]);
  } finally { db.close(); }
});

it('generates valid example JSON for enums, bounded integers, booleans and short strings', () => {
  const schema = scriptParametersSchema.parse({
    name: { type: 'string', required: true, maxLength: 80 },
    mode: { type: 'string', enum: ['Ada'], maxLength: 3 },
    count: { type: 'integer', minimum: 4, maximum: 10 },
    negative: { type: 'integer', minimum: -10, maximum: -2 },
    flag: { type: 'boolean' }, short: { type: 'string', maxLength: 1 },
  });
  expect(exampleScriptArguments(schema)).toEqual({ name: 'World', mode: 'Ada', count: 4, negative: -2, flag: false, short: 'W' });
  expect(exampleScriptArguments({})).toEqual({});
  expect(() => exampleScriptArguments(scriptParametersSchema.parse({
    invalid: { type: 'string', enum: ['too long'], maxLength: 1 },
  }))).toThrow('No valid example');
});

describe('protected generic host scripts', () => {
  let store: Store;
  let broker: HostTaskBroker;
  let now: number;
  const admin = randomBytes(32).toString('hex');
  const hostId = randomUUID();
  const definition = scriptDefinitionSchema.parse({
    name: 'Greeting', description: 'No host side effects', hostId,
    source: 'module.exports = async p => ({ greeting: p.name });',
    parameters: { name: { type: 'string', required: true, maxLength: 20, enum: ['Michael', 'Ada'] } },
    timeoutMs: 1000,
  });
  beforeEach(() => {
    store = openStore(':memory:');
    now = Date.now();
    broker = new HostTaskBroker(store.db, { hostTaskAdminCredential: admin, hostTaskClock: () => now });
    broker.features.write({ hostTasks: true });
  });
  afterEach(() => store.close());
  const call = (method: string, path: string, token = admin, body?: unknown) =>
    broker.dispatch(method, path, token, body).body;
  const register = () => scriptTaskSchema.parse(call('POST', '/admin/scripts', admin, definition));
  function app() {
    return z.object({ appId: z.string(), credential: z.string() }).parse(call('POST', '/admin/apps', admin, {
      label: 'Test caller', instanceId: randomUUID(),
    }));
  }
  function approved() {
    const task = register(), caller = app();
    const grant = z.object({ id: z.string() }).parse(call('POST', '/admin/scripts/grants', admin, {
      appId: caller.appId, taskId: task.id, definitionHash: task.definitionHash, expiresAt: now + 60000,
    }));
    const input = { taskId: task.id, definitionHash: task.definitionHash, parameters: { name: 'Michael' }, idempotencyKey: 'test-1' };
    return { task, caller, grant, input };
  }
  it('saves immutable numbered drafts without changing the published code, grants or queued jobs', () => {
    const { task, caller, input } = approved();
    const job = scriptJobSchema.parse(call('POST', '/scripts/requests', caller.credential, input));
    const changed = { ...definition, name: 'Draft greeting', source: 'module.exports = p => ({ draft: p.name });' };
    const second = scriptVersionSchema.parse(call('POST', `/admin/scripts/${task.id}`, admin, changed));
    expect(second.version).toBe(2);
    expect(call('POST', `/admin/scripts/${task.id}`, admin, changed)).toEqual(second);
    const third = scriptVersionSchema.parse(call('POST', `/admin/scripts/${task.id}`, admin, { ...changed, description: 'Third' }));
    expect(third.version).toBe(3);
    const details = scriptDetailsSchema.parse(call('GET', `/admin/scripts/${task.id}`));
    expect(details.task).toMatchObject({ publishedVersion: 1, latestVersion: 3, definitionHash: task.definitionHash });
    expect(details.versions.map(version => version.version)).toEqual([3, 2, 1]);
    expect(details.versions[2].definition).toEqual(definition);
    expect(details.versions[1].definition).toEqual(changed);
    expect(call('GET', `/scripts/jobs/${job.id}`, caller.credential)).toMatchObject({ state: 'queued' });
    const { draftName, draftDescription, ...publishedTask } = details.task;
    expect({ draftName, draftDescription }).toEqual({ draftName: 'Draft greeting', draftDescription: 'Third' });
    expect(call('GET', '/admin/scripts')).toMatchObject({ tasks: [{ draftName, draftDescription }] });
    expect(call('GET', '/scripts', caller.credential)).toEqual([publishedTask]);
    expect(() => call('GET', `/admin/scripts/${task.id}`, caller.credential)).toThrow('invalid_credential');
    expect(() => call('POST', `/admin/scripts/${task.id}`, admin, { ...changed, hostId: randomUUID() })).toThrow('registered host');
  });
  it('publishes exactly one selected version with conflict detection and invalidates only then', () => {
    const { task, caller, input } = approved();
    const job = scriptJobSchema.parse(call('POST', '/scripts/requests', caller.credential, input));
    const draft = scriptVersionSchema.parse(call('POST', `/admin/scripts/${task.id}`, admin, { ...definition, description: 'Draft' }));
    const published = scriptTaskSchema.parse(call('POST', `/admin/scripts/${task.id}/publish`, admin, {
      version: draft.version, expectedPublishedHash: task.definitionHash,
    }));
    expect(published).toMatchObject({ publishedVersion: 2, definitionHash: draft.definitionHash });
    expect(call('GET', `/scripts/jobs/${job.id}`, caller.credential)).toMatchObject({ state: 'cancelled' });
    expect(call('GET', '/scripts', caller.credential)).toEqual([]);
    expect(() => call('POST', `/admin/scripts/${task.id}/publish`, admin, {
      version: 1, expectedPublishedHash: task.definitionHash,
    })).toThrow('Published version changed');
    expect(() => call('POST', `/admin/scripts/${task.id}/publish`, caller.credential, {
      version: 1, expectedPublishedHash: published.definitionHash,
    })).toThrow('invalid_credential');
    expect(call('POST', `/admin/scripts/${task.id}/publish`, admin, {
      version: 1, expectedPublishedHash: published.definitionHash,
    })).toMatchObject({ publishedVersion: 1, latestVersion: 2 });
    expect(store.db.prepare('SELECT COUNT(*) AS count FROM host_script_tasks WHERE id=?').get(task.id)?.count).toBe(1);
  });
  it('fences chat draft saves against concurrent task edits', () => {
    const task = register();
    const changed = { ...definition, description: 'First edit' };
    expect(call('POST', `/admin/scripts/${task.id}/versions`, admin, { definition: changed, expectedLatestVersion: 1 }))
      .toMatchObject({ version: 2 });
    expect(() => call('POST', `/admin/scripts/${task.id}/versions`, admin, {
      definition: { ...definition, description: 'Stale edit' }, expectedLatestVersion: 1,
    })).toThrow('Task drafts changed');
    const details = scriptDetailsSchema.parse(call('GET', `/admin/scripts/${task.id}`));
    expect(details.versions).toHaveLength(2);
    expect(details.versions[0].definition).toEqual(changed);
    expect(details.task.publishedVersion).toBe(1);
  });
  it('atomically claims only the requested draft test, keeping other jobs and published access separate', () => {
    const { task, caller, input } = approved();
    const callerJob = scriptJobSchema.parse(call('POST', '/scripts/requests', caller.credential, input));
    const changed = { ...definition, source: 'module.exports = p => ({ draft: p.name });' };
    const draft = scriptVersionSchema.parse(call('POST', `/admin/scripts/${task.id}`, admin, changed));
    const test = { taskId: task.id, version: 2, definitionHash: draft.definitionHash,
      parameters: { name: 'Ada' }, idempotencyKey: 'owner-test', hostId };
    expect(() => call('POST', '/admin/scripts/test/claim', admin, { ...test, hostId: randomUUID() })).toThrow('on this host');
    const lease = scriptLeaseSchema.parse(call('POST', '/admin/scripts/test/claim', admin, test));
    expect(lease.jobId).not.toBe(callerJob.id);
    expect(lease.definition).toEqual(changed);
    expect(call('GET', `/admin/scripts/jobs/${lease.jobId}`)).toMatchObject({ version: 2, state: 'running', appId: null });
    expect(call('GET', `/scripts/jobs/${callerJob.id}`, caller.credential)).toMatchObject({ state: 'queued' });
    expect(() => call('GET', `/scripts/jobs/${lease.jobId}`, caller.credential)).toThrow('Job not found');
    expect(() => call('POST', '/scripts/requests', caller.credential, test)).toThrow();
    call('POST', `/admin/scripts/${task.id}/publish`, admin, { version: 2, expectedPublishedHash: task.definitionHash });
    expect(call('POST', '/admin/scripts/complete', admin, { jobId: lease.jobId, leaseToken: lease.leaseToken, resultJson: '{"draft":"Ada"}' }))
      .toMatchObject({ version: 2, state: 'succeeded', resultJson: '{"draft":"Ada"}' });
  });
  it('pins source, parameters, timeout, and host while keeping definitions outside document CRUD', () => {
    const task = register();
    expect(task).not.toHaveProperty('source');
    expect(store.getDocument({ id: task.id })).toBeNull();
    expect(task.definitionHash).toBe(scriptDefinitionHash(definition));
    for (const change of [
      { source: definition.source + '\n' }, { timeoutMs: 2000 }, { hostId: randomUUID() },
      { parameters: { name: { type: 'string' as const, required: true, maxLength: 25 } } },
    ]) expect(scriptDefinitionHash({ ...definition, ...change })).not.toBe(task.definitionHash);
    expect(scriptDefinitionHash({ ...definition, parameters: { ...definition.parameters } })).toBe(task.definitionHash);
  });
  it('requires separate app authentication and an explicit grant, never admin-through-app', () => {
    const task = register(), caller = app();
    expect(() => call('GET', '/scripts', '')).toThrow('invalid_credential');
    expect(call('GET', '/scripts', caller.credential)).toEqual([]);
    expect(() => call('GET', '/admin/scripts', caller.credential)).toThrow('invalid_credential');
    expect(() => call('POST', '/scripts/requests', caller.credential, {
      taskId: task.id, definitionHash: task.definitionHash, parameters: { name: 'Michael' }, idempotencyKey: 'one',
    })).toThrow('explicit unexpired grant');
    expect(() => call('POST', '/admin/scripts/grants', admin, {
      taskId: task.id, appId: caller.appId, definitionHash: '0'.repeat(64), expiresAt: now + 1000,
    })).toThrow('version changed');
  });
  it('validates parameter names, types, enums, integer ranges, required values, and schema fields', () => {
    const schema = scriptParametersSchema.parse({
      name: { type: 'string', required: true, maxLength: 10, enum: ['Ada'] },
      count: { type: 'integer', minimum: 1, maximum: 3 }, verbose: { type: 'boolean' },
    });
    expect(validateScriptArguments(schema, { name: 'Ada', count: 2, verbose: false }))
      .toEqual({ name: 'Ada', count: 2, verbose: false });
    for (const input of [
      {}, { name: 'Other' }, { name: 'Ada', shell: 'echo injected' },
      { name: 'Ada', count: '2' }, { name: 'Ada', count: 4 }, { name: 'Ada', verbose: 1 }, [],
    ]) expect(() => validateScriptArguments(schema, input)).toThrow();
    expect(() => scriptParametersSchema.parse({ name: { type: 'string', pattern: '.*' } })).toThrow();
    expect(() => scriptParametersSchema.parse({ constructor: { type: 'boolean' } })).toThrow();
    expect(() => scriptDefinitionSchema.parse({ ...definition, executable: '/bin/sh' })).toThrow();
  });
  it('deduplicates requests without allowing a changed payload or concurrent jobs for the same caller', () => {
    const { caller, input } = approved();
    const first = call('POST', '/scripts/requests', caller.credential, input);
    expect(call('POST', '/scripts/requests', caller.credential, input)).toEqual(first);
    expect(() => call('POST', '/scripts/requests', caller.credential, {
      ...input, parameters: { name: 'Ada' },
    })).toThrow('Idempotency key');
    expect(() => call('POST', '/scripts/requests', caller.credential, {
      ...input, idempotencyKey: 'another',
    })).toThrow('already active');
    expect(() => call('POST', '/scripts/requests', caller.credential, {
      ...input, parameters: { name: 'Michael', source: 'evil' },
    })).toThrow('Unknown parameter');
  });
  it('leases only to the registered host and fences completion and private results', () => {
    const { task, caller, input } = approved();
    const other = app();
    const job = scriptJobSchema.parse(call('POST', '/scripts/requests', caller.credential, input));
    expect(call('POST', '/admin/scripts/claim', admin, { hostId: randomUUID() })).toBeNull();
    const lease = scriptLeaseSchema.parse(call('POST', '/admin/scripts/claim', admin, { hostId }));
    expect(lease.definition).toEqual(definition);
    expect(() => call('GET', `/scripts/jobs/${job.id}`, other.credential)).toThrow('Job not found');
    expect(() => call('POST', '/admin/scripts/complete', admin, {
      jobId: job.id, leaseToken: '0'.repeat(64), resultJson: '{}',
    })).toThrow('lease invalid');
    call('POST', '/admin/scripts/complete', admin, { jobId: job.id, leaseToken: lease.leaseToken, resultJson: '{"greeting":"Michael"}' });
    expect(call('GET', `/scripts/jobs/${job.id}`, caller.credential)).toMatchObject({ state: 'succeeded', resultJson: '{"greeting":"Michael"}' });
    expect(() => call('POST', '/admin/scripts/complete', admin, {
      jobId: job.id, leaseToken: lease.leaseToken, resultJson: '{}',
    })).toThrow('lease invalid');
    call('POST', `/admin/scripts/${task.id}/revoke`, admin, {});
    expect(call('GET', `/scripts/jobs/${job.id}`, caller.credential)).toMatchObject({ state: 'cancelled', resultJson: null });
  });
  it.each(['grant', 'caller', 'expiry', 'lease'])('rejects late completion after %s invalidation', (reason) => {
    const { caller, grant, input } = approved();
    const job = scriptJobSchema.parse(call('POST', '/scripts/requests', caller.credential, input));
    const lease = scriptLeaseSchema.parse(call('POST', '/admin/scripts/claim', admin, { hostId }));
    if (reason === 'grant') call('POST', `/admin/scripts/grants/${grant.id}/revoke`, admin, {});
    if (reason === 'caller') call('POST', `/admin/apps/${caller.appId}/revoke`, admin, {});
    if (reason === 'expiry') now += 61000;
    if (reason === 'lease') now = lease.deadline + 1;
    expect(() => call('POST', '/admin/scripts/complete', admin, {
      jobId: job.id, leaseToken: lease.leaseToken, resultJson: '{}',
    })).toThrow('lease invalid');
    expect(call('GET', `/admin/scripts/jobs/${job.id}`)).toMatchObject({ resultJson: null });
  });
  it('bounds output and expires retained results; audit rows never contain source, parameters, or results', () => {
    const { caller, input } = approved();
    const job = scriptJobSchema.parse(call('POST', '/scripts/requests', caller.credential, input));
    const lease = scriptLeaseSchema.parse(call('POST', '/admin/scripts/claim', admin, { hostId }));
    for (const resultJson of ['not json', JSON.stringify('x'.repeat(65536))]) {
      expect(() => call('POST', '/admin/scripts/complete', admin, { jobId: job.id, leaseToken: lease.leaseToken, resultJson })).toThrow();
    }
    call('POST', '/admin/scripts/complete', admin, { jobId: job.id, leaseToken: lease.leaseToken, resultJson: '{"private":"output"}' });
    now += 61000;
    expect(call('GET', `/scripts/jobs/${job.id}`, caller.credential)).toMatchObject({ resultJson: null });
    const audit = JSON.stringify(store.db.prepare('SELECT * FROM host_task_audit').all());
    for (const secret of ['Michael', 'private', definition.source]) expect(audit).not.toContain(secret);
  });
});
