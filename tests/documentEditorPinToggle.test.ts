/**
 * Unit test for the pure pin-toggle decision used by the Svelte workstream
 * tree's Pin/Unpin action. `shouldSetFocus` decides, from a topic's current
 * `focusedWorkstreams`, whether toggling should SET focus (topic not yet pinned
 * here) or CLEAR it (already pinned) — the host then calls the matching
 * control-plane method. No DB, no VS Code APIs.
 */

import { describe, test, expect, vi } from 'vitest';

// documentEditorProvider imports `vscode`; stub it so this pure helper is
// importable in the node test env (mirrors documentEditorRouting.test.ts).
vi.mock('vscode', () => {
  class EventEmitter<T> {
    get event() {
      return (_listener: (e: T) => void) => ({ dispose: () => {} });
    }
    fire(): void {}
  }
  return { EventEmitter, Uri: { parse: (v: string) => ({ toString: () => v }) } };
});

const { shouldSetFocus } = await import('../src/webview/documentEditorProvider');

describe('shouldSetFocus', () => {
  test('sets focus when the workstream is not already pinned', () => {
    expect(shouldSetFocus([], 'ws-a')).toBe(true);
    expect(shouldSetFocus(['ws-b'], 'ws-a')).toBe(true);
  });

  test('clears focus when the workstream is already pinned', () => {
    expect(shouldSetFocus(['ws-a'], 'ws-a')).toBe(false);
    expect(shouldSetFocus(['ws-b', 'ws-a'], 'ws-a')).toBe(false);
  });
});
