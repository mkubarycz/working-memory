/**
 * Per-kind renderer for a control-plane `Nanite` document envelope → rich
 * markdown. Pure function of the envelope (no journal store, no VS Code).
 *
 * A Nanite is one execution instance of a Nanite Template. For debugging /
 * auditability we surface the two things a reader actually wants to inspect —
 * the full REQUEST sent to the model (`spec.prompt`) and its RESPONSE
 * (`spec.output`) — as COLLAPSED `<details>` sections ABOVE the raw envelope
 * dump, so they're one click away without dominating the page. The full
 * kind/metadata/spec/status envelope follows below unchanged.
 */

import type { DocumentEnvelope } from '../controlPlaneClient';
import { renderDocumentEnvelopeDoc } from '../documentRenderer';
import { asStr } from './shared';

/** A collapsed `<details>` block, or '' when there's nothing to show. */
function collapsedSection(summary: string, body: string | null | undefined): string {
  const content = (body ?? '').trim();
  if (!content) {
    return '';
  }
  // Body is rendered as plain markdown inside the disclosure (no code fence) to
  // avoid fence-collision with model output that itself contains ``` blocks.
  return [`<details>`, `<summary>${summary}</summary>`, '', content, '', `</details>`].join(
    '\n',
  );
}

export function renderNaniteDocument(env: DocumentEnvelope): string {
  const spec = env.spec ?? {};
  const phase = asStr(spec.phase) ?? 'Pending';
  const request = collapsedSection('Request — full prompt sent to the model', asStr(spec.prompt));
  const response = collapsedSection('Response — model output', asStr(spec.output));

  const header: string[] = [`# Nanite: ${env.metadata.id}`, '', `- \`phase\`: ${phase}`, ''];

  const sections = [request, response].filter((s) => s.length > 0);
  const top = sections.length > 0 ? [...header, ...sections, ''] : header;

  // Collapsed request/response first, then the raw envelope (metadata/spec/…).
  return [...top, renderDocumentEnvelopeDoc(env)].join('\n');
}
