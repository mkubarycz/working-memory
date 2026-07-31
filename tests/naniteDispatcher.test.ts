import { describe, test, expect, vi } from 'vitest';
import {
  NaniteDispatcher,
  selectDispatchable,
  type DispatcherClient,
} from '../src/nanites/dispatcher';
import type { Nanite } from '../src/controlPlaneClient';

/** Minimal Queued nanite (the dispatcher only reads id + queuedAt). */
function q(id: string, queuedAt: number): Nanite {
  return { id, queuedAt, phase: 'Queued' } as unknown as Nanite;
}

describe('selectDispatchable', () => {
  test('picks oldest queuedAt first, up to the free-slot budget', () => {
    const ids = selectDispatchable([q('a', 30), q('b', 10), q('c', 20)], new Set(), 2);
    expect(ids).toEqual(['b', 'c']);
  });

  test('excludes in-flight and honors the cap', () => {
    // 1 in flight, max 1 → no free slots.
    expect(selectDispatchable([q('a', 10), q('b', 20)], new Set(['a']), 1)).toEqual([]);
    // 1 in flight, max 2 → one free slot, next-oldest not-in-flight.
    expect(selectDispatchable([q('a', 10), q('b', 20)], new Set(['a']), 2)).toEqual(['b']);
  });

  test('returns nothing when slots are full', () => {
    expect(selectDispatchable([q('a', 10)], new Set(['x', 'y']), 2)).toEqual([]);
  });
});

describe('NaniteDispatcher.pump', () => {
  test('starts at most maxConcurrent (=1) even with several Queued', async () => {
    const started: string[] = [];
    const client: DispatcherClient = {
      naniteRead: async () => [q('a', 10), q('b', 20), q('c', 30)],
    };
    const run = (n: Nanite): Promise<void> => {
      started.push(n.id);
      return new Promise<void>(() => {}); // never settles → stays in flight
    };
    const d = new NaniteDispatcher({ readClient: () => client, run, maxConcurrent: () => 1 });
    await d.pump();
    expect(started).toEqual(['a']);
  });

  test('starts the two oldest when maxConcurrent is 2', async () => {
    const started: string[] = [];
    const client: DispatcherClient = {
      naniteRead: async () => [q('a', 10), q('b', 20), q('c', 30)],
    };
    const run = (n: Nanite): Promise<void> => {
      started.push(n.id);
      return new Promise<void>(() => {});
    };
    const d = new NaniteDispatcher({ readClient: () => client, run, maxConcurrent: () => 2 });
    await d.pump();
    expect(started).toEqual(['a', 'b']);
  });

  test('does nothing when the control plane is unavailable', async () => {
    const run = vi.fn();
    const d = new NaniteDispatcher({ readClient: () => null, run, maxConcurrent: () => 1 });
    await d.pump();
    expect(run).not.toHaveBeenCalled();
  });

  test('drains the next Queued nanite when a slot frees', async () => {
    const started: string[] = [];
    const done = new Set<string>();
    let finishA: (() => void) | undefined;
    const all = [q('a', 10), q('b', 20)];
    const client: DispatcherClient = {
      naniteRead: async () => all.filter((n) => !done.has(n.id)),
    };
    const run = (n: Nanite): Promise<void> =>
      new Promise<void>((resolve) => {
        started.push(n.id);
        if (n.id === 'a') {
          finishA = () => {
            done.add('a');
            resolve();
          };
        } else {
          done.add(n.id);
          resolve();
        }
      });
    const d = new NaniteDispatcher({
      readClient: () => client,
      run,
      maxConcurrent: () => 1,
      onChange: () => {},
    });

    await d.pump();
    expect(started).toEqual(['a']); // only one slot

    finishA?.();
    // Let the finally → pump chain run.
    await new Promise((r) => setTimeout(r, 0));
    expect(started).toEqual(['a', 'b']);
  });
});
