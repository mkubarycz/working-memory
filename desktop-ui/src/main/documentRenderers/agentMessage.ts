import type { DocumentEnvelope } from '../../../../shared/controlPlaneClient';
import { asStr, asStrArray, linkList, metadataSection } from './shared';

export function renderAgentMessageDocument(env: DocumentEnvelope): string {
  const spec = env.spec;
  const description = asStr(spec.description) ?? '';
  const title = asStr(spec.title) || description.split('\n')[0] || `Agent message ${env.metadata.id}`;
  return [
    `# Agent message: ${title}`, '',
    ...metadataSection(env, [
      `- \`status\`: ${asStr(spec.status) ?? '—'}`,
      `- \`category\`: ${asStr(spec.category) ?? '—'}`,
      `- \`severity\`: ${asStr(spec.severity) ?? '—'}`,
      `- \`attention\`: ${spec.attention === true}`,
      `- \`createdBy\`: ${asStr(spec.created_by) ?? '—'}`,
    ]),
    '', '## Description', '', description || '_none_',
    '', '## Recommended action', '', asStr(spec.recommended_action) || '_none_',
    '', '## Recorded approval decision', '', JSON.stringify(spec.decision ?? null, null, 2),
    '', '_A recorded decision is communication, not permission to execute a protected action._',
    '', '## Topics', '', linkList('topic', asStrArray(spec.topics)),
    '', '## Relations', '', JSON.stringify(spec.relations ?? [], null, 2),
    '', '## Provenance', '', JSON.stringify(spec.provenance ?? null, null, 2), '',
  ].join('\n');
}
