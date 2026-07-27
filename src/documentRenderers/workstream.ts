/**
 * Per-kind renderer for a control-plane `Workstream` document envelope → rich
 * markdown. Pure function of the envelope (no journal store, no VS Code).
 *
 * Workstream carries no outbound refs (its topics/sessions are reverse
 * relations, deferred), so this renders metadata + the authored spec only.
 */

import type { DocumentEnvelope } from '../controlPlaneClient';
import { asStr, metadataSection } from './shared';

export function renderWorkstreamDocument(env: DocumentEnvelope): string {
  const spec = env.spec ?? {};
  const title = asStr(spec.title) ?? env.metadata.slug ?? env.metadata.id;
  const status = asStr(spec.status) ?? '—';
  const closure = asStr(spec.closure);

  const lines: string[] = [
    `# Workstream: ${title}`,
    '',
    ...metadataSection(env, [`- \`status\`: ${status}`]),
    '',
    '## Spec',
    '',
    `- \`title\`: ${title}`,
    `- \`status\`: ${status}`,
    `- \`closure\`: ${closure ?? '_none_'}`,
    '',
  ];
  return lines.join('\n');
}
