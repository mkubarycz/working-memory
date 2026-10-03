import { describe, expect, it, vi } from 'vitest';
import { focusChatRunTarget, type ChatRunFocusTarget } from '../src/renderer/chatRunFocus';

describe('focusChatRunTarget', () => {
  it('activates Log before rendering, finding, scrolling, and focusing a history run', async () => {
    let activeTab = 'container-apps';
    let chatExpanded = false;
    const interactions: string[] = [];
    const scroller = {
      getBoundingClientRect: () => ({ top: 0, height: 100 }),
    } as Element;
    const target = {
      closest: () => scroller,
      getBoundingClientRect: () => ({ top: 150, height: 20 }),
      scrollIntoView: () => interactions.push('scroll'),
      focus: () => interactions.push('focus'),
    } as unknown as ChatRunFocusTarget;

    await focusChatRunTarget({
      activateLog: () => {
        interactions.push('activate-log');
        activeTab = 'log';
      },
      expandChatRail: () => {
        interactions.push('expand-chat');
        chatExpanded = true;
      },
      afterRender: async () => {
        interactions.push('render');
        expect(activeTab).toBe('log');
        expect(chatExpanded).toBe(true);
      },
      getTarget: () => {
        interactions.push('find-target');
        return activeTab === 'log' && chatExpanded ? target : null;
      },
      waitForScrollEnd: async () => interactions.push('scroll-end'),
      restartAttention: vi.fn(() => interactions.push('attention')),
    });

    expect(interactions).toEqual([
      'activate-log',
      'expand-chat',
      'render',
      'find-target',
      'scroll-end',
      'scroll',
      'focus',
      'attention',
    ]);
  });
});
