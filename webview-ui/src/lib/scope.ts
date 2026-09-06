/**
 * Webview-side scope-key helpers for the right-rail command widget. The host
 * tags an in-flight result with the context slug used when it started,
 * bucketing unscoped runs under a sentinel.
 *
 * The widget uses this to guard mid-run messages: a `brief`/`briefRunning`/
 * `briefError` tagged with a run's scope is only applied to the transcript when
 * it matches the scope currently on screen, so switching context mid-run never
 * renders an in-flight response under the wrong document.
 */

/** The scope key used when the widget has no selected document. */
export const GLOBAL_SCOPE_KEY = '__global__';

/** The scope key for an in-flight turn (context slug, or the sentinel). */
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
