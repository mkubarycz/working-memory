/**
 * Tests for the topic-type label editable-region feature:
 *   - contentProvider writeFile: modified label persists via updateTopicType
 *   - contentProvider writeFile: empty label rejected, updateTopicType not called
 *   - contentProvider writeFile: combined label + body_template save
 */

import { test, expect, vi } from 'vitest';
import { openJournalStore } from '../src/db';
import { renderTopicTypeDoc } from '../src/virtualFileRenderer';

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

// ---------------------------------------------------------------------------
// contentProvider writeFile tests
// ---------------------------------------------------------------------------

test('contentProvider: writeFile with modified label calls updateTopicType with new label', async () => {
  const store = openJournalStore({ dbPath: ':memory:' });
  const { WorkstreamDocumentProvider } = await import('../src/contentProvider');
  const provider = new WorkstreamDocumentProvider(store);

  // Render the current doc for 'task', then edit the label region
  const originalDoc = renderTopicTypeDoc(store, 'task');
  const modifiedDoc = originalDoc.replace(
    /<!-- editable:label -->\n\nTask\n/,
    '<!-- editable:label -->\n\nUpdated Task Label\n',
  );

  const uri = makeUri('/topic-type/task.md') as Parameters<typeof provider.writeFile>[0];
  provider.writeFile(uri, Buffer.from(modifiedDoc), { create: false, overwrite: true });

  const updated = store.getTopicType('task');
  expect(updated?.label).toBe('Updated Task Label');
  store.close();
});

test('contentProvider: writeFile with empty label shows error and does not update label', async () => {
  mockShowErrorMessage.mockClear();
  const store = openJournalStore({ dbPath: ':memory:' });
  const { WorkstreamDocumentProvider } = await import('../src/contentProvider');
  const provider = new WorkstreamDocumentProvider(store);

  const originalDoc = renderTopicTypeDoc(store, 'task');
  // Replace label content with whitespace
  const modifiedDoc = originalDoc.replace(
    /<!-- editable:label -->\n\nTask\n/,
    '<!-- editable:label -->\n\n   \n',
  );

  const uri = makeUri('/topic-type/task.md') as Parameters<typeof provider.writeFile>[0];
  provider.writeFile(uri, Buffer.from(modifiedDoc), { create: false, overwrite: true });

  // DB label should be unchanged
  const unchanged = store.getTopicType('task');
  expect(unchanged?.label).toBe('Task');

  // Error should have been surfaced
  expect(mockShowErrorMessage).toHaveBeenCalledOnce();
  expect(mockShowErrorMessage.mock.calls[0][0]).toMatch(/label must not be empty/i);
  store.close();
});

test('contentProvider: writeFile persists both label and body_template in a single save', async () => {
  const store = openJournalStore({ dbPath: ':memory:' });
  const { WorkstreamDocumentProvider } = await import('../src/contentProvider');
  const provider = new WorkstreamDocumentProvider(store);

  // Start from a freshly rendered doc and mutate both editable regions
  const originalDoc = renderTopicTypeDoc(store, 'task');
  const withNewLabel = originalDoc.replace(
    /<!-- editable:label -->\n\nTask\n/,
    '<!-- editable:label -->\n\nRenamed Task\n',
  );
  // body_template region currently contains placeholder; replace with real content
  const newTemplate = '## Steps\nDo the thing.';
  const withBoth = withNewLabel.replace(
    '_No body template — add one here, then save (⌘S)._',
    newTemplate,
  );

  const uri = makeUri('/topic-type/task.md') as Parameters<typeof provider.writeFile>[0];
  provider.writeFile(uri, Buffer.from(withBoth), { create: false, overwrite: true });

  const updated = store.getTopicType('task');
  expect(updated?.label).toBe('Renamed Task');
  expect(updated?.body_template).toBe(newTemplate);
  store.close();
});

test('contentProvider: writeFile with modified description persists new description', async () => {
  const store = openJournalStore({ dbPath: ':memory:' });
  const { WorkstreamDocumentProvider } = await import('../src/contentProvider');
  const provider = new WorkstreamDocumentProvider(store);

  const originalDoc = renderTopicTypeDoc(store, 'task');
  const existingDescription = store.getTopicType('task')!.description;
  const modifiedDoc = originalDoc.replace(
    `<!-- editable:description -->\n\n${existingDescription}\n`,
    '<!-- editable:description -->\n\nUpdated description text.\n',
  );

  const uri = makeUri('/topic-type/task.md') as Parameters<typeof provider.writeFile>[0];
  provider.writeFile(uri, Buffer.from(modifiedDoc), { create: false, overwrite: true });

  const updated = store.getTopicType('task');
  expect(updated?.description).toBe('Updated description text.');
  store.close();
});

test('contentProvider: writeFile with empty description shows error and does not update description', async () => {
  mockShowErrorMessage.mockClear();
  const store = openJournalStore({ dbPath: ':memory:' });
  const { WorkstreamDocumentProvider } = await import('../src/contentProvider');
  const provider = new WorkstreamDocumentProvider(store);

  const originalDoc = renderTopicTypeDoc(store, 'task');
  const existingDescription = store.getTopicType('task')!.description;
  const modifiedDoc = originalDoc.replace(
    `<!-- editable:description -->\n\n${existingDescription}\n`,
    '<!-- editable:description -->\n\n   \n',
  );

  const uri = makeUri('/topic-type/task.md') as Parameters<typeof provider.writeFile>[0];
  provider.writeFile(uri, Buffer.from(modifiedDoc), { create: false, overwrite: true });

  const unchanged = store.getTopicType('task');
  expect(unchanged?.description).toBe(existingDescription);

  expect(mockShowErrorMessage).toHaveBeenCalledOnce();
  expect(mockShowErrorMessage.mock.calls[0][0]).toMatch(/description must not be empty/i);
  store.close();
});
