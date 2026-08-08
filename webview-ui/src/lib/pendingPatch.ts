/**
 * Merged-patch accumulator for the document editor's debounced autosave.
 *
 * The autosave bug this fixes: editing two fields (e.g. title then status)
 * inside one debounce window used to post a SINGLE-field patch per keystroke
 * and share one timer, so the first field's write was dropped. Instead, each
 * edit merges its field(s) into ONE pending patch; the debounce timer flushes
 * the whole accumulated patch in a single write.
 *
 * This module is pure — no Svelte, no VS Code APIs — so it can be unit-tested
 * directly under node vitest.
 */

/** A mutable accumulator of edited fields awaiting a single debounced flush. */
export interface PendingPatch<T extends object> {
  /** Merge one or more edited fields into the pending patch. */
  merge(fields: Partial<T>): void;
  /** The field keys currently pending (used by the echo-stomp guard). */
  keys(): (keyof T)[];
  /** True when nothing is pending. */
  isEmpty(): boolean;
  /**
   * Snapshot the accumulated patch and clear it. Returns `null` when nothing is
   * pending so an empty flush is a cheap no-op.
   */
  flush(): Partial<T> | null;
}

/** Create an empty {@link PendingPatch} accumulator. */
export function createPendingPatch<T extends object>(): PendingPatch<T> {
  let pending: Partial<T> = {};
  return {
    merge(fields) {
      Object.assign(pending, fields);
    },
    keys() {
      return Object.keys(pending) as (keyof T)[];
    },
    isEmpty() {
      return Object.keys(pending).length === 0;
    },
    flush() {
      if (Object.keys(pending).length === 0) {
        return null;
      }
      const snapshot = pending;
      pending = {};
      return snapshot;
    },
  };
}
