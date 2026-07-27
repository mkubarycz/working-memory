/**
 * Per-kind renderer for a control-plane `Alert` document envelope → rich
 * markdown. Pure function of the envelope (no journal store, no VS Code).
 *
 * Alert carries one outbound ref list: `spec.topics[]` (→ topic deep links).
 * Missing / foreign-shaped fields render `_none_`.
 */

import type { DocumentEnvelope } from '../controlPlaneClient';
import { asStr, asStrArray, linkList, metadataSection } from './shared';

export function renderAlertDocument(env: DocumentEnvelope): string {
  const spec = env.spec ?? {};
  const description = asStr(spec.description);
  const title =
    asStr(spec.title) ??
    description?.split('\n')[0] ??
    `Alert ${env.metadata.id}`;
  const status = asStr(spec.status) ?? '—';
  const recommendedAction = asStr(spec.recommended_action);
  const dedupeKey = asStr(spec.dedupe_key);
  const createdBy = asStr(spec.created_by) ?? 'system';
  const topics = asStrArray(spec.topics);

  const lines: string[] = [
    `# Alert: ${title}`,
    '',
    ...metadataSection(env, [
      `- \`status\`: ${status}`,
      `- \`createdBy\`: ${createdBy}`,
    ]),
    '',
    '## Spec',
    '',
    `- \`title\`: ${asStr(spec.title) ?? '_none_'}`,
    `- \`status\`: ${status}`,
    `- \`dedupeKey\`: ${dedupeKey ?? '_none_'}`,
    '',
    '## Description',
    '',
    description ?? '_none_',
    '',
    '## Recommended action',
    '',
    recommendedAction ?? '_none_',
    '',
    '## Topics',
    '',
    linkList('topic', topics),
    '',
  ];
  return lines.join('\n');
}
