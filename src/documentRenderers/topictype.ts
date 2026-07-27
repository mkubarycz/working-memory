/**
 * Per-kind renderer for a control-plane `TopicType` document envelope → rich
 * markdown. Pure function of the envelope (no journal store, no VS Code).
 *
 * TopicType is authored config (label / icon / description / body_template) and
 * carries no outbound refs. Its usage — the topics that reference this type via
 * their `spec.topicType` — is a REVERSE relation, so the caller resolves those
 * topics and passes them in for the usage count + `## Recent topics` list. The
 * renderer stays a pure function of `env` + `topicsOfType` (no I/O).
 */

import type { DocumentEnvelope, Topic } from '../controlPlaneClient';
import { asStr, deepLink, fmtTs, metadataSection } from './shared';

export function renderTopicTypeDocument(
  env: DocumentEnvelope,
  topicsOfType: Topic[] = [],
): string {
  const spec = env.spec ?? {};
  const id = env.metadata.slug ?? env.metadata.id;
  const label = asStr(spec.label) ?? env.metadata.slug ?? env.metadata.id;
  const icon = asStr(spec.icon);
  const description = asStr(spec.description);
  const bodyTemplate = asStr(spec.body_template);

  const lines: string[] = [
    `# TopicType: ${label} \`${id}\``,
    '',
    ...metadataSection(env, [
      `- \`topics using this type\`: ${topicsOfType.length}`,
    ]),
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

  const recent = [...topicsOfType]
    .filter((t) => t.status === 'open')
    .sort((a, b) => {
      if (b.updated_at !== a.updated_at) {
        return b.updated_at - a.updated_at;
      }
      const aSlug = a.slug ?? a.id;
      const bSlug = b.slug ?? b.id;
      return aSlug.localeCompare(bSlug);
    })
    .slice(0, 25);

  if (recent.length > 0) {
    lines.push('## Recent topics', '');
    for (const t of recent) {
      const slug = t.slug ?? t.id;
      let row = `- [${t.title}](${deepLink('topic', slug)}) \`${slug}\``;
      if (typeof t.updated_at === 'number' && Number.isFinite(t.updated_at)) {
        row += ` — updated ${fmtTs(t.updated_at)}`;
      }
      lines.push(row);
    }
    lines.push('');
  }

  return lines.join('\n');
}
