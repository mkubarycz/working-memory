/**
 * Tests for the eager FileSystemProvider registration / startup-race hardening:
 *   - stat() and readFile() return gracefully when store is null (no throw)
 *   - updateStore() wires in the real store; subsequent reads return live content
 */

import { test, expect, vi } from 'vitest';
import { openJournalStore } from '../src/db';

// ---------------------------------------------------------------------------
// Mock vscode — same shape used by topicTypeLabel.test.ts
// ---------------------------------------------------------------------------
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

// ---------------------------------------------------------------------------
// Helper to create a mock URI for the working-memory scheme
// ---------------------------------------------------------------------------
function makeUri(path: string): unknown {
  return { path, toString: () => `working-memory:${path}` };
}

// ---------------------------------------------------------------------------
// Null-store graceful behaviour tests
// ---------------------------------------------------------------------------

test('stat() returns a valid FileStat with null store (no throw)', async () => {
  const { WorkstreamDocumentProvider } = await import('../src/contentProvider');
  const provider = new WorkstreamDocumentProvider(null);

  const uri = makeUri('/topic/some-topic.md') as Parameters<typeof provider.stat>[0];
  // Must not throw even when the DB isn't ready yet.
  const stat = provider.stat(uri);

  expect(stat.type).toBe(1 /* FileType.File */);
  expect(typeof stat.size).toBe('number');
  expect(stat.size).toBeGreaterThan(0);
});

test('readFile() returns placeholder content with null store (no throw)', async () => {
  const { WorkstreamDocumentProvider } = await import('../src/contentProvider');
  const provider = new WorkstreamDocumentProvider(null);

  const uri = makeUri('/topic/some-topic.md') as Parameters<typeof provider.readFile>[0];
  const bytes = provider.readFile(uri);

  const text = Buffer.from(bytes).toString('utf8');
  expect(text).toContain('Working Memory DB not available');
});

test('readFile() for unknown-kind URI throws FileNotFound regardless of store', async () => {
  const { WorkstreamDocumentProvider } = await import('../src/contentProvider');
  const provider = new WorkstreamDocumentProvider(null);

  const uri = makeUri('/bad-path') as Parameters<typeof provider.readFile>[0];
  expect(() => provider.readFile(uri)).toThrow(/FileNotFound/);
});

// ---------------------------------------------------------------------------
// updateStore() tests
// ---------------------------------------------------------------------------

test('updateStore() transitions provider from null to live store', async () => {
  const store = openJournalStore({ dbPath: ':memory:' });
  store.createWorkstream({ slug: 'ws-fsp', title: 'FSP WS', status: 'open' });

  const { WorkstreamDocumentProvider } = await import('../src/contentProvider');
  const provider = new WorkstreamDocumentProvider(null);

  // Before updateStore: placeholder content
  const uriBefore = makeUri('/workstream/ws-fsp.md') as Parameters<typeof provider.readFile>[0];
  const before = Buffer.from(provider.readFile(uriBefore)).toString('utf8');
  expect(before).toContain('Working Memory DB not available');

  // Wire in the real store
  provider.updateStore(store);

  // After updateStore: live DB content
  const uriAfter = makeUri('/workstream/ws-fsp.md') as Parameters<typeof provider.readFile>[0];
  const after = Buffer.from(provider.readFile(uriAfter)).toString('utf8');
  expect(after).toContain('FSP WS');
  expect(after).not.toContain('Working Memory DB not available');

  store.close();
});

test('updateStore(null) makes provider return placeholder again', async () => {
  const store = openJournalStore({ dbPath: ':memory:' });
  store.createWorkstream({ slug: 'ws-fsp2', title: 'FSP WS 2', status: 'open' });

  const { WorkstreamDocumentProvider } = await import('../src/contentProvider');
  const provider = new WorkstreamDocumentProvider(store);

  // Starts with live content
  const uri = makeUri('/workstream/ws-fsp2.md') as Parameters<typeof provider.readFile>[0];
  const live = Buffer.from(provider.readFile(uri)).toString('utf8');
  expect(live).toContain('FSP WS 2');

  // Revert to null (simulates DB close / workspace removed)
  provider.updateStore(null);

  const placeholder = Buffer.from(provider.readFile(uri)).toString('utf8');
  expect(placeholder).toContain('Working Memory DB not available');

  store.close();
});
