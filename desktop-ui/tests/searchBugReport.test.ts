import { afterEach, beforeAll, expect, it, vi } from 'vitest';
import { ControlPlaneClient } from '../../shared/controlPlaneClient';
import { openStore } from '../../control-plane/src/store';
import { startServer } from '../../control-plane/src/server';
import { InstanceIdentity } from '../../control-plane/src/instanceIdentity';
import { loadKinds } from '../../control-plane/src/kinds/loader';
import { createSearchBugReport } from '../src/main/searchBugReport';
import type { SearchBugReportInput } from '../src/shared/contracts';
import { placementBugContext } from '../src/renderer/documents/topicPlacementActions';

const cleanup: Array<() => Promise<void>> = [];
beforeAll(() => loadKinds());
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });
const input: SearchBugReportInput = {
  description: 'Exact number has low similarity',
  search: {
    prompt: '20252810381629475062',
    context: { document: { id: 'topic-1', title: 'Numbered topic', kind: 'topic' } },
    response: { query: '20252810381629475062', queries: ['20252810381629475062'], limited: true,
      results: [{ id: 'topic-1', title: 'Exact numbered topic', kind: 'Topic', excerpt: '20252810381629475062',
        score: 0.28, similarity: 0.28, literalMatch: true,
        confidence: { level: 'high', reason: 'Exact word occurs.' }, reason: 'Contains your search text.' }] },
    trace: [{ id: 'retrieval-1', tool: 'wm-semantic-search', arguments: { limit: 20 },
      durationMs: 120, status: 'success', count: 20 }],
    loading: false, error: '', notice: '', requestId: null,
  },
};
const options = {
  environment: { desktopVersion: '1.11.0-dev', desktopBuild: 'fixture', backendUrl: 'http://localhost:7719/mcp',
    platform: 'win32', arch: 'x64', processId: 123 },
  secrets: ['PRIVATE_MODEL_KEY'], assertCurrent: vi.fn(), now: () => Date.parse('2026-11-16T12:00:00Z'),
};

it('persists query, scope, complete displayed result evidence and timings through the report production entry point', async () => {
  const store = openStore(':memory:');
  const owner = await new InstanceIdentity(store.db).initialize('private report test password');
  const server = await startServer({ port: 0, store });
  const client = new ControlPlaneClient({ resolveUrl: () => `${server.url}/mcp`, getToken: () => owner.token });
  cleanup.push(async () => { await client.dispose(); await server.close(); store.close(); });
  await client.topicTypeCreate({ label: 'Topic', icon: 'symbol-misc', description: 'Default topic' });
  const report = await createSearchBugReport(input, { ...options, client });
  expect(report.title).toBe('Search bug: Exact number has low similarity');
  for (const text of [input.search.prompt, 'Numbered topic', 'Exact numbered topic', '"similarity": 0.28',
    '"literalMatch": true', '"level": "high"', '"limited": true', '"returnedResults": 1',
    '"limit": 20', '"durationMs": 120', 'http://localhost:7719', 'fixture']) expect(report.body).toContain(text);
  expect((await client.topicRead({ id: report.id }))[0].body).toBe(report.body);
  const selected = {
    parent: { id: 'parent', title: 'Suggested parent', resourceVersion: 5 },
    workstream: { id: 'workstream', title: 'Suggested workstream', resourceVersion: 7 },
    similarity: 0.8, confidence: { level: 'high' as const, reason: 'Shared case reference' },
    excerpt: 'Matching authored evidence PRIVATE_MODEL_KEY https://inbox.blob.core.windows.net/reports?sp=c&sig=123456789012&se=2099',
    evidence: 'parent-membership' as const,
  };
  const placementReport = await createSearchBugReport({
    description: 'This is the wrong suggested parent.',
    search: placementBugContext({ id: 'source', title: 'Source topic', resourceVersion: 3 },
      { state: 'ready', sourceVersion: 3, limited: false, suggestions: [selected] }, selected, '', false),
  }, { ...options, client });
  expect(placementReport.body).toContain('## Supporting evidence');
  for (const text of ['Suggested parent', 'Suggested workstream', 'Shared case reference', 'Matching authored evidence']) {
    expect(placementReport.body).toContain(text);
  }
  expect(placementReport.body).not.toContain('PRIVATE_MODEL_KEY');
  expect(placementReport.body).not.toContain('123456789012');
  expect((await client.topicRead({ id: placementReport.id }))[0].body).toBe(placementReport.body);
});

it('captures failed, in-progress and empty searches without changing or restarting a search', async () => {
  const topicCreate = vi.fn().mockResolvedValue({ id: 'report' });
  for (const loading of [true, false]) {
    const report = await createSearchBugReport({ ...input, search: { ...input.search,
      response: null, requestId: 'running-request', loading, error: 'Embedding inference timed out' } },
    { ...options, client: { topicCreate } });
    expect(report.body).toContain(`"loading": ${loading}`);
    expect(report.body).toContain('Embedding inference timed out');
    expect(report.body).toContain('running-request');
    expect(report.body).toContain('"returnedResults": 0');
  }
  expect(topicCreate).toHaveBeenCalledTimes(2);
});

it('redacts evidence and titles, preserves every normal result, and marks oversized evidence omissions', async () => {
  const results = Array.from({ length: 102 }, (_, index) => ({ id: `result-${index}`, similarity: 0.28,
    excerpt: index === 0 ? 'PRIVATE_MODEL_KEY wm-attachment:abc Basic c2VjcmV0 sk-secrettoken123' : 'x'.repeat(10000),
    nested: { token: 'private-token', media: { type: 'image', data: 'private-image-bytes' } } }));
  const report = await createSearchBugReport({ ...input, description: 'PRIVATE_MODEL_KEY',
    search: { ...input.search, response: { ...input.search.response, results } } },
  { ...options, client: { topicCreate: vi.fn().mockResolvedValue({ id: 'report' }) } });
  for (const secret of ['PRIVATE_MODEL_KEY', 'private-token', 'private-image-bytes', 'c2VjcmV0', 'sk-secrettoken123', 'wm-attachment:']) {
    expect(JSON.stringify(report)).not.toContain(secret);
  }
  expect(report.body).toContain('"includedResults": 100');
  expect(report.body).toContain('"omittedResults": 2');
  expect(report.body).toContain('result-99');
  expect(report.body).not.toContain('result-100');
  expect(report.body).toContain('Evidence truncated');
  expect(report.body.length).toBeLessThan(800000);
});

it('rejects invalid input and environment changes before creating a topic', async () => {
  const topicCreate = vi.fn();
  await expect(createSearchBugReport({ ...input, description: ' ' }, { ...options, client: { topicCreate } })).rejects.toThrow();
  await expect(createSearchBugReport(input, { ...options, client: { topicCreate },
    assertCurrent: () => { throw new Error('Environment changed'); } })).rejects.toThrow('Environment changed');
  expect(topicCreate).not.toHaveBeenCalled();
});
