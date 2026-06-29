/**
 * Regression: editing the topic Description must persist ONLY the description.
 * Before the fix, the Alerts callout sat inside the two `---` body fences, so
 * extractTopicBody grabbed the alerts HTML and overwrote the description with
 * it. The body is now strictly fenced by the editable:description markers,
 * outside the Alerts block.
 */

import { test, expect, vi } from 'vitest';
import { openJournalStore } from '../src/db';
import { AlertsStore } from '../src/alerts/store';
import { renderTopicDoc } from '../src/virtualFileRenderer';

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
  const store = openJournalStore({ dbPath: ':memory:' });
  store.createTopic({ slug: 'topic-a', body: 'original body' });
  const alerts = new AlertsStore(store.connection);
  alerts.createAlert({
    description: 'Disk almost full',
    recommended_action: 'Free up space',
    topic_slugs: ['topic-a'],
    created_by: 'tester',
  });

  const { WorkstreamDocumentProvider } = await import('../src/contentProvider');
  const provider = new WorkstreamDocumentProvider(store);

  const doc = renderTopicDoc(store, 'topic-a').replace(
    '<!-- editable:description -->\noriginal body\n<!-- /editable:description -->',
    '<!-- editable:description -->\nedited body\n<!-- /editable:description -->',
  );
  // sanity: the alerts callout HTML is present in the rendered doc
  expect(doc).toContain('Disk almost full');

  const uri = makeUri('/topic/topic-a.md') as Parameters<typeof provider.writeFile>[0];
  provider.writeFile(uri, Buffer.from(doc), { create: false, overwrite: true });

  const topic = store.getTopic('topic-a');
  expect(topic?.body).toBe('edited body');
  // alert untouched
  expect(alerts.topicAlertsWithRecentClosed('topic-a')).toHaveLength(1);
  store.close();
});
