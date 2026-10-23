import { randomBytes, randomUUID } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openStore, type Store } from '../src/store';
import { HostTaskBroker } from '../src/hostTasks';
import {
  scriptDefinitionSchema, scriptDefinitionHash, scriptJobSchema, scriptLeaseSchema,
  scriptTaskSchema, scriptParametersSchema, validateScriptArguments,
} from '../src/hostScriptPolicy';
import { z } from 'zod';

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
