/**
 * Tests for the topic-type label editable-region feature:
 *   - contentProvider writeFile: modified label persists via updateTopicType
 *   - contentProvider writeFile: empty label rejected, updateTopicType not called
 *   - contentProvider writeFile: combined label + body_template save
 */

import { test, expect, vi } from 'vitest';
import { renderTopicTypeDocument } from '../src/documentRenderers/topictype';
import type {
  ControlPlaneClient,
  DocumentEnvelope,
} from '../src/controlPlaneClient';

// ---------------------------------------------------------------------------
// Mock vscode — full shape needed for WorkstreamDocumentProvider
// ---------------------------------------------------------------------------
const mockShowErrorMessage = vi.fn<(msg: string) => void>();

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
    window: { showErrorMessage: mockShowErrorMessage },
  };
});

// ---------------------------------------------------------------------------
// Helper to create a mock URI for the working-memory scheme
// ---------------------------------------------------------------------------
function makeUri(path: string): unknown {
  return { path, toString: () => `working-memory:${path}` };
}

// A control-plane TopicType envelope for slug `task`, rendered via the per-kind
// document renderer (the same editable markers the extractors parse).
function makeTypeEnvelope(spec: {
  label: string;
  description: string;
  body_template: string;
}): DocumentEnvelope {
  return {
    kind: 'TopicType',
    metadata: {
      id: 'task-id',
      slug: 'task',
      labels: {},
      createdAt: 1,
      updatedAt: 2,
      deletedAt: null,
      resourceVersion: 1,
    },
    spec: { icon: 'tag', ...spec },
    status: {},
  };
}

// A control-plane client whose `ws-topictype-read` reports `task` exists and
// whose `ws-topictype-update` is the spy under test.
function makeClient(
  spec: { label: string; description: string; body_template: string },
  topicTypeUpdate: ReturnType<typeof vi.fn>,
): ControlPlaneClient {
  return {
    topicTypeRead: vi.fn(async (i: { slug?: string }) =>
      i.slug === 'task'
        ? [
            {
              id: 'task-id',
              slug: 'task',
              icon: 'tag',
              created_at: 1,
              updated_at: 2,
              resourceVersion: 1,
              ...spec,
            },
          ]
        : [],
    ),
    topicTypeUpdate,
  } as unknown as ControlPlaneClient;
}

// ---------------------------------------------------------------------------
// contentProvider writeFile tests
// ---------------------------------------------------------------------------

test('contentProvider: writeFile with modified label calls updateTopicType with new label', async () => {
  const spec = { label: 'Task', description: 'a task', body_template: '' };
  const doc = renderTopicTypeDocument(makeTypeEnvelope(spec));
  const modifiedDoc = doc.replace(
    /<!-- editable:label -->\n\nTask\n/,
    '<!-- editable:label -->\n\nUpdated Task Label\n',
  );

  const topicTypeUpdate = vi.fn(async () => ({}));
  const { WorkstreamDocumentProvider } = await import('../src/contentProvider');
  const provider = new WorkstreamDocumentProvider(null);
  provider.setControlPlaneClient(makeClient(spec, topicTypeUpdate));

  const uri = makeUri('/topic-type/task.md') as Parameters<typeof provider.writeFile>[0];
  await provider.writeFile(uri, Buffer.from(modifiedDoc), { create: false, overwrite: true });

  expect(topicTypeUpdate).toHaveBeenCalledWith({
    slug: 'task',
    label: 'Updated Task Label',
    description: 'a task',
    body_template: '',
  });
});

test('contentProvider: writeFile with empty label shows error and does not update label', async () => {
  mockShowErrorMessage.mockClear();
  const spec = { label: 'Task', description: 'a task', body_template: '' };
  const doc = renderTopicTypeDocument(makeTypeEnvelope(spec));
  // Replace label content with whitespace
  const modifiedDoc = doc.replace(
    /<!-- editable:label -->\n\nTask\n/,
    '<!-- editable:label -->\n\n   \n',
  );

  const topicTypeUpdate = vi.fn(async () => ({}));
  const { WorkstreamDocumentProvider } = await import('../src/contentProvider');
  const provider = new WorkstreamDocumentProvider(null);
  provider.setControlPlaneClient(makeClient(spec, topicTypeUpdate));

  const uri = makeUri('/topic-type/task.md') as Parameters<typeof provider.writeFile>[0];
  await provider.writeFile(uri, Buffer.from(modifiedDoc), { create: false, overwrite: true });

  // No control-plane update, and an error surfaced.
  expect(topicTypeUpdate).not.toHaveBeenCalled();
  expect(mockShowErrorMessage).toHaveBeenCalledOnce();
  expect(mockShowErrorMessage.mock.calls[0][0]).toMatch(/label must not be empty/i);
});

test('contentProvider: writeFile persists both label and body_template in a single save', async () => {
  const spec = { label: 'Task', description: 'a task', body_template: '' };
  const doc = renderTopicTypeDocument(makeTypeEnvelope(spec));
  const withNewLabel = doc.replace(
    /<!-- editable:label -->\n\nTask\n/,
    '<!-- editable:label -->\n\nRenamed Task\n',
  );
  // body_template region currently contains placeholder; replace with real content
  const newTemplate = '## Steps\nDo the thing.';
  const withBoth = withNewLabel.replace(
    '_No body template — add one here, then save (⌘S)._',
    newTemplate,
  );

  const topicTypeUpdate = vi.fn(async () => ({}));
  const { WorkstreamDocumentProvider } = await import('../src/contentProvider');
  const provider = new WorkstreamDocumentProvider(null);
  provider.setControlPlaneClient(makeClient(spec, topicTypeUpdate));

  const uri = makeUri('/topic-type/task.md') as Parameters<typeof provider.writeFile>[0];
  await provider.writeFile(uri, Buffer.from(withBoth), { create: false, overwrite: true });

  expect(topicTypeUpdate).toHaveBeenCalledWith({
    slug: 'task',
    label: 'Renamed Task',
    description: 'a task',
    body_template: newTemplate,
  });
});

test('contentProvider: writeFile with modified description persists new description', async () => {
  const spec = { label: 'Task', description: 'a task', body_template: '' };
  const doc = renderTopicTypeDocument(makeTypeEnvelope(spec));
  const modifiedDoc = doc.replace(
    /<!-- editable:description -->\n\na task\n/,
    '<!-- editable:description -->\n\nUpdated description text.\n',
  );

  const topicTypeUpdate = vi.fn(async () => ({}));
  const { WorkstreamDocumentProvider } = await import('../src/contentProvider');
  const provider = new WorkstreamDocumentProvider(null);
  provider.setControlPlaneClient(makeClient(spec, topicTypeUpdate));

  const uri = makeUri('/topic-type/task.md') as Parameters<typeof provider.writeFile>[0];
  await provider.writeFile(uri, Buffer.from(modifiedDoc), { create: false, overwrite: true });

  expect(topicTypeUpdate).toHaveBeenCalledWith({
    slug: 'task',
    label: 'Task',
    description: 'Updated description text.',
    body_template: '',
  });
});

test('contentProvider: writeFile with empty description shows error and does not update description', async () => {
  mockShowErrorMessage.mockClear();
  const spec = { label: 'Task', description: 'a task', body_template: '' };
  const doc = renderTopicTypeDocument(makeTypeEnvelope(spec));
  const modifiedDoc = doc.replace(
    /<!-- editable:description -->\n\na task\n/,
    '<!-- editable:description -->\n\n   \n',
  );

  const topicTypeUpdate = vi.fn(async () => ({}));
  const { WorkstreamDocumentProvider } = await import('../src/contentProvider');
  const provider = new WorkstreamDocumentProvider(null);
  provider.setControlPlaneClient(makeClient(spec, topicTypeUpdate));

  const uri = makeUri('/topic-type/task.md') as Parameters<typeof provider.writeFile>[0];
  await provider.writeFile(uri, Buffer.from(modifiedDoc), { create: false, overwrite: true });

  expect(topicTypeUpdate).not.toHaveBeenCalled();
  expect(mockShowErrorMessage).toHaveBeenCalledOnce();
  expect(mockShowErrorMessage.mock.calls[0][0]).toMatch(/description must not be empty/i);
});
