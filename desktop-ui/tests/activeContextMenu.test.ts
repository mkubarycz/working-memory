import { describe, expect, it } from 'vitest';
import {
  activeContextMenuItems,
  invokeActiveAction,
  topicIdFromOpenUri,
} from '../src/renderer/activeContextMenu';
import type { WorkstreamVM } from '../src/renderer/documents/types';
import { openStore } from '../../control-plane/src/store';
import { startServer } from '../../tests/authenticatedFixture';
import { loadKinds } from '../../control-plane/src/kinds/loader';
import { ControlPlaneClient } from '../../tests/authenticatedFixture';
import { loadActivePanelData, loadWorkstreamViewModel, resolveDesktopAction } from '../src/main/resolver';

function reactiveProxy<T extends object>(value: T, cache = new WeakMap<object, object>()): T {
  const existing = cache.get(value);
  if (existing) return existing as T;
  const proxy = new Proxy(value, {
    get(target, property, receiver) {
      const nested = Reflect.get(target, property, receiver) as unknown;
      return nested !== null && typeof nested === 'object'
        ? reactiveProxy(nested as object, cache)
        : nested;
    },
  });
  cache.set(value, proxy);
  return proxy;
}

describe('Active rail context-menu projection', () => {
  it('preserves existing panel actions and their enabled state', () => {
    const actions = [
      { command: 'working-memory.move', title: 'Move', icon: 'arrow-circle-up' },
      { command: 'working-memory.blocked', title: 'Blocked', enabled: false },
    ];

    const items = activeContextMenuItems(actions);

    expect(items).toEqual([
      { kind: 'action', title: 'Move', icon: 'arrow-circle-up', enabled: true, action: actions[0] },
      { kind: 'action', title: 'Blocked', icon: 'arrow-swap', enabled: false, action: actions[1] },
    ]);
  });

  it('projects context-sensitive focus actions without inventing a command', () => {
    expect(activeContextMenuItems([], {
      topic: 'topic-one',
      focused: false,
      sourceWorkstream: 'source',
      moveTargets: [
        { id: 'source', title: 'Source' },
        { id: 'target', title: 'Target' },
      ],
    })).toEqual([
      { kind: 'create-child', title: 'Add Child...', icon: 'add', enabled: true, topic: 'topic-one' },
      { kind: 'focus', title: 'Add to Focus', icon: 'pin', enabled: true, topic: 'topic-one' },
      {
        kind: 'move',
        title: 'Move to...',
        icon: 'arrow-swap',
        enabled: true,
        topic: 'topic-one',
        targets: [{ id: 'target', title: 'Target' }],
      },
    ]);
    expect(activeContextMenuItems([], {
      topic: 'topic-one',
      focused: true,
      sourceWorkstream: 'source',
      moveTargets: [],
    })[1]).toMatchObject({
      title: 'Remove from Focus',
      icon: 'pinned',
    });
  });

  it('keeps Move to available for creating a new workstream when no other target exists', () => {
    expect(activeContextMenuItems([], {
      topic: 'topic-one',
      focused: false,
      sourceWorkstream: 'source',
      moveTargets: [{ id: 'source', title: 'Source' }],
    })[2]).toMatchObject({
      kind: 'move',
      enabled: true,
      targets: [],
    });
  });

  it('disables Move to when the topic or source is unavailable', () => {
    for (const source of [
      { topic: '', sourceWorkstream: 'source' },
      { topic: 'topic-one', sourceWorkstream: '' },
    ]) {
      expect(activeContextMenuItems([], { ...source, focused: false, moveTargets: [] })[2])
        .toMatchObject({ kind: 'move', enabled: false });
    }
  });

  it('extracts and decodes the topic id from a panel URI', () => {
    expect(topicIdFromOpenUri('working-memory:/topic/design%20notes.working-memory')).toBe('design notes');
    expect(topicIdFromOpenUri('not a uri')).toBe('');
  });

  it('omits the redundant Add to workstream action while retaining move and removal', () => {
    const items = activeContextMenuItems([
      { command: 'workingMemory.topic.addToWorkstream', title: 'Add to workstream' },
      { command: 'workingMemory.topic.removeFromWorkstream', title: 'Remove from workstream' },
    ], { topic: 'topic-one', focused: false, sourceWorkstream: 'source', moveTargets: [] });
    expect(items.map(({ title }) => title)).toEqual([
      'Add Child...', 'Add to Focus', 'Move to...', 'Remove from workstream',
    ]);
  });

  it('projects Queue action proxies before the bridge and accepts a cloneable result', async () => {
    const action = reactiveProxy({
      command: 'working-memory.setWorkstreamSection',
      title: 'Send to In Progress',
      args: [{ id: 'queued-item', section: 'progress' }],
    });
    const returned: WorkstreamVM = {
      kind: 'workstream',
      title: 'Queued item',
      id: 'queued-item',
      status: 'progress',
      createdAt: 0,
      updatedAt: 1,
      closure: null,
      resourceVersion: 2,
      editable: true,
      topics: [],
      tree: [],
      agentMessages: [],
    };
    let invocation: { channel: string; args: unknown[] } | undefined;
    const ipcRenderer = {
      invoke: async (channel: string, ...args: unknown[]) => {
        invocation = { channel, args };
        return structuredClone(returned);
      },
    };
    const invokeAction = (workstream: string, command: string, args: unknown[]) =>
      ipcRenderer.invoke('action:invoke', workstream, command, args) as Promise<WorkstreamVM>;

    expect(() => structuredClone(action.args)).toThrow();
    const incoming = await invokeActiveAction(invokeAction, 'queued-item', action);

    expect(invocation).toEqual({
      channel: 'action:invoke',
      args: [
        'queued-item',
        'working-memory.setWorkstreamSection',
        [{ id: 'queued-item', section: 'progress' }],
      ],
    });
    expect(() => structuredClone(invocation)).not.toThrow();
    expect(incoming).toEqual(returned);
    expect(() => structuredClone(incoming)).not.toThrow();
  });

  it('persists Close Workstream from the menu, archives only that workstream, and supports reopening', async () => {
    await loadKinds();
    const store = openStore(':memory:');
    const server = await startServer({ port: 0, store });
    const client = new ControlPlaneClient({ resolveUrl: () => `${server.url}/mcp` });
    try {
      const workstream = await client.wsCreate({ title: 'Close from menu', status: 'progress' });
      const other = await client.wsCreate({ title: 'Unchanged', status: 'queue' });
      const topic = store.createDocument({
        kind: 'Topic', spec: { title: 'Keep open', status: 'open', workstreams: [workstream.id], parents: [] },
      });
      const before = store.getDocument({ id: topic.metadata.id });
      const active = await loadActivePanelData(client);
      const card = active.items.flatMap((item) => item.kind === 'workstream-section' ? item.workstreams : [])
        .find((item) => item.id === workstream.id)!;
      const close = activeContextMenuItems(card.actions).find((item) => item.title === 'Close Workstream');
      expect(close).toMatchObject({ kind: 'action', enabled: true, icon: 'check' });
      if (close?.kind !== 'action') throw new Error('Close menu item is missing.');

      const invoke = async (id: string, command: string, args: unknown[]) => {
        const action = resolveDesktopAction(command, args, id);
        if (action.kind !== 'workstream') throw new Error('Expected a workstream action.');
        await client.wsUpdate({ id: action.id, status: action.section });
        const vm = await loadWorkstreamViewModel(client, id);
        if (!vm) throw new Error('Updated workstream is missing.');
        return vm;
      };
      expect(await invokeActiveAction(invoke, workstream.id, close.action)).toMatchObject({ id: workstream.id, status: 'closed' });
      expect((await client.wsRead({ id: other.id }))[0].status).toBe('queue');
      expect(store.getDocument({ id: topic.metadata.id })).toEqual(before);
      const refreshed = await loadActivePanelData(client);
      expect(refreshed.items.flatMap((item) => item.kind === 'workstream-section' ? item.workstreams : [])
        .some((item) => item.id === workstream.id)).toBe(false);

      expect(await invokeActiveAction(invoke, workstream.id, {
        command: 'working-memory.reopenWorkstream', title: 'Reopen Workstream', args: [{ id: workstream.id }],
      })).toMatchObject({ status: 'progress' });
      expect(store.getDocument({ id: topic.metadata.id })).toEqual(before);
      await expect(invokeActiveAction(invoke, 'missing', {
        ...close.action, args: [{ id: 'missing', section: 'closed' }],
      })).rejects.toThrow('Unknown workstream');
    } finally {
      await client.dispose();
      await server.close();
      store.close();
    }
  });
});