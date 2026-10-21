import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { openStore, type Store } from '../src/store';
import { startServer, type RunningServer } from '../src/server';
import { loadKinds } from '../src/kinds/loader';
import { ControlPlaneClient } from '../../shared/controlPlaneClient';
import { parseDocumentChanges, type DocumentChanges } from '../../shared/documentChanges';

let store: Store;
let server: RunningServer | undefined;
const clients: ControlPlaneClient[] = [];

beforeAll(async () => { await loadKinds(); });
afterEach(async () => {
  vi.unstubAllGlobals();
  await Promise.all(clients.splice(0).map((client) => client.dispose()));
  await server?.close();
  server = undefined;
  store?.close();
});

describe('committed document changes', () => {
  it('suppresses unchanged client heartbeats and reports a legacy backend explicitly', async () => {
    store = openStore(':memory:');
    const reader = new ControlPlaneClient({ resolveUrl: () => 'http://127.0.0.1:7717/mcp' });
    clients.push(reader);
    const controller = new AbortController();
    const changed = vi.fn();
    let requests = 0;
    vi.stubGlobal('fetch', vi.fn(async () => {
      requests += 1;
      if (requests === 4) {
        controller.abort();
        throw new DOMException('Aborted', 'AbortError');
      }
      return new Response(JSON.stringify({ resourceVersion: 8, reset: requests === 1, changes: [] }));
    }));
    await expect(reader.watchDocumentChanges(changed, controller.signal)).rejects.toThrow('Aborted');
    expect(changed).toHaveBeenCalledTimes(1);
    vi.stubGlobal('fetch', vi.fn(async () => new Response('', { status: 404 })));
    await expect(reader.watchDocumentChanges(changed, new AbortController().signal))
      .rejects.toThrow('upgrading the selected Working Memory data-tier instance');
  });

  it('emits create, atomic update, delete and restore only after commit', () => {
    store = openStore(':memory:');
    const changed = vi.fn();
    const stop = store.onDocumentsChanged(changed);
    const first = store.createDocument({ kind: 'Topic', spec: { title: 'First' } });
    const second = store.createDocument({ kind: 'Topic', spec: { title: 'Second' } });
    changed.mockClear();
    expect(() => store.updateDocuments([
      { id: first.metadata.id, expectedResourceVersion: first.metadata.resourceVersion, spec: { title: 'Changed' } },
      { id: second.metadata.id, expectedResourceVersion: 999, spec: {} },
    ])).toThrow('Conflict');
    expect(changed).not.toHaveBeenCalled();
    expect(store.getResourceVersion()).toBe(second.metadata.resourceVersion);
    expect(store.getDocument({ id: first.metadata.id })?.spec.title).toBe('First');
    const batch = store.updateDocuments([first, second].map((doc) => ({
      id: doc.metadata.id, expectedResourceVersion: doc.metadata.resourceVersion, spec: { title: 'Updated' },
    })));
    expect(changed).toHaveBeenCalledTimes(1);
    expect(changed.mock.calls[0][0]).toHaveLength(2);
    expect(store.getDocument({ id: first.metadata.id })?.spec.title).toBe('Updated');
    const deleted = store.deleteDocument({ id: first.metadata.id });
    expect(changed.mock.calls.at(-1)?.[0][0]).toMatchObject({ deleted: true, resourceVersion: deleted.metadata.resourceVersion });
    store.restoreDocument({ id: first.metadata.id });
    expect(changed.mock.calls.at(-1)?.[0][0]).toMatchObject({ deleted: false });
    stop();
    const count = changed.mock.calls.length;
    store.updateDocument({ id: second.metadata.id, expectedResourceVersion: batch[1].metadata.resourceVersion, spec: {} });
    expect(changed).toHaveBeenCalledTimes(count);
  });

  it('waits without reading documents until a commit, then returns only change metadata', async () => {
    store = openStore(':memory:');
    server = await startServer({ port: 0, store });
    const initial = parseDocumentChanges(await (await fetch(`${server.url}/changes`)).json());
    expect(initial).toEqual({ resourceVersion: 0, reset: true, changes: [] });
    const read = vi.spyOn(store, 'listDocuments');
    let settled = false;
    const waiting = fetch(`${server.url}/changes?since=0`).then(async (response) => {
      settled = true;
      return parseDocumentChanges(await response.json());
    });
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(settled).toBe(false);
    expect(read).not.toHaveBeenCalled();
    const doc = store.createDocument({ kind: 'Topic', spec: { title: 'Private body' } });
    expect(await waiting).toEqual({
      resourceVersion: doc.metadata.resourceVersion,
      reset: false,
      changes: [{
        id: doc.metadata.id, kind: 'Topic',
        resourceVersion: doc.metadata.resourceVersion, deleted: false,
      }],
    });
    expect(read).not.toHaveBeenCalled();
  });

  it('replays missed changes and resets cursors outside bounded history', async () => {
    store = openStore(':memory:');
    server = await startServer({ port: 0, store });
    for (let index = 0; index < 260; index += 1) store.createDocument({ kind: 'Topic' });
    const missed = parseDocumentChanges(await (await fetch(`${server.url}/changes?since=258`)).json());
    expect(missed.reset).toBe(false);
    expect(missed.changes.map((change) => change.resourceVersion)).toEqual([259, 260]);
    for (const since of [0, 999]) {
      expect(parseDocumentChanges(await (await fetch(`${server.url}/changes?since=${since}`)).json()))
        .toEqual({ resourceVersion: 260, reset: true, changes: [] });
    }
    expect((await fetch(`${server.url}/changes?since=bad`)).status).toBe(400);
  });

  it('delivers external MCP writes to a watching client and aborts on disposal', async () => {
    store = openStore(':memory:');
    store.createDocument({ kind: 'TopicType', spec: { label: 'Topic' } });
    server = await startServer({ port: 0, store });
    const writer = new ControlPlaneClient({ resolveUrl: () => `${server!.url}/mcp` });
    const reader = new ControlPlaneClient({ resolveUrl: () => `${server!.url}/mcp` });
    clients.push(writer, reader);
    const changes: DocumentChanges[] = [];
    const controller = new AbortController();
    const watching = reader.watchDocumentChanges((change) => changes.push(change), controller.signal);
    const stopped = watching.catch((error) => { if (error.name !== 'AbortError') throw error; });
    await vi.waitFor(() => expect(changes).toHaveLength(1));
    const created = await writer.topicCreate({ title: 'External change' });
    await vi.waitFor(() => expect(changes.some((notice) =>
      notice.changes.some((change) => change.id === created.id && change.kind === 'Topic'))).toBe(true));
    await reader.dispose();
    await stopped;
  });
});
