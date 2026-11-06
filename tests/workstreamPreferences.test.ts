import { beforeAll, expect, it } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadKinds } from '../control-plane/src/kinds/loader';
import { openStore } from '../control-plane/src/store';
import { ControlPlaneClient, startServer } from './authenticatedFixture';
import { buildWorkstreamPanels } from '../shared/panelData';
import { loadWorkstreamViewModel } from '../shared/viewModels/workstreamViewModel';

beforeAll(async () => { await loadKinds(); });

it('persists workstream preferences through the typed API and consistently filters every workstream tree', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'workstream-preferences-'));
  const filename = join(directory, 'store.sqlite');
  try {
    const store = openStore(filename);
    const server = await startServer({ port: 0, store });
    const client = new ControlPlaneClient({ resolveUrl: () => `${server.url}/mcp` });
    let inboxId = '';
    try {
      const inbox = await client.wsCreate({ title: 'Inbox', status: 'backlog' });
      inboxId = inbox.id;
      expect(inbox).toMatchObject({ pinned: true, includeClosedTopics: true, status: 'backlog' });
      const normal = await client.wsCreate({ title: 'Normal', status: 'progress' });
      expect(normal).toMatchObject({ pinned: false, includeClosedTopics: true });
      const pinned = await client.wsCreate({ title: 'Pinned', pinned: true, includeClosedTopics: false });
      const type = await client.topicTypeCreate({ label: 'Test', icon: 'symbol-key', description: 'Test topics' });
      const membership = [inbox.id, normal.id, pinned.id];
      const parent = await client.topicCreate({
        title: 'Closed parent', status: 'closed', topicType: type.id, workstreams: membership,
      });
      const child = await client.topicCreate({
        title: 'Open child', parents: [parent.id], topicType: type.id, workstreams: membership,
      });
      const grandchild = await client.topicCreate({
        title: 'Closed grandchild', status: 'closed', parents: [child.id], topicType: type.id, workstreams: membership,
      });
      await client.topicCreate({
        title: 'Open great-grandchild', parents: [grandchild.id], topicType: type.id, workstreams: membership,
      });
      await client.wsUpdate({ id: inbox.id, includeClosedTopics: false });
      const workstreams = await client.wsRead();
      const topics = await client.topicRead();
      const panels = buildWorkstreamPanels({ available: true, workstreams, topics });
      expect(panels.active.pinnedWorkstreams?.map(card => card.id)).toEqual([inbox.id, pinned.id]);
      const normalCard = panels.active.items.flatMap(item => item.kind === 'workstream-section' ? item.workstreams : [])[0];
      expect(normalCard.id).toBe(normal.id);
      expect(normalCard.children[0].children[0].label).toBe('Closed parent');
      expect(panels.active.topicBacklog).toEqual([]);
      for (const id of [inbox.id, pinned.id]) {
        const card = panels.active.pinnedWorkstreams!.find(item => item.id === id)!;
        const document = await loadWorkstreamViewModel(client, id);
        expect(card.children[0].children.map(node => node.label).sort()).toEqual(['Open child', 'Open great-grandchild']);
        expect(document?.tree[0].children.map(node => node.label).sort()).toEqual(['Open child', 'Open great-grandchild']);
        expect(document?.topics.map(topic => topic.title)).toEqual(['Open child', 'Open great-grandchild']);
      }
      await client.wsUpdate({ id: normal.id, status: 'closed', includeClosedTopics: false });
      const archived = buildWorkstreamPanels({ available: true, workstreams: await client.wsRead(), topics }).archive.items[0];
      expect(archived.kind === 'workstream' && archived.children[0].children.map(node => node.label).sort())
        .toEqual(['Open child', 'Open great-grandchild']);
      await client.wsUpdate({ id: pinned.id, pinned: false });
      expect((await client.wsRead({ id: pinned.id }))[0].pinned).toBe(false);
      expect((await client.topicRead()).map(topic => ({ id: topic.id, status: topic.status, workstreams: topic.workstreams })))
        .toEqual(topics.map(topic => ({ id: topic.id, status: topic.status, workstreams: topic.workstreams })));
    } finally {
      await client.dispose();
      await server.close();
      store.close();
    }
    const reopened = openStore(filename);
    try {
      expect(reopened.getDocument({ id: inboxId })?.spec).toMatchObject({
        title: 'Inbox', status: 'backlog', includeClosedTopics: false,
      });
    } finally { reopened.close(); }
  } finally { await rm(directory, { recursive: true, force: true }); }
});
