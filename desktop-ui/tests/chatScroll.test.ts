import { describe, expect, it } from 'vitest';
import { CHAT_BOTTOM_THRESHOLD, isChatAtBottom } from '../src/renderer/chatScroll';

describe('chat scroll state', () => {
  it('treats the exact bottom and small fractional gaps as pinned', () => {
    expect(isChatAtBottom({ scrollTop: 600, clientHeight: 400, scrollHeight: 1_000 })).toBe(true);
    expect(isChatAtBottom({
      scrollTop: 600 - CHAT_BOTTOM_THRESHOLD,
      clientHeight: 400,
      scrollHeight: 1_000,
    })).toBe(true);
  });

  it('preserves user scroll intent outside the bottom tolerance', () => {
    expect(isChatAtBottom({
      scrollTop: 599 - CHAT_BOTTOM_THRESHOLD,
      clientHeight: 400,
      scrollHeight: 1_000,
    })).toBe(false);
  });

  it('considers content shorter than the viewport pinned', () => {
    expect(isChatAtBottom({ scrollTop: 0, clientHeight: 500, scrollHeight: 300 })).toBe(true);
  });
});