/**
 * Per-kind renderer for a control-plane `TopicType` document envelope → rich
 * markdown. Pure function of the envelope (no journal store, no VS Code).
 *
 * TopicType is authored config (label / icon / description / body_template) and
 * carries no outbound refs.
 */

import type { DocumentEnvelope } from '../controlPlaneClient';
import { asStr, metadataSection } from './shared';

export function renderTopicTypeDocument(env: DocumentEnvelope): string {
  const spec = env.spec ?? {};
  const label = asStr(spec.label) ?? env.metadata.slug ?? env.metadata.id;
  const icon = asStr(spec.icon);
  const description = asStr(spec.description);
  const bodyTemplate = asStr(spec.body_template);

  const lines: string[] = [
    `# TopicType: ${label}`,
    '',
    ...metadataSection(env),
    '',
    '## Spec',
    '',
    `- \`label\`: ${label}`,
    `- \`icon\`: ${icon ?? '_none_'}`,
    `- \`description\`: ${description ?? '_none_'}`,
    '',
    '## Body template',
    '',
    bodyTemplate ?? '_none_',
    '',
  ];
  return lines.join('\n');
}
