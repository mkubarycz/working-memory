import { describe, expect, it, vi } from 'vitest';
import type { DesktopApi } from '../src/shared/contracts';
import type { DocumentVM, TopicCreateDraftVM } from '../src/renderer/documents/types';
import { createTopicFromDraft } from '../src/renderer/topicCreation';
import { ControlPlaneClient } from '../../shared/controlPlaneClient';
import { loadKinds } from '../../control-plane/src/kinds/loader';
import { startServer } from '../../control-plane/src/server';
import { openStore } from '../../control-plane/src/store';
import { loadActivePanelData, loadTopicViewModel } from '../src/main/resolver';
import { moveTopicToNewWorkstream } from '../src/renderer/topicTransfer';

function draft(): TopicCreateDraftVM {
  return {
    kind: 'topic-create', id: 'draft-id',
    title: 'Improve installer testing', body: 'Keep this authored description.', topicType: 'feature',
    topicTypes: [], workstream: '', workstreamTitle: '', newWorkstreamTitle: 'Release improvements',
    parent: null, parentTitle: null,
  };
}

function mockApi() {
  const document: DocumentVM = {
    kind: 'topic', id: 'installer-testing', title: 'Improve installer testing', body: 'Saved',
    status: 'open', topicType: 'feature', typeMeta: null, createdAt: 1, updatedAt: 1,
    resourceVersion: 1, editable: true, parents: [], children: [], workstreams: [],
    focusedWorkstreams: [], agentMessages: [],
  };
  return {
    createWorkstream: vi.fn<DesktopApi['createWorkstream']>()
      .mockResolvedValue({ id: 'release-improvements', title: 'Release improvements' }),
    createTopic: vi.fn<DesktopApi['createTopic']>().mockResolvedValue(document),
  };
}

describe('creating a workstream with its first topic', () => {
  it('creates the workstream before saving the topic with its authored fields', async () => {
    const api = mockApi();
    const value = draft();
    const result = await createTopicFromDraft(value, api);
    expect(result.kind).toBe('topic');
    expect(api.createWorkstream).toHaveBeenCalledExactlyOnceWith('Release improvements');
    expect(api.createTopic).toHaveBeenCalledExactlyOnceWith({
      title: value.title, body: value.body, topicType: 'feature', workstream: 'release-improvements',
    });
    expect(api.createWorkstream.mock.invocationCallOrder[0]).toBeLessThan(api.createTopic.mock.invocationCallOrder[0]!);
    expect(value.workstream).toBe('release-improvements');
    expect(value.body).toBe('Keep this authored description.');
  });

  it('retains the created workstream and draft when a topic save fails, then reuses it on retry', async () => {
    const api = mockApi();
    api.createTopic.mockRejectedValueOnce(new Error('Backend unavailable'));
    const value = draft();
    await expect(createTopicFromDraft(value, api)).rejects.toThrow(
      'Workstream "Release improvements" was created, but its first topic could not be saved.',
    );
    expect(value.workstream).toBe('release-improvements');
    expect(value.title).toBe('Improve installer testing');
    expect(value.body).toBe('Keep this authored description.');
    await createTopicFromDraft(value, api);
    expect(api.createWorkstream).toHaveBeenCalledTimes(1);
    expect(api.createTopic).toHaveBeenCalledTimes(2);
    expect(api.createTopic.mock.calls[1]?.[0].workstream).toBe('release-improvements');
  });

  it('does not create a topic when the workstream cannot be created', async () => {
    const api = mockApi();
    api.createWorkstream.mockRejectedValueOnce(new Error('Backend unavailable'));
    const value = draft();
    await expect(createTopicFromDraft(value, api)).rejects.toThrow('Backend unavailable');
    expect(value.workstream).toBe('');
    expect(api.createTopic).not.toHaveBeenCalled();
  });

  it('leaves ordinary topic and child creation unchanged', async () => {
    const api = mockApi();
    const value = draft();
    delete value.newWorkstreamTitle;
    value.workstream = 'existing-workstream';
    value.parent = 'parent-topic';
    await createTopicFromDraft(value, api);
    expect(api.createWorkstream).not.toHaveBeenCalled();
    expect(api.createTopic).toHaveBeenCalledExactlyOnceWith({
      title: value.title, body: value.body, topicType: 'feature',
      workstream: 'existing-workstream', parent: 'parent-topic',
    });
  });

  it('persists creation and moving topic trees through MCP without changing their statuses', async () => {
    await loadKinds();
    const store = openStore(':memory:');
    const server = await startServer({ port: 0, store });
    const client = new ControlPlaneClient({ resolveUrl: () => `${server.url}/mcp` });
    try {
      const type = await client.topicTypeCreate({ label: 'Feature', icon: 'lightbulb', description: 'New functionality',
      });
      const value = draft();
      value.topicType = type.id;
      const api: Pick<DesktopApi, 'createWorkstream' | 'createTopic'> = {
        createWorkstream: async (title) => {
          const workstream = await client.wsCreate({ title, status: 'progress' });
          if (!workstream.id) throw new Error('Missing workstream id');
          return { id: workstream.id, title: workstream.title };
        },
        createTopic: async (input) => {
          const topic = await client.topicCreate({
            title: input.title, body: input.body, topicType: input.topicType,
            workstreams: [input.workstream], parents: input.parent ? [input.parent] : [],
          });
          const document = await loadTopicViewModel(client, topic.id ?? topic.id);
          if (!document) throw new Error('Missing saved topic');
          return document;
        },
      };
      const created = await createTopicFromDraft(value, api);
      expect(created.kind).toBe('topic');
      if (created.kind !== 'topic') throw new Error('Expected saved topic');
      expect(created.body).toBe(value.body);
      expect(created.workstreams.map(({ id }) => id)).toEqual([value.workstream]);
      const panel = await loadActivePanelData(client);
      const progress = panel.items.find((item) => item.kind === 'workstream-section' && item.section === 'progress');
      expect(progress?.kind === 'workstream-section' && progress.workstreams.map(({ id }) => id))
        .toEqual([value.workstream]);
      const topics = await client.topicRead({ workstream: value.workstream });
      expect(topics).toHaveLength(1);
      expect(topics[0]?.title).toBe(value.title);
      expect(topics[0]?.status).toBe('open');
      if (!created.id) throw new Error('Missing topic id');
      const other = await api.createWorkstream('Shared');
      await client.topicUpdate({ id: created.id, workstreams: [value.workstream, other.id] });
      await client.topicCreate({
        title: 'Child topic', body: 'Keep the child content', topicType: type.id,
        workstreams: [value.workstream], parents: [created.id],
      });
      const move = {
        id: created.id, sourceWorkstream: value.workstream,
        title: 'Release followup', targetWorkstream: '',
      };
      await moveTopicToNewWorkstream(move, api, async (request) => { await client.topicTransfer(request); });
      const moved = await client.topicRead({ workstream: move.targetWorkstream });
      expect(moved.map(({ title }) => title).sort()).toEqual(['Child topic', value.title].sort());
      expect(moved.every(({ status }) => status === 'open')).toBe(true);
      expect(await client.topicRead({ workstream: value.workstream })).toHaveLength(0);
      expect(await client.topicRead({ workstream: other.id })).toHaveLength(1);
      expect((await client.topicRead({ id: created.id }))[0]?.body).toBe(value.body);
    } finally {
      await client.dispose();
      await server.close();
      store.close();
    }
  });
});
