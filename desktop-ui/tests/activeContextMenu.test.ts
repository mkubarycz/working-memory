import { describe, expect, it } from 'vitest';
import {
  activeContextMenuItems,
  invokeActiveAction,
  topicSlugFromOpenUri,
} from '../src/renderer/activeContextMenu';
import type { WorkstreamVM } from '../../webview-ui/src/lib/types';

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
    expect(activeContextMenuItems([], { topic: 'topic-one', focused: false })).toEqual([
      { kind: 'focus', title: 'Add to Focus', icon: 'pin', enabled: true, topic: 'topic-one' },
    ]);
    expect(activeContextMenuItems([], { topic: 'topic-one', focused: true })[0]).toMatchObject({
      title: 'Remove from Focus',
      icon: 'pinned',
    });
  });

  it('extracts and decodes the topic slug from a panel URI', () => {
    expect(topicSlugFromOpenUri('working-memory:/topic/design%20notes.working-memory')).toBe('design notes');
    expect(topicSlugFromOpenUri('not a uri')).toBe('');
  });

  it('projects Queue action proxies before the bridge and accepts a cloneable result', async () => {
    const action = reactiveProxy({
      command: 'working-memory.setWorkstreamSection',
      title: 'Send to In Progress',
      args: [{ slug: 'queued-item', section: 'progress' }],
    });
    const returned: WorkstreamVM = {
      kind: 'workstream',
      title: 'Queued item',
      slug: 'queued-item',
      status: 'progress',
      createdAt: 0,
      updatedAt: 1,
      closure: null,
      resourceVersion: 2,
      editable: true,
      topics: [],
      tree: [],
      alerts: [],
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
        [{ slug: 'queued-item', section: 'progress' }],
      ],
    });
    expect(() => structuredClone(invocation)).not.toThrow();
    expect(incoming).toEqual(returned);
    expect(() => structuredClone(incoming)).not.toThrow();
  });
});