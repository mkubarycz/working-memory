import { afterEach, beforeAll, expect, it, vi } from 'vitest';
import { ControlPlaneClient } from '../../shared/controlPlaneClient';
import { openStore } from '../../control-plane/src/store';
import { startServer } from '../../control-plane/src/server';
import { InstanceIdentity } from '../../control-plane/src/instanceIdentity';
import { loadKinds } from '../../control-plane/src/kinds/loader';
import { createFeatureBugReport } from '../src/main/featureBugReport';
import type { FeatureBugReportInput } from '../src/shared/contracts';

const cleanup: Array<() => Promise<void>> = [];
beforeAll(() => loadKinds());
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });

const input: FeatureBugReportInput = {
  description: 'Observability will not enable',
  failure: {
    error: 'podman info did not respond within 30s.',
    operation: 'instance:set-features', capturedAt: '2026-11-19T15:00:00.000Z',
    requested: { feature: 'observability', enabled: true },
    features: { hostTasks: false, search: true, observability: false }, embeddingsEnabled: true,
  },
};
const dependencies = {
  assertCurrent: vi.fn(), secrets: ['PRIVATE_MODEL_KEY'],
  environment: { desktopVersion: '1.10.1-dev', desktopBuild: 'fixture', backendUrl: 'http://localhost:7719/mcp',
    platform: 'win32', arch: 'x64', processId: 123 },
  featureDiagnostics: {
    provider: 'podman', durationMs: 30012,
    commands: [{ command: 'podman info', durationMs: 30001, timeoutMs: 30000, status: 'error', code: 'ETIMEDOUT' }],
  },
};

it('persists the selected feature error and measured provider command evidence through the real report entry point', async () => {
  const store = openStore(':memory:');
  const owner = await new InstanceIdentity(store.db).initialize('private report test password');
  const server = await startServer({ port: 0, store });
  const client = new ControlPlaneClient({ resolveUrl: () => `${server.url}/mcp`, getToken: () => owner.token });
  cleanup.push(async () => { await client.dispose(); await server.close(); store.close(); });
  await client.topicTypeCreate({ label: 'Topic', icon: 'symbol-misc', description: 'Default topic' });
  const report = await createFeatureBugReport(input, { ...dependencies, client });
  expect(report.title).toBe('Feature settings bug: Observability will not enable');
  for (const text of ['instance:set-features', 'podman info', 'ETIMEDOUT', '"timeoutMs": 30000',
    '"durationMs": 30001', '"observability": false', '"feature": "observability"', '"enabled": true', 'win32', 'fixture']) {
    expect(report.body).toContain(text);
  }
  expect((await client.topicRead({ id: report.id }))[0].body).toBe(report.body);
});

it('redacts known credentials and secret fields and bounds oversized diagnostics', async () => {
  const report = await createFeatureBugReport({
    ...input, description: 'PRIVATE_MODEL_KEY', failure: { ...input.failure, error: 'PRIVATE_MODEL_KEY failed' },
  }, { ...dependencies, client: { topicCreate: vi.fn().mockResolvedValue({ id: 'report' }) },
    featureDiagnostics: { token: 'private-token', detail: 'x'.repeat(100000) } });
  expect(JSON.stringify(report)).not.toContain('PRIVATE_MODEL_KEY');
  expect(report.body).not.toContain('private-token');
  expect(report.body).toContain('Evidence truncated');
  expect(report.body.length).toBeLessThan(40000);
});

it('rejects invalid input and environment changes without creating a report or probing the provider', async () => {
  const topicCreate = vi.fn();
  await expect(createFeatureBugReport({ ...input, description: ' ' }, { ...dependencies, client: { topicCreate } })).rejects.toThrow();
  await expect(createFeatureBugReport(input, { ...dependencies, client: { topicCreate },
    assertCurrent: () => { throw new Error('Environment changed'); } })).rejects.toThrow('Environment changed');
  expect(topicCreate).not.toHaveBeenCalled();
});
