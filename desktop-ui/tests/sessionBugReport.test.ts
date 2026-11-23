import { afterEach, expect, it, vi } from 'vitest';
import { SessionBugReports } from '../src/main/sessionBugReport';
import { serializeFeedback } from '../src/main/topicSharing';
import type { SessionBugReportInput } from '../src/shared/contracts';

afterEach(() => vi.unstubAllGlobals());

const input: SessionBugReportInput = {
  renderer: {
    capturedAt: '2026-11-23T14:00:00.000Z', screen: 'workspace', authenticated: false,
    backendHealth: null, aiHealth: { state: 'unreachable', result: 'Not configured', observedAt: 0 },
    features: { hostTasks: false, search: false }, openDocuments: 0, activeChatContexts: 0,
    errors: { connection: 'Backend unavailable' },
  },
  operation: null,
};
const dependencies = {
  secrets: ['PRIVATE_MODEL_KEY'], uptimeSeconds: 120,
  diagnostics: vi.fn(() => ({ activeRunsOnThisDesktop: 1, limits: { requestTimeoutMs: 30000 } })),
  environment: { desktopVersion: '1.2.3-dev', desktopBuild: 'fixture', backendUrl: null,
    platform: 'darwin', arch: 'arm64', processId: 123 },
  upgradeFailure: vi.fn(() => undefined),
};

it('captures a disconnected session without a topic or backend query and keeps the captured source identity', async () => {
  const fetcher = vi.fn().mockRejectedValue(new Error('No backend'));
  vi.stubGlobal('fetch', fetcher);
  const reports = new SessionBugReports();
  const draft = reports.capture(input, { ...dependencies,
    environment: { ...dependencies.environment, backendUrl: 'http://source.invalid:7717/mcp' } });
  const described = reports.describe(draft.id, 'The app stopped responding');
  expect(described.id).toBe(draft.id);
  expect(described.sessionOnly).toBe(true);
  for (const value of ['The app stopped responding', 'darwin', 'arm64', 'fixture', '120', 'Backend unavailable']) {
    expect(described.body).toContain(value);
  }
  const source = reports.feedbackSource(draft.id);
  if (!source) throw new Error('Missing session report');
  expect(source.sourceUrl).toBe('http://source.invalid:7717/mcp');
  const payload = JSON.parse(await serializeFeedback(source.topic, source.sourceUrl, draft.id, source.context));
  expect(payload.attachments).toEqual([]);
  expect(payload.topic.body).toContain('Unknown (session snapshot; no live backend query)');
  expect(fetcher).not.toHaveBeenCalled();
});

it('allows no environment and filters unexpected session content, credentials, attachment references and oversized evidence', async () => {
  const reports = new SessionBugReports();
  const draft = reports.capture({
    ...input,
    renderer: { ...input.renderer, documentDraft: 'UNSAVED_PRIVATE_DOCUMENT', conversations: ['UNRELATED_CHAT'],
      errors: { connection: 'PRIVATE_MODEL_KEY sk-123456789012 wm-attachment:abc ?sig=secret&x=y' } },
    operation: { kind: 'search', search: { prompt: 'current selected search PRIVATE_MODEL_KEY', response: null,
      context: { token: 'PRIVATE_TOKEN', blob: 'PRIVATE_MEDIA', evidence: 'x'.repeat(100000) },
      loading: true, error: '', notice: '', requestId: 'search-1', trace: [] } },
  }, dependencies);
  const described = reports.describe(draft.id, 'PRIVATE_MODEL_KEY wm-attachment:abc');
  for (const value of ['UNSAVED_PRIVATE_DOCUMENT', 'UNRELATED_CHAT', 'PRIVATE_MODEL_KEY', 'PRIVATE_TOKEN',
    'PRIVATE_MEDIA', 'sk-123456789012', 'sig=secret', 'wm-attachment:']) {
    expect(described.body).not.toContain(value);
  }
  expect(described.body).toContain('current selected search');
  expect(described.body).toContain('truncated');
  expect(described.body.length).toBeLessThan(50000);
  expect(reports.feedbackSource(draft.id)?.sourceUrl).toBe('http://127.0.0.1');
});

it('captures only the selected chat snapshot and tool details, without fetching a journal', () => {
  const reports = new SessionBugReports();
  const draft = reports.capture({ ...input, operation: { kind: 'chat', input: {
    run: { key: 'run-1', journalId: 'journal-1', status: 'running', startedAt: Date.parse(input.renderer.capturedAt) - 1000,
      userText: 'Selected prompt', assistantText: 'Selected partial response', scope: { kind: 'Topic', id: 'topic-1' },
      attachments: [{ id: 'image-1', filename: 'image.png', mimeType: 'image/png' }],
      unrelatedField: 'UNRELATED_CONVERSATION',
    }, renderer: { conversationBlocked: true, localRequestActive: true },
  }, toolDetail: { call: { arguments: { authorization: 'PRIVATE_TOKEN' } }, result: { blob: 'PRIVATE_IMAGE' } } } }, dependencies);
  expect(draft.body).toContain('Selected prompt');
  expect(draft.body).toContain('Selected partial response');
  expect(draft.body).toContain('No journal captured');
  expect(draft.body).not.toContain('UNRELATED_CONVERSATION');
  expect(draft.body).not.toContain('PRIVATE_TOKEN');
  expect(draft.body).not.toContain('PRIVATE_IMAGE');
  expect(draft.body).not.toContain('wm-attachment:');
});

it('rejects bad input and stale report identities without replacing a valid capture', () => {
  const reports = new SessionBugReports();
  const draft = reports.capture(input, dependencies);
  expect(() => reports.capture({ ...input, renderer: { ...input.renderer, capturedAt: 'invalid' } }, dependencies)).toThrow();
  expect(() => reports.describe(draft.id, '')).toThrow();
  expect(reports.feedbackSource(draft.id)).toBeDefined();
  reports.capture(input, dependencies);
  expect(() => reports.describe(draft.id, 'stale')).toThrow('no longer available');
});
