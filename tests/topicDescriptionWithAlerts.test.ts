/**
 * Regression: editing the topic Description must persist ONLY the description.
 * Before the fix, the Alerts callout sat inside the two `---` body fences, so
 * extractTopicBody grabbed the alerts HTML and overwrote the description with
 * it. The body is now strictly fenced by the editable:description markers,
 * outside the Alerts block.
 */

import { test, expect, vi } from 'vitest';
import { renderTopicDocument } from '../src/documentRenderers/topic';
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
    window: { showErrorMessage: vi.fn() },
  };
});

function makeUri(path: string): unknown {
  return { path, toString: () => `working-memory:${path}` };
}

test('topic doc: editing description with alerts present persists only description', async () => {
  // A control-plane topic with an alert that concerns it. The `## Alerts`
  // section renders OUTSIDE the editable:description markers, so extractTopicBody
  // must grab only the body — not the alerts HTML.
  const env: DocumentEnvelope = {
    kind: 'Topic',
    metadata: {
      id: 'topic-a-id',
      slug: 'topic-a',
      labels: {},
      createdAt: 1,
      updatedAt: 2,
      deletedAt: null,
      resourceVersion: 1,
    },
    spec: {
      title: 'Topic A',
      body: 'original body',
      status: 'open',
      topicType: 'topic',
      workstreams: [],
      parents: [],
    },
    status: {},
  };
  const alert = {
    id: 'alert-1',
    slug: null,
    status: 'alert',
    title: 'Disk almost full',
    description: 'Disk almost full',
    recommended_action: 'Free up space',
    topics: ['topic-a'],
    created_at: 1,
    updated_at: 2,
    resourceVersion: 1,
  } as unknown as Alert;

  const doc = renderTopicDocument(env, [alert]).replace(
    '<!-- editable:description -->\noriginal body\n<!-- /editable:description -->',
    '<!-- editable:description -->\nedited body\n<!-- /editable:description -->',
  );
  // sanity: the alerts callout HTML is present in the rendered doc
  expect(doc).toContain('Disk almost full');

  const topic = {
    id: 'topic-a-id',
    slug: 'topic-a',
    title: 'Topic A',
    body: 'original body',
    status: 'open',
    topicType: 'topic',
    parents: [],
    workstreams: [],
    focusedWorkstreams: [],
    created_at: 1,
    updated_at: 2,
    resourceVersion: 1,
  } as unknown as Topic;
  const topicUpdate = vi.fn(async () => topic);
  const client = {
    topicRead: vi.fn(async (i: { slug?: string }) =>
      i.slug === 'topic-a' ? [topic] : [],
    ),
    topicUpdate,
    alertRead: vi.fn(async () => [alert]),
  } as unknown as ControlPlaneClient;

  const { WorkstreamDocumentProvider } = await import('../src/contentProvider');
  const provider = new WorkstreamDocumentProvider(null);
  provider.setControlPlaneClient(client);

  const uri = makeUri('/topic/topic-a.md') as Parameters<typeof provider.writeFile>[0];
  await provider.writeFile(uri, Buffer.from(doc), { create: false, overwrite: true });

  // Only the body was extracted + saved — NOT the alerts HTML.
  expect(topicUpdate).toHaveBeenCalledWith({ slug: 'topic-a', body: 'edited body' });
});
