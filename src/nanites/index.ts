import type * as vscode from 'vscode';
import type { JournalStore } from '../db';
import { NanitesStore, NANITES_ENABLED } from './store';
import { registerNaniteTools } from './tools';
import { VscodeLmBridge } from './vscodeBridge';

export interface RegisterNanitesFeatureArgs {
  context: vscode.ExtensionContext;
  /** The live journal store, or null when the DB never opened. */
  store: JournalStore | null;
  deps: { refresh: () => void };
}

/**
 * Wire up the nanites feature. This is the *single place* nanites touches the
 * rest of the extension: call it once from `registerTools`. It is a no-op when
 * the feature flag is off, so the host never has to special-case nanites.
 */
export function registerNanitesFeature(args: RegisterNanitesFeatureArgs): void {
  if (!NANITES_ENABLED) {
    return;
  }
  const { context, store, deps } = args;
  // `connection` is null-tolerant; NanitesStore degrades reads to []/null.
  const nanitesStore = new NanitesStore(store ? store.connection : null);
  const subs = registerNaniteTools(nanitesStore, {
    refresh: deps.refresh,
    bridge: new VscodeLmBridge(),
  });
  context.subscriptions.push(...subs);
}

export { NanitesStore, NANITES_ENABLED } from './store';
export { runNanite } from './runner';
export type { NaniteLmBridge } from './runner';
export * from './types';
