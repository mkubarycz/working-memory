/**
 * WM: unit coverage for the merged-patch autosave accumulator. Guards the
 * cross-field autosave fix — two rapid single-field edits must collapse into
 * ONE merged patch so no field is dropped by the debounce window.
 */

import { describe, test, expect } from 'vitest';
import { createPendingPatch } from '../webview-ui/src/lib/pendingPatch';

interface Patch {
  title?: string;
  status?: string;
  body?: string;
}

describe('createPendingPatch', () => {
  test('two rapid single-field queues produce one merged patch', () => {
    const pending = createPendingPatch<Patch>();
    pending.merge({ title: 'Renamed' });
    pending.merge({ status: 'closed' });
    expect(pending.isEmpty()).toBe(false);
    expect(pending.flush()).toEqual({ title: 'Renamed', status: 'closed' });
  });

  test('flush clears the accumulator', () => {
    const pending = createPendingPatch<Patch>();
    pending.merge({ title: 'One' });
    expect(pending.flush()).toEqual({ title: 'One' });
    expect(pending.isEmpty()).toBe(true);
    expect(pending.flush()).toBeNull();
  });

  test('empty flush is a no-op', () => {
    const pending = createPendingPatch<Patch>();
    expect(pending.isEmpty()).toBe(true);
    expect(pending.flush()).toBeNull();
  });

  test('a later edit to the same field wins', () => {
    const pending = createPendingPatch<Patch>();
    pending.merge({ title: 'first' });
    pending.merge({ title: 'second' });
    expect(pending.flush()).toEqual({ title: 'second' });
  });

  test('keys reflects the pending fields (echo-stomp guard input)', () => {
    const pending = createPendingPatch<Patch>();
    pending.merge({ title: 'x' });
    pending.merge({ body: 'y' });
    expect(pending.keys().sort()).toEqual(['body', 'title']);
    pending.flush();
    expect(pending.keys()).toEqual([]);
  });
});
