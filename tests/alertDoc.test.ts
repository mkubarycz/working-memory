/**
 * Tests for the alert virtual-doc editing round-trip (render → edit → parse →
 * persist), mirroring tests/topicTypeLabel.test.ts:
 *   - writeFile: modified status/description/action persist via updateAlert
 *   - writeFile: empty description rejected, alert unchanged
 *   - writeFile: invalid status rejected, alert unchanged
 */

import { test, expect, vi } from 'vitest';
import { openJournalStore } from '../src/db';
import { AlertsStore } from '../src/alerts/store';
import { renderAlertDoc, renderTopicDoc } from '../src/virtualFileRenderer';

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

function makeUri(path: string): unknown {
  return { path, toString: () => `working-memory:${path}` };
}

function freshAlert() {
  const store = openJournalStore({ dbPath: ':memory:' });
  store.createTopic({ slug: 'topic-a' });
  const alerts = new AlertsStore(store.connection);
  const { alert } = alerts.createAlert({
    description: 'Disk almost full',
    recommended_action: 'Free up space',
    topic_slugs: ['topic-a'],
    created_by: 'tester',
  });
  return { store, alerts, id: alert.id };
}

test('alert doc: editing status/description/action persists via updateAlert', async () => {
  const { store, alerts, id } = freshAlert();
  const { WorkstreamDocumentProvider } = await import('../src/contentProvider');
  const provider = new WorkstreamDocumentProvider(store);

  const doc = renderAlertDoc(store, String(id))
    .replace(
      '<!-- editable:description -->\n\nDisk almost full\n',
      '<!-- editable:description -->\n\nDisk completely full\n',
    )
    .replace('Free up space', 'Delete old logs')
    .replace(
      '<!-- editable:status -->\n\nalert\n',
      '<!-- editable:status -->\n\ninformational\n',
    );

  const uri = makeUri(`/alert/${id}.md`) as Parameters<typeof provider.writeFile>[0];
  provider.writeFile(uri, Buffer.from(doc), { create: false, overwrite: true });

  const updated = alerts.getAlert(id);
  expect(updated?.description).toBe('Disk completely full');
  expect(updated?.recommended_action).toBe('Delete old logs');
  expect(updated?.status).toBe('informational');
  store.close();
});

test('alert doc: empty description rejected, alert unchanged', async () => {
  mockShowErrorMessage.mockClear();
  const { store, alerts, id } = freshAlert();
  const { WorkstreamDocumentProvider } = await import('../src/contentProvider');
  const provider = new WorkstreamDocumentProvider(store);

  const doc = renderAlertDoc(store, String(id)).replace(
    '<!-- editable:description -->\n\nDisk almost full\n',
    '<!-- editable:description -->\n\n   \n',
  );
  const uri = makeUri(`/alert/${id}.md`) as Parameters<typeof provider.writeFile>[0];
  provider.writeFile(uri, Buffer.from(doc), { create: false, overwrite: true });

  expect(alerts.getAlert(id)?.description).toBe('Disk almost full');
  expect(mockShowErrorMessage).toHaveBeenCalledOnce();
  expect(mockShowErrorMessage.mock.calls[0][0]).toMatch(/description must not be empty/i);
  store.close();
});

test('alert doc: invalid status rejected, alert unchanged', async () => {
  mockShowErrorMessage.mockClear();
  const { store, alerts, id } = freshAlert();
  const { WorkstreamDocumentProvider } = await import('../src/contentProvider');
  const provider = new WorkstreamDocumentProvider(store);

  const doc = renderAlertDoc(store, String(id)).replace(
    '<!-- editable:status -->\n\nalert\n',
    '<!-- editable:status -->\n\nbogus\n',
  );
  const uri = makeUri(`/alert/${id}.md`) as Parameters<typeof provider.writeFile>[0];
  provider.writeFile(uri, Buffer.from(doc), { create: false, overwrite: true });

  expect(alerts.getAlert(id)?.status).toBe('alert');
  expect(mockShowErrorMessage).toHaveBeenCalledOnce();
  expect(mockShowErrorMessage.mock.calls[0][0]).toMatch(/status must be one of/i);
  store.close();
});

test('alert doc: title is the H1 and edits persist via updateAlert', async () => {
  const { store, alerts, id } = freshAlert();
  const { WorkstreamDocumentProvider } = await import('../src/contentProvider');
  const provider = new WorkstreamDocumentProvider(store);

  // Default title derives from the description, and is rendered as the H1.
  const rendered = renderAlertDoc(store, String(id));
  expect(rendered).toContain('# Disk almost full');

  const doc = rendered.replace(
    '<!-- editable:label -->\n\nDisk almost full\n',
    '<!-- editable:label -->\n\nDisk crisis\n',
  );
  const uri = makeUri(`/alert/${id}.md`) as Parameters<typeof provider.writeFile>[0];
  provider.writeFile(uri, Buffer.from(doc), { create: false, overwrite: true });

  expect(alerts.getAlert(id)?.title).toBe('Disk crisis');
  expect(renderAlertDoc(store, String(id))).toContain('# Disk crisis');
  store.close();
});

test('alert doc: empty title falls back to Alert #<id> in the H1', async () => {
  const { store, alerts, id } = freshAlert();
  alerts.updateAlert(id, { title: '' });
  expect(renderAlertDoc(store, String(id))).toContain(`# Alert #${id}`);
  store.close();
});

test('topic doc: alert status=alert shows Acknowledge + Close deep links', () => {
  const { store, id } = freshAlert();
  const doc = renderTopicDoc(store, 'topic-a');
  expect(doc).toContain(`vscode://kubarycz.working-memory/alert/${id}/acknowledge`);
  expect(doc).toContain(`vscode://kubarycz.working-memory/alert/${id}/close`);
  expect(doc).not.toContain('command:working-memory.alert');
  store.close();
});

test('topic doc: informational alert shows Escalate + Close, hides Acknowledge', () => {
  const { store, alerts, id } = freshAlert();
  alerts.updateAlert(id, { status: 'informational' });
  const doc = renderTopicDoc(store, 'topic-a');
  expect(doc).not.toContain(`/alert/${id}/acknowledge`);
  expect(doc).toContain(`[Escalate](vscode://kubarycz.working-memory/alert/${id}/reopen)`);
  expect(doc).toContain(`vscode://kubarycz.working-memory/alert/${id}/close`);
  store.close();
});

test('topic doc: closed alert shows Reopen (Alert) + Reopen (Information), no Acknowledge/Close', () => {
  const { store, alerts, id } = freshAlert();
  alerts.updateAlert(id, { status: 'closed' });
  const doc = renderTopicDoc(store, 'topic-a');
  expect(doc).not.toContain('[Acknowledge]');
  expect(doc).not.toContain('[Close]');
  expect(doc).toContain(`[Reopen (Alert)](vscode://kubarycz.working-memory/alert/${id}/reopen)`);
  expect(doc).toContain(`[Reopen (Information)](vscode://kubarycz.working-memory/alert/${id}/acknowledge)`);
  store.close();
});

test('alert doc: closed alert renders Reopen (Alert) + Reopen (Information)', () => {
  const { store, alerts, id } = freshAlert();
  alerts.updateAlert(id, { status: 'closed' });
  const doc = renderAlertDoc(store, String(id));
  expect(doc).toContain(`[Reopen (Alert)](vscode://kubarycz.working-memory/alert/${id}/reopen)`);
  expect(doc).toContain(`[Reopen (Information)](vscode://kubarycz.working-memory/alert/${id}/acknowledge)`);
  store.close();
});

test('alert doc: open alert has no Reopen buttons', () => {
  const { store, id } = freshAlert();
  const doc = renderAlertDoc(store, String(id));
  expect(doc).not.toContain('Reopen (Alert)');
  expect(doc).not.toContain('Reopen (Information)');
  store.close();
});

test('alert doc: informational alert renders Escalate + Close', () => {
  const { store, alerts, id } = freshAlert();
  alerts.updateAlert(id, { status: 'informational' });
  const doc = renderAlertDoc(store, String(id));
  expect(doc).toContain(`[Escalate](vscode://kubarycz.working-memory/alert/${id}/reopen)`);
  expect(doc).toContain(`[Close](vscode://kubarycz.working-memory/alert/${id}/close)`);
  store.close();
});

test('topic doc: alert renders as plain markdown with colored bell, title link, no card divs', () => {
  const { store, id } = freshAlert();
  const doc = renderTopicDoc(store, 'topic-a');
  // Plain-markdown render: colored bell codicon via inline style, bold title
  // linked to the alert deeplink, description + Next line, action links.
  expect(doc).toContain('codicon-bell');
  expect(doc).toContain('color:#f14c4c');
  expect(doc).toContain(`**[Disk almost full](vscode://kubarycz.working-memory/open/alert/${id})**`);
  expect(doc).toContain('Next: Free up space');
  // No HTML card wrapper divs / CSS classes.
  expect(doc).not.toContain('wm-alert');
  store.close();
});

