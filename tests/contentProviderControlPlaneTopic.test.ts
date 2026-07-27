/**
 * WM 13.0 "topic-consumer-repoint" + generalized control-plane-first docs: the
 * `working-memory:/topic/<slug>.md`, `/workstream/<slug>.md`, and
 * `/topic-type/<slug>.md` virtual docs resolve CONTROL-PLANE-FIRST. When the
 * slug is a control-plane document, `WorkstreamDocumentProvider` fetches it via
 * `getDocument({ slug, kind })` and renders the per-kind document body
 * (READ-ONLY). When the slug is NOT a control-plane document (or the daemon is
 * down), it falls back to the journal renderer (topic / topic-type stay
 * writable while a journal store is present; workstream is always read-only).
 */

import { test, expect, vi } from 'vitest';
import { openJournalStore } from '../src/db';
import type {
  ControlPlaneClient,
  DocumentEnvelope,
  Topic,
} from '../src/controlPlaneClient';

vi.mock('vscode', () => {
  class EventEmitter<T> {
    private _listeners: Array<(e: T) => void> = [];
    get event() {
      return (listener: (e: T) => void) => {
        this._listeners.push(listener);
        return { dispose: () => {} };
      };
    }
    fire(data: T): void {
      for (const l of this._listeners) {
        l(data);
      }
    }
  }
  class FileSystemError extends Error {
    static NoPermissions(uri: unknown): FileSystemError {
      return new FileSystemError(`NoPermissions: ${String(uri)}`);
    }
    static FileNotFound(uri: unknown): FileSystemError {
      return new FileSystemError(`FileNotFound: ${String(uri)}`);
    }
  }
  class Disposable {
    constructor(private fn: () => void) {}
    dispose() {
      this.fn();
    }
  }
  return {
    EventEmitter,
    FileSystemError,
    FileChangeType: { Changed: 2 },
    FileType: { File: 1 },
    FilePermission: { Readonly: 1 },
    Disposable,
    Uri: { parse: (s: string) => ({ toString: () => s }) },
    window: { showErrorMessage: vi.fn() },
  };
});

function makeUri(path: string): unknown {
  return { path, toString: () => `working-memory:${path}` };
}

function makeTopic(id: string, slug: string): Topic {
  return {
    id,
    slug,
    title: 'CP Topic',
    body: 'control-plane body text',
    status: 'open',
    topicType: 'topic',
    parents: [],
    workstreams: [],
    created_at: 1_700_000_000,
    updated_at: 1_700_000_500,
    resourceVersion: 3,
  };
}

function makeEnvelope(id: string, slug: string): DocumentEnvelope {
  return {
    kind: 'Topic',
    metadata: {
      id,
      slug,
      labels: {},
      createdAt: 1_700_000_000,
      updatedAt: 1_700_000_500,
      deletedAt: null,
      resourceVersion: 3,
    },
    spec: { title: 'CP Topic', body: 'control-plane body text', status: 'open' },
    status: {},
  };
}

function makeWorkstreamEnvelope(id: string, slug: string): DocumentEnvelope {
  return {
    kind: 'Workstream',
    metadata: {
      id,
      slug,
      labels: {},
      createdAt: 1_700_000_000,
      updatedAt: 1_700_000_500,
      deletedAt: null,
      resourceVersion: 2,
    },
    spec: { title: 'CP Workstream', status: 'progress' },
    status: {},
  };
}

function makeTopicTypeEnvelope(id: string, slug: string): DocumentEnvelope {
  return {
    kind: 'TopicType',
    metadata: {
      id,
      slug,
      labels: {},
      createdAt: 1_700_000_000,
      updatedAt: 1_700_000_500,
      deletedAt: null,
      resourceVersion: 1,
    },
    spec: {
      label: 'CP TopicType',
      icon: 'star',
      description: 'control-plane type desc',
      body_template: '',
    },
    status: {},
  };
}

test('topic doc: resolves control-plane-first and renders the envelope (read-only)', async () => {
  const store = openJournalStore({ dbPath: ':memory:' });
  // A JOURNAL topic with the SAME slug exists — proving the control-plane wins.
  store.createTopic({
    slug: 'cp-topic',
    title: 'Journal Topic',
    body: 'journal body text',
  });

  const topicRead = vi.fn(async (input: { slug?: string }) =>
    input.slug === 'cp-topic' ? [makeTopic('doc-1', 'cp-topic')] : [],
  );
  const getDocument = vi.fn(async (input: { slug?: string; kind?: string }) =>
    input.slug === 'cp-topic' && input.kind === 'Topic'
      ? { available: true, document: makeEnvelope('doc-1', 'cp-topic') }
      : { available: true, document: null },
  );

  const { WorkstreamDocumentProvider } = await import('../src/contentProvider');
  const provider = new WorkstreamDocumentProvider(store);
  provider.setControlPlaneClient({
    topicRead,
    getDocument,
  } as unknown as ControlPlaneClient);

  const uri = makeUri('/topic/cp-topic.md') as Parameters<
    typeof provider.readFile
  >[0];
  const bytes = await provider.readFile(uri);
  const body = Buffer.from(bytes).toString('utf8');

  // Body is the control-plane document rendered via the per-kind Topic
  // renderer (WM 13.0 rich rendering), NOT the journal one.
  expect(body).toContain('# Topic: CP Topic');
  expect(body).toContain('control-plane body text');
  expect(body).not.toContain('journal body text');
  // Resolution goes through getDocument BY SLUG + KIND.
  expect(getDocument).toHaveBeenCalledWith({ slug: 'cp-topic', kind: 'Topic' });

  // A control-plane-resolved topic doc is READ-ONLY (like /document/<id>.md).
  const stat = await provider.stat(uri);
  expect(stat.permissions).toBe(1 /* vscode.FilePermission.Readonly */);

  store.close();
});

test('topic doc: unknown control-plane slug falls back to the journal renderer (writable)', async () => {
  const store = openJournalStore({ dbPath: ':memory:' });
  store.createTopic({
    slug: 'legacy-topic',
    title: 'Legacy Topic',
    body: 'journal body text',
  });

  // ws-topic-read returns no topic → this slug is not a control-plane topic.
  const topicRead = vi.fn(async () => [] as Topic[]);
  const getDocument = vi.fn(async () => ({ available: true, document: null }));

  const { WorkstreamDocumentProvider } = await import('../src/contentProvider');
  const provider = new WorkstreamDocumentProvider(store);
  provider.setControlPlaneClient({
    topicRead,
    getDocument,
  } as unknown as ControlPlaneClient);

  const uri = makeUri('/topic/legacy-topic.md') as Parameters<
    typeof provider.readFile
  >[0];
  const bytes = await provider.readFile(uri);
  const body = Buffer.from(bytes).toString('utf8');

  // Journal render — the topic body is present and it is NOT an envelope doc.
  expect(body).toContain('journal body text');
  expect(body).not.toContain('## Envelope');
  // getDocument was consulted by slug+kind but returned no document → fallback.
  expect(getDocument).toHaveBeenCalledWith({
    slug: 'legacy-topic',
    kind: 'Topic',
  });

  // Journal-fallback doc stays WRITABLE while a journal store is present.
  const stat = await provider.stat(uri);
  expect(stat.permissions).toBeUndefined();

  store.close();
});

test('workstream doc: resolves control-plane-first and renders the Workstream doc (read-only)', async () => {
  const store = openJournalStore({ dbPath: ':memory:' });
  // A JOURNAL workstream with the SAME slug exists — proving the control-plane wins.
  store.createWorkstream({ slug: 'cp-ws', title: 'Journal WS' });

  const getDocument = vi.fn(async (input: { slug?: string; kind?: string }) =>
    input.slug === 'cp-ws' && input.kind === 'Workstream'
      ? { available: true, document: makeWorkstreamEnvelope('ws-1', 'cp-ws') }
      : { available: true, document: null },
  );

  const { WorkstreamDocumentProvider } = await import('../src/contentProvider');
  const provider = new WorkstreamDocumentProvider(store);
  provider.setControlPlaneClient({
    getDocument,
  } as unknown as ControlPlaneClient);

  const uri = makeUri('/workstream/cp-ws.md') as Parameters<
    typeof provider.readFile
  >[0];
  const body = Buffer.from(await provider.readFile(uri)).toString('utf8');

  // Body is the control-plane document rendered via the per-kind Workstream
  // renderer, NOT the journal workstream doc (`# Journal WS`).
  expect(body).toContain('# Workstream: CP Workstream');
  expect(body).not.toContain('# Journal WS');
  expect(getDocument).toHaveBeenCalledWith({ slug: 'cp-ws', kind: 'Workstream' });

  // A control-plane-resolved workstream doc is READ-ONLY.
  const stat = await provider.stat(uri);
  expect(stat.permissions).toBe(1 /* vscode.FilePermission.Readonly */);

  store.close();
});

test('workstream doc: unknown control-plane slug falls back to the journal renderer', async () => {
  const store = openJournalStore({ dbPath: ':memory:' });
  store.createWorkstream({ slug: 'legacy-ws', title: 'Journal WS' });

  const getDocument = vi.fn(async () => ({ available: true, document: null }));

  const { WorkstreamDocumentProvider } = await import('../src/contentProvider');
  const provider = new WorkstreamDocumentProvider(store);
  provider.setControlPlaneClient({
    getDocument,
  } as unknown as ControlPlaneClient);

  const uri = makeUri('/workstream/legacy-ws.md') as Parameters<
    typeof provider.readFile
  >[0];
  const body = Buffer.from(await provider.readFile(uri)).toString('utf8');

  // Journal render — NOT the control-plane Workstream envelope doc.
  expect(body).toContain('# Journal WS');
  expect(body).not.toContain('# Workstream: CP Workstream');
  expect(getDocument).toHaveBeenCalledWith({
    slug: 'legacy-ws',
    kind: 'Workstream',
  });

  // Journal workstream docs are always read-only (never in the writable set).
  const stat = await provider.stat(uri);
  expect(stat.permissions).toBe(1 /* vscode.FilePermission.Readonly */);

  store.close();
});

test('topic-type doc: resolves control-plane-first and renders the TopicType doc (read-only)', async () => {
  const store = openJournalStore({ dbPath: ':memory:' });
  // A JOURNAL topic-type with the SAME id exists — proving the control-plane wins.
  store.createTopicType({
    id: 'cp-tt',
    label: 'Journal Label',
    icon: 'tag',
    description: 'journal desc',
  });

  const getDocument = vi.fn(async (input: { slug?: string; kind?: string }) =>
    input.slug === 'cp-tt' && input.kind === 'TopicType'
      ? { available: true, document: makeTopicTypeEnvelope('tt-1', 'cp-tt') }
      : { available: true, document: null },
  );

  const { WorkstreamDocumentProvider } = await import('../src/contentProvider');
  const provider = new WorkstreamDocumentProvider(store);
  provider.setControlPlaneClient({
    getDocument,
  } as unknown as ControlPlaneClient);

  const uri = makeUri('/topic-type/cp-tt.md') as Parameters<
    typeof provider.readFile
  >[0];
  const body = Buffer.from(await provider.readFile(uri)).toString('utf8');

  // Body is the control-plane document rendered via the per-kind TopicType
  // renderer, NOT the journal topic-type doc (`# Journal Label`).
  expect(body).toContain('# TopicType: CP TopicType');
  expect(body).not.toContain('# Journal Label');
  expect(getDocument).toHaveBeenCalledWith({ slug: 'cp-tt', kind: 'TopicType' });

  // A control-plane-resolved topic-type doc is READ-ONLY.
  const stat = await provider.stat(uri);
  expect(stat.permissions).toBe(1 /* vscode.FilePermission.Readonly */);

  store.close();
});

test('topic-type doc: unknown control-plane slug falls back to the journal renderer (writable)', async () => {
  const store = openJournalStore({ dbPath: ':memory:' });
  store.createTopicType({
    id: 'legacy-tt',
    label: 'Journal Label',
    icon: 'tag',
    description: 'journal desc',
  });

  const getDocument = vi.fn(async () => ({ available: true, document: null }));

  const { WorkstreamDocumentProvider } = await import('../src/contentProvider');
  const provider = new WorkstreamDocumentProvider(store);
  provider.setControlPlaneClient({
    getDocument,
  } as unknown as ControlPlaneClient);

  const uri = makeUri('/topic-type/legacy-tt.md') as Parameters<
    typeof provider.readFile
  >[0];
  const body = Buffer.from(await provider.readFile(uri)).toString('utf8');

  // Journal render — NOT the control-plane TopicType envelope doc.
  expect(body).toContain('# Journal Label');
  expect(body).not.toContain('# TopicType: CP TopicType');
  expect(getDocument).toHaveBeenCalledWith({
    slug: 'legacy-tt',
    kind: 'TopicType',
  });

  // Journal-fallback topic-type doc stays WRITABLE while a store is present.
  const stat = await provider.stat(uri);
  expect(stat.permissions).toBeUndefined();

  store.close();
});
