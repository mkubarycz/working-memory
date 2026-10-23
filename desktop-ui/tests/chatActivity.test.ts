import { afterEach, describe, expect, it, vi } from 'vitest';
import { createLiveRun } from '../src/renderer/chatHistory';
import { chatContextBusy, chatContextPending } from '../src/renderer/scopedChat';
import { collectUnreadResponses, observeResponse, parseUnreadResponses, unreadResponseCount } from '../src/renderer/chatUnread';
import { createDocumentChangeQueue, documentMatchesChange, documentRefreshTarget } from '../src/renderer/documentChanges';
import type { ChatContext } from '../src/shared/contracts';

const context: ChatContext = { kind: 'Topic', routeKind: 'topic', identifier: 'first', title: 'First' };
const first = createLiveRun('first-run', 'First query', { kind: 'Topic', id: 'first' }, 1_800_000_000_000);
const second = createLiveRun('second-run', 'Second query', { kind: 'Topic', id: 'second' }, 1_800_000_000_001);

afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

describe('concurrent scoped chats', () => {
  it('blocks only a query or confirmation in the same primary conversation', () => {
    expect(chatContextBusy([second], context)).toBe(false);
    expect(chatContextBusy([first, second], context)).toBe(true);
    const pending = { ...second, status: 'awaiting_confirmation' as const, pendingConfirmation: { id: 'approval', tool: 'delete', arguments: {} } };
    expect(chatContextPending([pending], context)).toBeUndefined();
    expect(chatContextPending([pending], { ...context, identifier: 'second' })).toBe(pending);
    expect(chatContextBusy([{ ...second, entityRefs: [{ kind: 'Topic', id: 'first', relation: 'referenced' }] }], context)).toBe(false);
  });

  it('marks interleaved responses once and preserves unread aliases across a reload', () => {
    const complete = { ...second, status: 'succeeded' as const, assistantText: 'Second response',
      entityRefs: [{ kind: 'Topic', id: 'uuid',  relation: 'referenced' as const }] };
    const unread = collectUnreadResponses([], [first, second], [first, complete], true);
    expect(unreadResponseCount(unread, 'topic', 'second')).toBe(1);
    expect(unreadResponseCount(unread, 'topic', 'first')).toBe(0);
    expect(unreadResponseCount(unread, 'topic', 'uuid', 'uuid')).toBe(1);
    expect(parseUnreadResponses(JSON.stringify(unread))).toEqual(unread);
    expect(collectUnreadResponses([], [complete], [complete], true)).toEqual([]);
    expect(collectUnreadResponses([], [], [complete], false)).toEqual([]);
  });
});

describe('viewed-response delay', () => {
  function setup() {
    vi.useFakeTimers();
    let focus = true;
    let intersect: (visible: boolean) => void = () => {};
    const doc = Object.assign(new EventTarget(), { visibilityState: 'visible', hasFocus: () => focus });
    const win = new EventTarget();
    vi.stubGlobal('document', doc);
    vi.stubGlobal('window', win);
    vi.stubGlobal('IntersectionObserver', class {
      constructor(callback: (entries: Array<{ isIntersecting: boolean }>) => void) {
        intersect = (visible) => callback([{ isIntersecting: visible }]);
      }
      observe() {}
      disconnect() {}
    });
    const onViewed = vi.fn();
    const action = observeResponse({} as HTMLElement, { key: 'response', enabled: true, onViewed });
    return { action, onViewed, doc, win, intersect: (visible: boolean) => intersect(visible), focus: (value: boolean) => { focus = value; win.dispatchEvent(new Event(value ? 'focus' : 'blur')); } };
  }

  it('requires three continuous visible, focused seconds and resets when hidden', async () => {
    const test = setup();
    test.intersect(true);
    await vi.advanceTimersByTimeAsync(2_000);
    test.intersect(false);
    await vi.advanceTimersByTimeAsync(5_000);
    expect(test.onViewed).not.toHaveBeenCalled();
    test.intersect(true);
    await vi.advanceTimersByTimeAsync(2_999);
    expect(test.onViewed).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(test.onViewed).toHaveBeenCalledExactlyOnceWith('response');
    test.action.destroy();
  });

  it('does not acknowledge a background window or a destroyed observer', async () => {
    const test = setup();
    test.intersect(true);
    test.focus(false);
    await vi.advanceTimersByTimeAsync(5_000);
    expect(test.onViewed).not.toHaveBeenCalled();
    test.focus(true);
    await vi.advanceTimersByTimeAsync(2_000);
    test.action.destroy();
    await vi.advanceTimersByTimeAsync(5_000);
    expect(test.onViewed).not.toHaveBeenCalled();
  });
});

describe('change-driven renderer refresh', () => {
  it('does not treat another document kind with the same id as a deleted tab', () => {
    const change = { kind: 'Topic', id: 'topic-id',  resourceVersion: 2, deleted: true };
    expect(documentMatchesChange({ kind: 'topic', id: 'shared-id' }, change)).toBe(false);
    expect(documentMatchesChange({ kind: 'workstream', id: 'shared-id' }, change)).toBe(false);
    expect(documentMatchesChange({ kind: 'topic', id: 'topic-id',  }, change)).toBe(true);
  });

  it('coalesces changes for 100ms and serializes updates arriving during a refresh', async () => {
    vi.useFakeTimers();
    let release!: () => void;
    const refresh = vi.fn().mockImplementationOnce(() => new Promise<void>((resolve) => { release = resolve; }))
      .mockResolvedValue(undefined);
    const queue = createDocumentChangeQueue(refresh, (error) => { throw error; });
    const change = { id: 'one', kind: 'Topic',  resourceVersion: 1, deleted: false };
    queue.enqueue({ resourceVersion: 1, reset: false, changes: [change] });
    queue.enqueue({ resourceVersion: 2, reset: false, changes: [{ ...change, resourceVersion: 2 }] });
    await vi.advanceTimersByTimeAsync(99);
    expect(refresh).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(refresh).toHaveBeenCalledTimes(1);
    expect(refresh.mock.calls[0][0].changes).toEqual([{ ...change, resourceVersion: 2 }]);
    queue.enqueue({ resourceVersion: 3, reset: false, changes: [{ ...change, resourceVersion: 3 }] });
    await vi.advanceTimersByTimeAsync(500);
    expect(refresh).toHaveBeenCalledTimes(1);
    release();
    await vi.advanceTimersByTimeAsync(0);
    expect(refresh).toHaveBeenCalledTimes(2);
    queue.clear();
  });

  it('drops queued work on environment reset and never refreshes local drafts', async () => {
    vi.useFakeTimers();
    const refresh = vi.fn();
    const queue = createDocumentChangeQueue(refresh, vi.fn());
    queue.enqueue({ resourceVersion: 1, reset: true, changes: [] });
    queue.clear();
    await vi.advanceTimersByTimeAsync(100);
    expect(refresh).not.toHaveBeenCalled();
    expect(documentRefreshTarget({ kind: 'settings', id: 'desktop-settings',  title: 'Settings' })).toBeUndefined();
    expect(documentRefreshTarget({ kind: 'host-tasks', id: 'approved-host-tasks', title: 'Host tasks' })).toBeUndefined();
    expect(documentRefreshTarget({ kind: 'host-task', id: 'task-id', title: 'Import messages' })).toBeUndefined();
    expect(documentRefreshTarget({ kind: 'host-task-create', id: 'new-host-task', title: 'Add host task' })).toBeUndefined();
    expect(documentRefreshTarget({ kind: 'topic-create', id: 'draft',  title: '', body: 'Draft', topicType: 'topic', topicTypes: [], workstream: 'work', workstreamTitle: 'Work', parent: null, parentTitle: null })).toBeUndefined();
  });
});
