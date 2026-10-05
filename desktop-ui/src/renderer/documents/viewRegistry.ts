/**
 * View dispatch + per-topic-type customization framework for the unified
 * `.working-memory` document editor (WM 14.2).
 *
 * The control plane is a generic document store, so ONE custom editor renders
 * every kind. This module is the pure, framework-agnostic core of the
 * dispatcher: it maps a document `kind` to a view id, and maps a topic-type
 * slug to any UI customization. It imports NO Svelte and NO VS Code APIs so it
 * can be unit-tested directly under vitest.
 */

/** The bespoke views the editor knows how to render, plus the generic fallback. */
export type ViewId = 'workstream' | 'topic' | 'generic';

/**
 * The kind→view registry. Every entry is a bespoke view; ANY kind not listed
 * here falls back to the generic `DocumentView` so nothing is unopenable.
 */
const VIEW_REGISTRY: Record<string, ViewId> = {
  workstream: 'workstream',
  topic: 'topic',
};

/**
 * Resolve which view renders a document of the given `kind`. Unknown kinds fall
 * back to the generic document view.
 */
export function resolveView(kind: string): ViewId {
  return VIEW_REGISTRY[kind] ?? 'generic';
}

// ---- Per-topic-type customization framework --------------------------------

/** An extra, type-specific setting surfaced in the topic view's header grid. */
export interface TopicTypeExtraSetting {
  /** Attribute key rendered in the grid label. */
  label: string;
  /**
   * Resolve the display value for this setting from a topic view-model. Kept as
   * a function so a type can derive its own presentation without a new DB
   * column — this is UI-only type-awareness (the fields schema is deferred).
   */
  value: (topic: { topicType: string; status: string; slug: string | null }) => string;
}

/**
 * Per-topic-type UI customization. All fields are optional: a type with no
 * entry (or a partial entry) falls back to the shared topic fields + the
 * control-plane type icon.
 */
export interface TopicTypeUiConfig {
  /**
   * Optional codicon-id override. Normally the control-plane TopicType icon
   * wins; a registry entry can force a specific icon for a type the UI wants to
   * present distinctly regardless of stored metadata.
   */
  icon?: string;
  /** Extra settings surfaced beyond the shared topic fields. */
  extraSettings?: TopicTypeExtraSetting[];
}

/**
 * The topic-type registry. This is the extension point: to give a topic type
 * bespoke UI, add an entry keyed by its slug. Empty by default — every type
 * currently falls back to the shared topic fields + the control-plane icon.
 */
const TOPIC_TYPE_REGISTRY: Record<string, TopicTypeUiConfig> = {};

/** Fallback codicon id when neither the registry nor the control plane names one. */
export const FALLBACK_TOPIC_ICON = 'symbol-key';

/** Look up a topic type's UI customization (empty config when none registered). */
export function getTopicTypeConfig(topicType: string): TopicTypeUiConfig {
  return TOPIC_TYPE_REGISTRY[topicType] ?? {};
}

/**
 * Resolve the codicon id for a topic: a registry override wins, then the
 * control-plane type icon, then the shared fallback.
 */
export function iconForTopic(
  topicType: string,
  controlPlaneIcon: string | null | undefined,
): string {
  const override = getTopicTypeConfig(topicType).icon;
  if (override) {
    return override;
  }
  if (controlPlaneIcon && controlPlaneIcon.trim().length > 0) {
    return controlPlaneIcon;
  }
  return FALLBACK_TOPIC_ICON;
}
