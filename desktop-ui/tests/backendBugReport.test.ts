import { afterEach, expect, it, vi } from 'vitest';
import { BackendBugReports } from '../src/main/backendBugReport';
import { serializeFeedback } from '../src/main/topicSharing';
import type { BackendBugReportInput } from '../src/shared/contracts';

afterEach(() => vi.unstubAllGlobals());

const input: BackendBugReportInput = {
  description: 'Updating the backend fails',
  failure: {
    error: 'Error: bind: address already in use', operation: '7720:upgrade',
    capturedAt: '2026-11-19T15:00:00.000Z', provider: 'podman',
    instance: { port: 7720, name: 'Work', createdAt: '', mcpUrl: 'http://localhost:7720/mcp',
      container: 'working-memory-control-plane-7720', state: 'running', version: '1.0.0', updateAvailable: true },
    backendChannel: 'canary', backendTarget: { version: '2.1.0', image: 'ghcr.io/test/control-plane:2.1.0' },
  },
};
const dependencies = {
  secrets: ['PRIVATE_MODEL_KEY'],
  environment: { desktopVersion: '1.10.1-dev', desktopBuild: 'fixture', backendUrl: null,
    platform: 'win32', arch: 'x64', processId: 123 },
  upgradeFailure: vi.fn(() => ({ error: { stderr: 'bind: address already in use' },
    configuration: { ports: ['127.0.0.1:7720:7720'] }, target: input.failure.backendTarget })),
};

it('captures upgrade evidence and prepares Feedback without contacting the offline backend or creating a topic', async () => {
  const fetcher = vi.fn().mockRejectedValue(new Error('Backend is offline'));
  vi.stubGlobal('fetch', fetcher);
  const reports = new BackendBugReports();
  const draft = reports.create(input, dependencies);
  expect(draft.sessionOnly).toBe(true);
  for (const text of ['bind: address already in use', '7720:upgrade', 'podman', 'win32', '1.0.0', '2.1.0', '127.0.0.1:7720:7720']) {
    expect(draft.body).toContain(text);
  }
  const source = reports.feedbackSource(draft.id);
  if (!source) throw new Error('Missing backend report');
  const payload = JSON.parse(await serializeFeedback(source.topic, source.sourceUrl, draft.id, source.context));
  expect(payload.topic.body).toContain(draft.body);
  expect(source.context.backend.version).toBe('1.0.0');
  expect(payload.topic.body).toContain('Selected backend version: "1.0.0"');
  expect(payload.attachments).toEqual([]);
  expect(fetcher).not.toHaveBeenCalled();
  const receipt = { id: draft.id, title: draft.title, duplicate: false,
    statusUrl: 'https://feedback.invalid/submissions/report', submittedAt: '2026-11-19T15:00:00.000Z' };
  await source.recordReceipt(receipt);
  await source.recordReceipt(receipt);
  expect(reports.feedbackSource(draft.id)?.topic.body.split(receipt.statusUrl)).toHaveLength(2);
});

it('redacts known credentials and secret fields, neutralizes attachment references, and bounds command output', () => {
  const reports = new BackendBugReports();
  const draft = reports.create({ ...input, description: 'PRIVATE_MODEL_KEY wm-attachment:abc',
    failure: { ...input.failure, error: 'PRIVATE_MODEL_KEY' } }, {
    ...dependencies, upgradeFailure: () => ({ token: 'private-token', stdout: 'x'.repeat(100000) }),
  });
  expect(JSON.stringify(draft)).not.toContain('PRIVATE_MODEL_KEY');
  expect(draft.body).not.toContain('private-token');
  expect(draft.body).not.toContain('wm-attachment:');
  expect(draft.body).toContain('Evidence truncated');
  expect(draft.body.length).toBeLessThan(40000);
});

it('rejects invalid reports without replacing the current report', () => {
  const reports = new BackendBugReports();
  const draft = reports.create(input, dependencies);
  expect(() => reports.create({ ...input, description: '' }, dependencies)).toThrow();
  expect(reports.feedbackSource(draft.id)).toBeDefined();
  expect(reports.feedbackSource('not-a-report')).toBeUndefined();
});
