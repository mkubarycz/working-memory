import type * as vscode from 'vscode';
import type { JournalStore } from '../db';
import { AlertsStore } from './store';
import { registerAlertTools, type AlertToolDeps } from './tools';

/**
 * Single on/off switch for the entire alerts feature. Flip to `false` and the
 * whole feature — every `wm_*alert*` tool — stops registering. (The migration
 * and the static `package.json` tool declarations are inert manifest data and
 * stay put; nothing wires up at runtime when this is off.)
 */
export const ALERTS_ENABLED = true;

export interface RegisterAlertsFeatureArgs {
  context: vscode.ExtensionContext;
  /** The live journal store, or null when the DB never opened. */
  store: JournalStore | null;
  deps: AlertToolDeps;
}

/**
 * Wire up the alerts feature. This is the *single place* alerts touches the
 * rest of the extension: call it once from `registerTools`. It is a no-op when
 * the feature flag is off or there is no DB handle, so the host never has to
 * special-case alerts.
 */
export function registerAlertsFeature(args: RegisterAlertsFeatureArgs): void {
  if (!ALERTS_ENABLED) {
    return;
  }
  const { context, store, deps } = args;
  // `connection` is null-tolerant; AlertsStore degrades reads to []/null.
  const alertsStore = new AlertsStore(store ? store.connection : null);
  const subs = registerAlertTools(alertsStore, deps);
  context.subscriptions.push(...subs);
}

export { AlertsStore } from './store';
export * from './types';
