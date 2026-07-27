/**
 * Per-kind renderer for a control-plane `Topic` document envelope → rich
 * markdown. Pure function of the envelope (no journal store, no VS Code).
 *
 * Topic carries two outbound ref lists: `spec.workstreams[]` (membership →
 * workstream deep links) and `spec.parents[]` (→ topic deep links). Both are
 * rendered as clickable lists; missing / foreign-shaped fields render `_none_`.
 */

import type { DocumentEnvelope } from '../controlPlaneClient';
import { asStr, asStrArray, linkList, metadataSection } from './shared';

export function renderTopicDocument(env: DocumentEnvelope): string {
  const spec = env.spec ?? {};
  const title = asStr(spec.title) ?? env.metadata.slug ?? env.metadata.id;
  const status = asStr(spec.status) ?? '—';
  const topicType = asStr(spec.topicType) ?? 'topic';
  const body = asStr(spec.body);
  const workstreams = asStrArray(spec.workstreams);
  const parents = asStrArray(spec.parents);

  const lines: string[] = [
    `# Topic: ${title}`,
    '',
    ...metadataSection(env, [
      `- \`status\`: ${status}`,
      `- \`topicType\`: ${topicType}`,
    ]),
    '',
    '## Body',
    '',
    body ?? '_none_',
    '',
    '## Workstreams',
    '',
    linkList('workstream', workstreams),
    '',
    '## Parents',
    '',
    linkList('topic', parents),
    '',
  ];
  return lines.join('\n');
}
