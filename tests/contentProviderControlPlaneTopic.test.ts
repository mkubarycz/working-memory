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
// The journal store was removed in the control-plane cutover. These tests now
// assert CONTROL-PLANE behavior via a mocked ControlPlaneClient; the old
// journal seed calls are harmless no-ops through this stub, and the provider no
// longer reads a store.
function openJournalStore(_opts: unknown) {
  return {
    createTopic(_?: unknown) {},
    createWorkstream(_?: unknown) {},
    createTopicType(_?: unknown) {},
    close() {},
  };
}
import type {
  Alert,
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

test('topic doc: resolves control-plane-first and renders the envelope (writable)', async () => {
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

  // WM 13.0 topic-save cutover: a control-plane topic doc is now WRITABLE —
  // its body saves via ws-topic-update (see the save round-trip test below).
  const stat = await provider.stat(uri);
  expect(stat.permissions).toBeUndefined();

  store.close();
});

test('topic doc: control-plane save routes the edited body to ws-topic-update', async () => {
  const store = openJournalStore({ dbPath: ':memory:' });

  const topicRead = vi.fn(async (input: { slug?: string }) =>
    input.slug === 'cp-topic' ? [makeTopic('doc-1', 'cp-topic')] : [],
  );
  const getDocument = vi.fn(async (input: { slug?: string; kind?: string }) =>
    input.slug === 'cp-topic' && input.kind === 'Topic'
      ? { available: true, document: makeEnvelope('doc-1', 'cp-topic') }
      : { available: true, document: null },
  );
  const topicUpdate = vi.fn(async () => makeTopic('doc-1', 'cp-topic'));

  const { WorkstreamDocumentProvider } = await import('../src/contentProvider');
  const provider = new WorkstreamDocumentProvider(store);
  provider.setControlPlaneClient({
    topicRead,
    getDocument,
    topicUpdate,
  } as unknown as ControlPlaneClient);

  const readUri = makeUri('/topic/cp-topic.md') as Parameters<
    typeof provider.readFile
  >[0];
  // Render the doc, then edit the body inside the editable markers and save.
  const original = Buffer.from(await provider.readFile(readUri)).toString(
    'utf8',
  );
  expect(original).toContain('control-plane body text');
  const edited = original.replace(
    'control-plane body text',
    'edited body text',
  );

  const writeUri = makeUri('/topic/cp-topic.md') as Parameters<
    typeof provider.writeFile
  >[0];
  await provider.writeFile(writeUri, Buffer.from(edited, 'utf8'), {
    create: false,
    overwrite: true,
  });

  // The edited body (sliced from between the markers) is persisted via
  // ws-topic-update, NOT the journal store.
  expect(topicUpdate).toHaveBeenCalledWith({
    slug: 'cp-topic',
    body: 'edited body text',
  });

  store.close();
});

test('topic doc: unknown control-plane slug renders not-found and is read-only (no journal fallback)', async () => {
  const store = openJournalStore({ dbPath: ':memory:' });
  // A JOURNAL topic with this slug exists, but topic docs are
  // CONTROL-PLANE-ONLY now, so the journal row is intentionally NOT consulted.
  store.createTopic({
    slug: 'legacy-topic',
    title: 'Legacy Topic',
    body: 'journal body text',
  });

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
  const body = Buffer.from(await provider.readFile(uri)).toString('utf8');

  // Control-plane-only: an unknown slug renders "not found", NOT the journal doc.
  expect(body).toContain('# Document not found');
  expect(body).not.toContain('journal body text');
  expect(getDocument).toHaveBeenCalledWith({
    slug: 'legacy-topic',
    kind: 'Topic',
  });

  // A not-found doc is read-only (there is nothing to save).
  const stat = await provider.stat(uri);
  expect(stat.permissions).toBe(1 /* vscode.FilePermission.Readonly */);

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

test('workstream doc: unknown control-plane slug renders not-found (no journal fallback)', async () => {
  const store = openJournalStore({ dbPath: ':memory:' });
  // Journal workstream with this slug exists, but workstream docs are
  // CONTROL-PLANE-ONLY now, so the journal row is not consulted.
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

  // Control-plane-only: unknown slug → "not found", NOT the journal doc.
  expect(body).toContain('# Document not found');
  expect(body).not.toContain('# Journal WS');
  expect(getDocument).toHaveBeenCalledWith({
    slug: 'legacy-ws',
    kind: 'Workstream',
  });

  const stat = await provider.stat(uri);
  expect(stat.permissions).toBe(1 /* vscode.FilePermission.Readonly */);

  store.close();
});

test('topic-type doc: resolves control-plane-first and renders the TopicType doc (writable)', async () => {
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

  // A control-plane-resolved topic-type doc is now WRITABLE — its label /
  // description / body-template save via ws-topictype-update.
  const stat = await provider.stat(uri);
  expect(stat.permissions).toBeUndefined();

  store.close();
});

test('topic-type doc: control-plane save routes edits to ws-topictype-update', async () => {
  const store = openJournalStore({ dbPath: ':memory:' });

  const topicTypeRead = vi.fn(async (input: { slug?: string }) =>
    input.slug === 'cp-tt'
      ? [{ id: 'tt-1', slug: 'cp-tt' } as unknown]
      : [],
  );
  const getDocument = vi.fn(async (input: { slug?: string; kind?: string }) =>
    input.slug === 'cp-tt' && input.kind === 'TopicType'
      ? { available: true, document: makeTopicTypeEnvelope('tt-1', 'cp-tt') }
      : { available: true, document: null },
  );
  const topicTypeUpdate = vi.fn(async () => ({ id: 'tt-1', slug: 'cp-tt' }));

  const { WorkstreamDocumentProvider } = await import('../src/contentProvider');
  const provider = new WorkstreamDocumentProvider(store);
  provider.setControlPlaneClient({
    getDocument,
    topicTypeRead,
    topicTypeUpdate,
    topicRead: vi.fn(async () => []),
  } as unknown as ControlPlaneClient);

  const readUri = makeUri('/topic-type/cp-tt.md') as Parameters<
    typeof provider.readFile
  >[0];
  const original = Buffer.from(await provider.readFile(readUri)).toString(
    'utf8',
  );
  // makeTopicTypeEnvelope: label 'CP TopicType', description 'control-plane type desc'.
  const edited = original.replace(
    'control-plane type desc',
    'edited type desc',
  );

  const writeUri = makeUri('/topic-type/cp-tt.md') as Parameters<
    typeof provider.writeFile
  >[0];
  await provider.writeFile(writeUri, Buffer.from(edited, 'utf8'), {
    create: false,
    overwrite: true,
  });

  expect(topicTypeUpdate).toHaveBeenCalledWith({
    slug: 'cp-tt',
    label: 'CP TopicType',
    description: 'edited type desc',
    body_template: '',
  });

  store.close();
});

test('topic-type doc: unknown control-plane slug renders not-found and is read-only (no journal fallback)', async () => {
  const store = openJournalStore({ dbPath: ':memory:' });
  // Journal topic-type with this id exists, but topic-type docs are
  // CONTROL-PLANE-ONLY now, so the journal row is not consulted.
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

  // Control-plane-only: unknown slug → "not found", NOT the journal doc.
  expect(body).toContain('# Document not found');
  expect(body).not.toContain('# Journal Label');
  expect(getDocument).toHaveBeenCalledWith({
    slug: 'legacy-tt',
    kind: 'TopicType',
  });

  const stat = await provider.stat(uri);
  expect(stat.permissions).toBe(1 /* vscode.FilePermission.Readonly */);

  store.close();
});

// --- Bug 1: id-or-slug resolution -----------------------------------------
// A topic's `spec.workstreams` can hold a slugless workstream's UUID (written
// there by topic↔workstream attach when the panel opened it via
// `/document/<uuid>`). The topic-doc link is then `open/workstream/<uuid>`, so
// the by-slug lookup misses. Resolution must fall back to a by-id lookup rather
// than rendering the "# Workstream not found" journal fallback.
test('workstream doc: by-slug miss falls back to a by-id lookup and renders the doc', async () => {
  const store = openJournalStore({ dbPath: ':memory:' });

  const wsUuid = 'ws-uuid-42';
  const getDocument = vi.fn(
    async (input: { id?: string; slug?: string; kind?: string }) => {
      // Slug lookup misses (the identifier is a uuid, not a live slug)…
      if (input.slug === wsUuid) {
        return { available: true, document: null };
      }
      // …but the by-id retry resolves the workstream document.
      if (input.id === wsUuid && input.kind === 'Workstream') {
        return {
          available: true,
          document: makeWorkstreamEnvelope(wsUuid, wsUuid),
        };
      }
      return { available: true, document: null };
    },
  );

  const { WorkstreamDocumentProvider } = await import('../src/contentProvider');
  const provider = new WorkstreamDocumentProvider(store);
  provider.setControlPlaneClient({
    getDocument,
  } as unknown as ControlPlaneClient);

  const uri = makeUri(`/workstream/${wsUuid}.md`) as Parameters<
    typeof provider.readFile
  >[0];
  const body = Buffer.from(await provider.readFile(uri)).toString('utf8');

  // The control-plane doc renders — NOT the "# Workstream not found" fallback.
  expect(body).toContain('# Workstream: CP Workstream');
  expect(body).not.toContain('Workstream not found');
  // Both lookups were attempted: first by slug, then by id.
  expect(getDocument).toHaveBeenCalledWith({ slug: wsUuid, kind: 'Workstream' });
  expect(getDocument).toHaveBeenCalledWith({ id: wsUuid, kind: 'Workstream' });

  store.close();
});

// --- Bug 2: topic doc Alerts section --------------------------------------
function makeAlert(id: string, topics: string[], status: Alert['status']): Alert {
  return {
    id,
    slug: null,
    title: `Alert ${id}`,
    description: 'something needs attention',
    recommended_action: 'do the thing',
    status,
    dedupe_key: null,
    created_by: 'system',
    topics,
    created_at: 1_700_000_000,
    updated_at: 1_700_000_000,
    resourceVersion: 1,
  };
}

test('topic doc: renders rich per-status alert cards (incl. closed) with action pills', async () => {
  const store = openJournalStore({ dbPath: ':memory:' });

  const getDocument = vi.fn(async (input: { slug?: string; kind?: string }) =>
    input.slug === 'cp-topic' && input.kind === 'Topic'
      ? { available: true, document: makeEnvelope('doc-1', 'cp-topic') }
      : { available: true, document: null },
  );
  const alertRead = vi.fn(async () => [
    makeAlert('alert-1', ['cp-topic', 'other-topic'], 'alert'),
    makeAlert('info-1', ['cp-topic'], 'informational'),
    makeAlert('closed-1', ['cp-topic'], 'closed'), // closed → NOW included
    makeAlert('alert-other', ['different-topic'], 'alert'), // other topic → excluded
  ]);

  const { WorkstreamDocumentProvider } = await import('../src/contentProvider');
  const provider = new WorkstreamDocumentProvider(store);
  provider.setControlPlaneClient({
    getDocument,
    alertRead,
  } as unknown as ControlPlaneClient);

  const uri = makeUri('/topic/cp-topic.md') as Parameters<
    typeof provider.readFile
  >[0];
  const body = Buffer.from(await provider.readFile(uri)).toString('utf8');

  expect(body).toContain('## Alerts');
  // Bold title deep-linked by id (rich header, not a bare bullet).
  expect(body).toContain(
    '**[Alert alert-1](vscode://kubarycz.working-memory/open/alert/alert-1)**',
  );
  // Detail lines: description + recommended action are now exposed.
  expect(body).toContain('something needs attention');
  expect(body).toContain('Next: do the thing');
  // Other topics line (the current topic is filtered out).
  expect(body).toContain(
    'Other topics: [other-topic](vscode://kubarycz.working-memory/open/topic/other-topic)',
  );

  // `alert` status → Acknowledge · Close.
  expect(body).toContain(
    '[Acknowledge](vscode://kubarycz.working-memory/alert/alert-1/acknowledge)',
  );
  expect(body).toContain(
    '[Close](vscode://kubarycz.working-memory/alert/alert-1/close)',
  );
  // `informational` status → Escalate · Close.
  expect(body).toContain(
    '[Escalate](vscode://kubarycz.working-memory/alert/info-1/reopen)',
  );
  expect(body).toContain(
    '[Close](vscode://kubarycz.working-memory/alert/info-1/close)',
  );
  // `closed` status → Reopen (Alert) · Reopen (Information); the closed alert is
  // now INCLUDED so its Reopen pills render.
  expect(body).toContain('closed-1');
  expect(body).toContain(
    '[Reopen (Alert)](vscode://kubarycz.working-memory/alert/closed-1/reopen)',
  );
  expect(body).toContain(
    '[Reopen (Information)](vscode://kubarycz.working-memory/alert/closed-1/acknowledge)',
  );

  // The alert on a different topic is still excluded.
  expect(body).not.toContain('alert-other');

  store.close();
});

test('topic doc: renders NO `## Alerts` section when there are no matching alerts', async () => {
  const store = openJournalStore({ dbPath: ':memory:' });

  const getDocument = vi.fn(async (input: { slug?: string; kind?: string }) =>
    input.slug === 'cp-topic' && input.kind === 'Topic'
      ? { available: true, document: makeEnvelope('doc-1', 'cp-topic') }
      : { available: true, document: null },
  );
  const alertRead = vi.fn(async () => [
    makeAlert('alert-other', ['different-topic'], 'alert'),
  ]);

  const { WorkstreamDocumentProvider } = await import('../src/contentProvider');
  const provider = new WorkstreamDocumentProvider(store);
  provider.setControlPlaneClient({
    getDocument,
    alertRead,
  } as unknown as ControlPlaneClient);

  const uri = makeUri('/topic/cp-topic.md') as Parameters<
    typeof provider.readFile
  >[0];
  const body = Buffer.from(await provider.readFile(uri)).toString('utf8');

  expect(body).toContain('# Topic: CP Topic');
  expect(body).not.toContain('## Alerts');

  store.close();
});

// --- Field parity: workstream `## Topics` section -------------------------
// A workstream's member topics are a reverse relation (a Topic's
// `spec.workstreams` lists the workstream slugs it belongs to). The provider
// resolves them via `topicRead` and passes them into the pure renderer.
function makeTopicWith(overrides: Partial<Topic>): Topic {
  return {
    id: 'topic-id',
    slug: 'a-topic',
    title: 'A Topic',
    body: '',
    status: 'open',
    topicType: 'topic',
    parents: [],
    workstreams: [],
    created_at: 1_700_000_000,
    updated_at: 1_700_000_500,
    resourceVersion: 1,
    ...overrides,
  };
}

test('workstream doc: renders a `## Topics` section with member topics and excludes non-members', async () => {
  const store = openJournalStore({ dbPath: ':memory:' });

  const getDocument = vi.fn(async (input: { slug?: string; kind?: string }) =>
    input.slug === 'cp-ws' && input.kind === 'Workstream'
      ? { available: true, document: makeWorkstreamEnvelope('ws-1', 'cp-ws') }
      : { available: true, document: null },
  );
  const topicRead = vi.fn(async () => [
    makeTopicWith({
      slug: 'member-open',
      title: 'Member Open',
      workstreams: ['cp-ws'],
    }),
    makeTopicWith({
      slug: 'member-closed',
      title: 'Member Closed',
      status: 'closed',
      workstreams: ['cp-ws'],
    }),
    makeTopicWith({
      slug: 'not-a-member',
      title: 'Not A Member',
      workstreams: ['other-ws'],
    }),
  ]);

  const { WorkstreamDocumentProvider } = await import('../src/contentProvider');
  const provider = new WorkstreamDocumentProvider(store);
  provider.setControlPlaneClient({
    getDocument,
    topicRead,
  } as unknown as ControlPlaneClient);

  const uri = makeUri('/workstream/cp-ws.md') as Parameters<
    typeof provider.readFile
  >[0];
  const body = Buffer.from(await provider.readFile(uri)).toString('utf8');

  expect(body).toContain('## Topics');
  expect(body).toContain(
    '[Member Open](vscode://kubarycz.working-memory/open/topic/member-open) `member-open`',
  );
  // A non-'open' member gets its status appended.
  expect(body).toContain(
    '[Member Closed](vscode://kubarycz.working-memory/open/topic/member-closed) `member-closed` — _closed_',
  );
  // A topic that isn't a member of this workstream is excluded.
  expect(body).not.toContain('not-a-member');

  store.close();
});

test('workstream doc: renders NO `## Topics` section when there are no member topics', async () => {
  const store = openJournalStore({ dbPath: ':memory:' });

  const getDocument = vi.fn(async (input: { slug?: string; kind?: string }) =>
    input.slug === 'cp-ws' && input.kind === 'Workstream'
      ? { available: true, document: makeWorkstreamEnvelope('ws-1', 'cp-ws') }
      : { available: true, document: null },
  );
  // Only a foreign-workstream topic exists → no members for cp-ws.
  const topicRead = vi.fn(async () => [
    makeTopicWith({ slug: 'foreign', workstreams: ['other-ws'] }),
  ]);

  const { WorkstreamDocumentProvider } = await import('../src/contentProvider');
  const provider = new WorkstreamDocumentProvider(store);
  provider.setControlPlaneClient({
    getDocument,
    topicRead,
  } as unknown as ControlPlaneClient);

  const uri = makeUri('/workstream/cp-ws.md') as Parameters<
    typeof provider.readFile
  >[0];
  const body = Buffer.from(await provider.readFile(uri)).toString('utf8');

  expect(body).toContain('# Workstream: CP Workstream');
  expect(body).not.toContain('## Topics');

  store.close();
});

// --- Field parity: topic-type id in heading, count, `## Recent topics` ----
test('topic-type doc: renders id in heading, usage count, and `## Recent topics`', async () => {
  const store = openJournalStore({ dbPath: ':memory:' });

  const getDocument = vi.fn(async (input: { slug?: string; kind?: string }) =>
    input.slug === 'cp-tt' && input.kind === 'TopicType'
      ? { available: true, document: makeTopicTypeEnvelope('tt-1', 'cp-tt') }
      : { available: true, document: null },
  );
  const topicRead = vi.fn(async () => [
    makeTopicWith({ slug: 'of-type-open', title: 'Of Type Open', topicType: 'cp-tt' }),
    makeTopicWith({
      slug: 'of-type-closed',
      title: 'Of Type Closed',
      status: 'closed',
      topicType: 'cp-tt',
    }),
    makeTopicWith({ slug: 'other-type', title: 'Other Type', topicType: 'feature' }),
  ]);

  const { WorkstreamDocumentProvider } = await import('../src/contentProvider');
  const provider = new WorkstreamDocumentProvider(store);
  provider.setControlPlaneClient({
    getDocument,
    topicRead,
  } as unknown as ControlPlaneClient);

  const uri = makeUri('/topic-type/cp-tt.md') as Parameters<
    typeof provider.readFile
  >[0];
  const body = Buffer.from(await provider.readFile(uri)).toString('utf8');

  // Heading includes the topic-type id.
  expect(body).toContain('# TopicType: CP TopicType `cp-tt`');
  // Usage count reflects ALL topics of this type (open + closed), not other types.
  expect(body).toContain('`topics using this type`: 2');
  // Recent topics lists the OPEN topic of this type.
  expect(body).toContain('## Recent topics');
  expect(body).toContain(
    '[Of Type Open](vscode://kubarycz.working-memory/open/topic/of-type-open) `of-type-open`',
  );
  // Closed topic of this type and topics of a different type are excluded.
  expect(body).not.toContain('of-type-closed');
  expect(body).not.toContain('other-type');

  store.close();
});

// --- Field parity: topic doc linkifies the topic type ---------------------
test('topic doc: renders the topic type as a deep-link', async () => {
  const store = openJournalStore({ dbPath: ':memory:' });

  const envelope = makeEnvelope('doc-1', 'cp-topic');
  envelope.spec = { ...envelope.spec, topicType: 'feature' };
  const getDocument = vi.fn(async (input: { slug?: string; kind?: string }) =>
    input.slug === 'cp-topic' && input.kind === 'Topic'
      ? { available: true, document: envelope }
      : { available: true, document: null },
  );
  const alertRead = vi.fn(async () => [] as Alert[]);

  const { WorkstreamDocumentProvider } = await import('../src/contentProvider');
  const provider = new WorkstreamDocumentProvider(store);
  provider.setControlPlaneClient({
    getDocument,
    alertRead,
  } as unknown as ControlPlaneClient);

  const uri = makeUri('/topic/cp-topic.md') as Parameters<
    typeof provider.readFile
  >[0];
  const body = Buffer.from(await provider.readFile(uri)).toString('utf8');

  expect(body).toContain(
    '`topicType`: [feature](vscode://kubarycz.working-memory/open/topic-type/feature)',
  );

  store.close();
});

// --- Field parity: topic doc `## Family` tree + friendly workstream links --
// The topic doc resolves its family neighborhood (ancestors via the injected
// topics' `parents`, descendants via the reverse parent lookup) and its
// workstream titles, and passes them into the pure renderer.
test('topic doc: renders a `## Family` tree and friendly workstream links', async () => {
  const store = openJournalStore({ dbPath: ':memory:' });

  const envelope = makeEnvelope('doc-current', 'cp-topic');
  envelope.spec = {
    ...envelope.spec,
    title: 'CP Topic',
    parents: ['parent-slug'],
    workstreams: ['ws-a'],
  };
  const getDocument = vi.fn(async (input: { slug?: string; kind?: string }) =>
    input.slug === 'cp-topic' && input.kind === 'Topic'
      ? { available: true, document: envelope }
      : { available: true, document: null },
  );
  const alertRead = vi.fn(async () => [] as Alert[]);
  const topicRead = vi.fn(async () => [
    makeTopicWith({
      slug: 'cp-topic',
      title: 'CP Topic',
      parents: ['parent-slug'],
      workstreams: ['ws-a'],
    }),
    makeTopicWith({ slug: 'parent-slug', title: 'Parent Topic', parents: [] }),
    makeTopicWith({
      slug: 'child-slug',
      title: 'Child Topic',
      parents: ['cp-topic'],
    }),
  ]);
  const wsRead = vi.fn(async () => [
    { id: 'ws-1', slug: 'ws-a', title: 'Workstream A' },
  ]);

  const { WorkstreamDocumentProvider } = await import('../src/contentProvider');
  const provider = new WorkstreamDocumentProvider(store);
  provider.setControlPlaneClient({
    getDocument,
    alertRead,
    topicRead,
    wsRead,
  } as unknown as ControlPlaneClient);

  const uri = makeUri('/topic/cp-topic.md') as Parameters<
    typeof provider.readFile
  >[0];
  const body = Buffer.from(await provider.readFile(uri)).toString('utf8');

  // The flat `## Parents` section is replaced by a `## Family` tree.
  expect(body).not.toContain('## Parents');
  expect(body).toContain('## Family');
  // Ancestor → current → descendant, indented 2 spaces per level, friendly.
  expect(body).toContain(
    '- [Parent Topic](vscode://kubarycz.working-memory/open/topic/parent-slug)',
  );
  expect(body).toContain('  - **CP Topic** ← this topic');
  expect(body).toContain(
    '    - [Child Topic](vscode://kubarycz.working-memory/open/topic/child-slug)',
  );
  // Workstream link uses the resolved friendly title, not the slug.
  expect(body).toContain(
    '[Workstream A](vscode://kubarycz.working-memory/open/workstream/ws-a)',
  );

  store.close();
});

// --- Alert docs resolve control-plane-first --------------------------------
// A topic doc's `## Alerts` section links `open/alert/<id>`, where `<id>` is a
// control-plane alert's uuid/slug — NOT a journal numeric id. Opening
// `/alert/<id>.md` must resolve CONTROL-PLANE-FIRST and render the alert body,
// not the journal renderer's "alert not found" (which parses `<id>` as a
// numeric journal id).
function makeAlertEnvelope(id: string, slug: string | null): DocumentEnvelope {
  return {
    kind: 'Alert',
    metadata: {
      id,
      slug,
      labels: {},
      createdAt: 1_700_000_000,
      updatedAt: 1_700_000_000,
      deletedAt: null,
      resourceVersion: 1,
    },
    spec: {
      title: 'CP Alert',
      status: 'alert',
      description: 'something needs attention',
      recommended_action: 'do the thing',
      created_by: 'system',
      topics: ['cp-topic'],
    },
    status: {},
  };
}

test('alert doc: resolves control-plane-first and renders the Alert doc (read-only)', async () => {
  const store = openJournalStore({ dbPath: ':memory:' });

  const getDocument = vi.fn(async (input: { slug?: string; kind?: string }) =>
    input.slug === 'cp-alert' && input.kind === 'Alert'
      ? { available: true, document: makeAlertEnvelope('alert-1', 'cp-alert') }
      : { available: true, document: null },
  );

  const { WorkstreamDocumentProvider } = await import('../src/contentProvider');
  const provider = new WorkstreamDocumentProvider(store);
  provider.setControlPlaneClient({
    getDocument,
  } as unknown as ControlPlaneClient);

  const uri = makeUri('/alert/cp-alert.md') as Parameters<
    typeof provider.readFile
  >[0];
  const body = Buffer.from(await provider.readFile(uri)).toString('utf8');

  // Body is the control-plane Alert renderer, NOT the journal "alert not found".
  expect(body).toContain('# Alert: CP Alert');
  expect(body).toContain('something needs attention');
  expect(body).not.toContain('not found');
  expect(getDocument).toHaveBeenCalledWith({ slug: 'cp-alert', kind: 'Alert' });

  // A control-plane-resolved alert doc is READ-ONLY (save is deferred).
  const stat = await provider.stat(uri);
  expect(stat.permissions).toBe(1 /* vscode.FilePermission.Readonly */);

  store.close();
});

test('alert doc: by-slug miss falls back to a by-id lookup and renders the doc', async () => {
  const store = openJournalStore({ dbPath: ':memory:' });

  const alertUuid = 'alert-uuid-7';
  const getDocument = vi.fn(
    async (input: { id?: string; slug?: string; kind?: string }) => {
      // Slug lookup misses (the identifier is a uuid, not a live slug)…
      if (input.slug === alertUuid) {
        return { available: true, document: null };
      }
      // …but the by-id retry resolves the alert document.
      if (input.id === alertUuid && input.kind === 'Alert') {
        return {
          available: true,
          document: makeAlertEnvelope(alertUuid, null),
        };
      }
      return { available: true, document: null };
    },
  );

  const { WorkstreamDocumentProvider } = await import('../src/contentProvider');
  const provider = new WorkstreamDocumentProvider(store);
  provider.setControlPlaneClient({
    getDocument,
  } as unknown as ControlPlaneClient);

  const uri = makeUri(`/alert/${alertUuid}.md`) as Parameters<
    typeof provider.readFile
  >[0];
  const body = Buffer.from(await provider.readFile(uri)).toString('utf8');

  // The control-plane doc renders — NOT the journal "alert not found" fallback.
  expect(body).toContain('# Alert: CP Alert');
  expect(body).not.toContain('not found');
  // Both lookups were attempted: first by slug, then by id.
  expect(getDocument).toHaveBeenCalledWith({ slug: alertUuid, kind: 'Alert' });
  expect(getDocument).toHaveBeenCalledWith({ id: alertUuid, kind: 'Alert' });

  store.close();
});
