import { describe, test, expect } from 'vitest';
import {
  decideRefreshAction,
  type RefreshAction,
} from '../src/webview/refreshDecision';

describe('decideRefreshAction', () => {
  test('errored editor retries (heals Bug B) regardless of signals', () => {
    expect(
      decideRefreshAction({
        errored: true,
        displayedSignal: null,
        fetchedSignal: 'hashA',
        hasPendingEdits: false,
      }),
    ).toBe('retry');
    // errored wins even with pending edits and matching signals
    expect(
      decideRefreshAction({
        errored: true,
        displayedSignal: 'hashA',
        fetchedSignal: 'hashA',
        hasPendingEdits: true,
      }),
    ).toBe('retry');
  });

  test('unloaded (null displayed signal) retries', () => {
    expect(
      decideRefreshAction({
        errored: false,
        displayedSignal: null,
        fetchedSignal: 'hashA',
        hasPendingEdits: false,
      }),
    ).toBe('retry');
  });

  test('same signal is a no-op', () => {
    expect(
      decideRefreshAction({
        errored: false,
        displayedSignal: 'hashA',
        fetchedSignal: 'hashA',
        hasPendingEdits: false,
      }),
    ).toBe('noop');
  });

  test('differing signal with no pending edits applies (Bug A)', () => {
    expect(
      decideRefreshAction({
        errored: false,
        displayedSignal: 'hashA',
        fetchedSignal: 'hashB',
        hasPendingEdits: false,
      }),
    ).toBe('apply');
  });

  test('differing signal WITH pending edits shows the reload banner (no stomp)', () => {
    expect(
      decideRefreshAction({
        errored: false,
        displayedSignal: 'hashA',
        fetchedSignal: 'hashB',
        hasPendingEdits: true,
      }),
    ).toBe('reload-banner');
  });

  // The signal is an opaque hash of the WHOLE view-model. A workstream embeds
  // its child topic + nanite tree, so a child-only change makes the VM hash
  // differ even when the top-level fields are otherwise identical. Proving
  // `apply` here is the regression guard for "closing a child topic doesn't
  // refresh the workstream screen".
  test('differing VM hash applies (child-only change is detected)', () => {
    const displayed = 'hash:workstream:topicA-open';
    const fetched = 'hash:workstream:topicA-closed';
    expect(displayed).not.toBe(fetched);
    expect(
      decideRefreshAction({
        errored: false,
        displayedSignal: displayed,
        fetchedSignal: fetched,
        hasPendingEdits: false,
      }),
    ).toBe('apply');
  });

  test('unchanged VM hash is a no-op', () => {
    const sig = 'hash:workstream:topicA-open';
    expect(
      decideRefreshAction({
        errored: false,
        displayedSignal: sig,
        fetchedSignal: sig,
        hasPendingEdits: false,
      }),
    ).toBe('noop');
  });

  test('differing VM hash WITH pending edits shows reload banner', () => {
    expect(
      decideRefreshAction({
        errored: false,
        displayedSignal: 'hash:workstream:topicA-open',
        fetchedSignal: 'hash:workstream:topicA-closed',
        hasPendingEdits: true,
      }),
    ).toBe('reload-banner');
  });

  test('every branch is covered by the action union', () => {
    const actions: RefreshAction[] = [
      decideRefreshAction({ errored: true, displayedSignal: null, fetchedSignal: 'hashA', hasPendingEdits: false }),
      decideRefreshAction({ errored: false, displayedSignal: 'hashA', fetchedSignal: 'hashA', hasPendingEdits: false }),
      decideRefreshAction({ errored: false, displayedSignal: 'hashA', fetchedSignal: 'hashB', hasPendingEdits: false }),
      decideRefreshAction({ errored: false, displayedSignal: 'hashA', fetchedSignal: 'hashB', hasPendingEdits: true }),
    ];
    expect(new Set(actions)).toEqual(new Set(['retry', 'noop', 'apply', 'reload-banner']));
  });
});
