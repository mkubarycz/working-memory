/**
 * Per-kind DISPLAY REGISTRY for control-plane document envelopes (WM 13.0
 * "blackboard-tab" rich rendering).
 *
 * This is the EXTENSION-SIDE display layer: each renderer turns a
 * `DocumentEnvelope` into readable markdown that emits `vscode://` / clickable
 * deep links — a concern the control-plane must not know about. The registry
 * dispatches on `env.kind`, falling back to the generic
 * `renderDocumentEnvelopeDoc` (raw kind/metadata/spec/status dump) for any kind
 * without a registered renderer.
 *
 * All renderers are pure functions of the envelope (no journal store, no VS
 * Code), so they're unit-tested directly against fixture envelopes.
 */

import type { DocumentEnvelope } from '../controlPlaneClient';
import { renderDocumentEnvelopeDoc } from '../documentRenderer';
import { renderWorkstreamDocument } from './workstream';
import { renderTopicDocument } from './topic';
import { renderTopicTypeDocument } from './topictype';
import { renderAlertDocument } from './alert';
import { renderNaniteDocument } from './nanite';

/** A pure per-kind renderer: envelope → markdown. */
export type DocumentRenderer = (env: DocumentEnvelope) => string;

const RENDERERS = new Map<string, DocumentRenderer>();

/** Register (or override) the renderer for a control-plane kind name. */
export function registerDocumentRenderer(
  kind: string,
  fn: DocumentRenderer,
): void {
  RENDERERS.set(kind, fn);
}

/**
 * Render a document envelope via its kind's registered renderer, falling back
 * to the generic envelope renderer for unknown kinds.
 */
export function renderDocumentByKind(env: DocumentEnvelope): string {
  const renderer = RENDERERS.get(env.kind);
  return renderer ? renderer(env) : renderDocumentEnvelopeDoc(env);
}

// Register the control-plane kinds at module load. Keys mirror the kind
// name strings the control-plane assigns (control-plane/src/kinds/*/…).
registerDocumentRenderer('Workstream', renderWorkstreamDocument);
registerDocumentRenderer('Topic', renderTopicDocument);
registerDocumentRenderer('TopicType', renderTopicTypeDocument);
registerDocumentRenderer('Alert', renderAlertDocument);
registerDocumentRenderer('Nanite', renderNaniteDocument);
