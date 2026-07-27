/**
 * WM 13.0 "topic-consumer-repoint": the `working-memory:/topic/<slug>.md`
 * virtual doc resolves CONTROL-PLANE-FIRST. When the slug is a control-plane
 * topic, `WorkstreamDocumentProvider` reads it via the canonical topic domain
 * read (`ws-topic-read`), fetches that topic's envelope by id, and renders the
 * document-envelope body (READ-ONLY). When the slug is NOT a control-plane
 * topic (or the daemon is down), it falls back to the journal `renderTopicDoc`
 * (which stays writable while a journal store is present).
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
  const getDocument = vi.fn(async (input: { id?: string }) =>
    input.id === 'doc-1'
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

  // Body is the control-plane document-envelope render, NOT the journal one.
  expect(body).toContain('control-plane body text');
  expect(body).toContain('## Envelope');
  expect(body).not.toContain('journal body text');
  // Resolution went through ws-topic-read, then getDocument BY ID.
  expect(topicRead).toHaveBeenCalledWith({ slug: 'cp-topic' });
  expect(getDocument).toHaveBeenCalledWith({ id: 'doc-1' });

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
  // No control-plane topic → we never fetch a document envelope.
  expect(getDocument).not.toHaveBeenCalled();

  // Journal-fallback doc stays WRITABLE while a journal store is present.
  const stat = await provider.stat(uri);
  expect(stat.permissions).toBeUndefined();

  store.close();
});
