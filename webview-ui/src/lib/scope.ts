/**
 * Webview-side scope-key helpers for the right-rail command widget. The host
 * keys a CommandJournal turn by the widget's context slug (topic OR workstream),
 * bucketing unscoped turns under a sentinel. `commandJournal.ts` (host-side)
 * owns the canonical implementation; this is a byte-for-byte duplicate because
 * the webview is a SEPARATE TypeScript program and can't import host modules.
 * Keep the two in sync by hand.
 *
 * The widget uses this to guard mid-run messages: a `brief`/`briefRunning`/
 * `briefError`/`attachJournalId` tagged with a run's scope is only applied to
 * the transcript when it matches the scope currently on screen — so switching
 * workstream/topic mid-run never renders an in-flight response in the wrong
 * transcript (the record is persisted and replays on next hydrate of its scope).
 */

/** The scope key used when the widget has no selected document. */
export const GLOBAL_SCOPE_KEY = '__global__';

/** The scope key a turn is journaled under (context slug, or the sentinel). */
export function scopeKeyFor(contextSlug: string | null | undefined): string {
  const slug = (contextSlug ?? '').trim();
  return slug.length > 0 ? slug : GLOBAL_SCOPE_KEY;
}

/**
 * Whether a run-tagged message should be applied to the visible transcript:
 * true only when the message's `scope` matches the scope currently displayed.
 */
export function isCurrentScope(messageScope: string, currentScope: string): boolean {
  return messageScope === currentScope;
}
