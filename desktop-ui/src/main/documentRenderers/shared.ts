/**
 * Pure helpers shared by the per-kind control-plane document renderers
 * (WM 13.0 "blackboard-tab" rich rendering).
 *
 * These are DISPLAY-side concerns — deep-link emission, timestamp formatting,
 * defensive spec-field coercion — that the control-plane must never know about.
 * Everything here is VS Code-free and a pure function of the envelope so the
 * renderers can be unit-tested directly. This file imports NOTHING from the
 * journal store; the renderers operate solely on the `DocumentEnvelope`.
 */

import type { DocumentEnvelope } from '../../../../shared/controlPlaneClient';

/** Resource kinds supported by the native desktop protocol. */
export type DeepLinkKind =
  | 'workstream'
  | 'topic'
  | 'topic-type'
  | 'alert';

/** Build a native Working Memory desktop link. */
export function deepLink(kind: DeepLinkKind, slug: string): string {
  return `working-memory://open/${kind}/${encodeURIComponent(slug)}`;
}

/** Format a unix-seconds timestamp as `<seconds> (<ISO>)`, or `—` when absent. */
export function fmtTs(seconds: number | null | undefined): string {
  if (typeof seconds !== 'number' || !Number.isFinite(seconds)) {
    return '—';
  }
  return `${seconds} (${new Date(seconds * 1000).toISOString()})`;
}

/** Coerce a spec field to a non-empty string, or null if it isn't one. */
export function asStr(v: unknown): string | null {
  return typeof v === 'string' && v.length > 0 ? v : null;
}

/** Coerce a spec field to a string array, dropping non-string / foreign shapes. */
export function asStrArray(v: unknown): string[] {
  return Array.isArray(v)
    ? v.filter((x): x is string => typeof x === 'string')
    : [];
}

/** Render a list of slugs as bulleted deep links, or `_none_` when empty. */
export function linkList(kind: DeepLinkKind, slugs: string[]): string {
  if (slugs.length === 0) {
    return '_none_';
  }
  return slugs.map((s) => `- [${s}](${deepLink(kind, s)})`).join('\n');
}

/**
 * The shared metadata list (id / slug / resourceVersion / timestamps).
 * `extra` rows (e.g. an authored `status`) are appended after the standard set.
 *
 * Emits the bullet list only — no `## Metadata` heading. The per-kind virtual
 * docs render the metadata inline under the title, matching the pre-13.0
 * layout (bug: topic-page-extra-headers).
 */
export function metadataSection(
  env: DocumentEnvelope,
  extra: string[] = [],
): string[] {
  const { metadata } = env;
  return [
    `- \`id\`: \`${metadata.id}\``,
    `- \`slug\`: ${metadata.slug ?? '_none_'}`,
    `- \`resourceVersion\`: ${metadata.resourceVersion}`,
    `- \`createdAt\`: ${fmtTs(metadata.createdAt)}`,
    `- \`updatedAt\`: ${fmtTs(metadata.updatedAt)}`,
    ...extra,
  ];
}
