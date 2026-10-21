import { randomBytes } from 'node:crypto';
import { afterEach, expect, it } from 'vitest';
import { startServer, type RunningServer } from '../../control-plane/src/server';
import { HOST_TASK_OPERATION_HASH, HOST_TASK_OPERATION_VERSION } from '../../shared/hostTasks';
import { HostTaskAdminClient, reviewedHostTaskOperation } from '../src/main/hostTaskBroker';

const servers: RunningServer[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => server.close()));
});

it('uses the real protected broker contract for reviewed approval, denial, and app credential revocation', async () => {
  const adminCredential = randomBytes(32).toString('hex');
  const server = await startServer({ port: 0, hostTaskAdminCredential: adminCredential });
  servers.push(server);
  const client = new HostTaskAdminClient(`${server.url}/mcp`, adminCredential);
  const initial = await client.snapshot();
  expect(initial.policy.policyHash).toBe(HOST_TASK_OPERATION_HASH);
  expect(initial.policy.operationVersion).toBe(HOST_TASK_OPERATION_VERSION);
  reviewedHostTaskOperation(initial.policy.operation, initial.policy.policyHash);
  expect(initial.executionBlockedReason).toContain('verified Windows');
  expect(initial.runners).toEqual([]);

  const app = await client.createApp({ label: 'Desktop contract test', instanceId: 'contract-test-instance' });
  await client.grant({
    appId: app.appId, windowsSid: 'S-1-5-21-123-456-789-1001',
    tenantId: '12345678-1234-4234-8234-123456789012', expiresAt: Date.now() + 3_600_000,
  }, initial.policy);
  const approved = await client.snapshot();
  expect(approved.grants[0]).toMatchObject({
    appId: app.appId, operationHash: initial.policy.policyHash, operation: initial.policy.operation,
  });
  for (const secret of [adminCredential, app.credential]) expect(JSON.stringify(approved)).not.toContain(secret);

  const appRequest = () => fetch(`${server.url}/host-tasks/v1/requests`, {
    method: 'POST',
    headers: { authorization: ['Bearer', app.credential].join(' '), 'content-type': 'application/json' },
    body: JSON.stringify({ capability: 'thrive.sync.read', idempotencyKey: 'desktop-contract-test' }),
  });
  const response = await appRequest();
  expect(response.status).toBe(202);
  const job = await response.json() as { id: string; state: string };
  expect(job.state).toBe('queued');
  await client.deny(job.id);
  expect((await client.snapshot()).jobs.find((candidate) => candidate.id === job.id)?.state).toBe('denied');

  await client.revokeApp(app.appId);
  const revoked = await client.snapshot();
  expect(revoked.apps[0].revokedAt).toEqual(expect.any(Number));
  expect(revoked.grants[0].revokedAt).toEqual(expect.any(Number));
  expect((await appRequest()).status).toBe(401);
}, 15_000);
