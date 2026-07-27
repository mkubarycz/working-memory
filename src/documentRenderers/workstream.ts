/**
 * Per-kind renderer for a control-plane `Workstream` document envelope → rich
 * markdown. Pure function of the envelope (no journal store, no VS Code).
 *
 * Workstream carries no outbound refs (its sessions are reverse relations,
 * deferred), so the envelope alone renders metadata + the authored spec. Its
 * member topics are ALSO a reverse relation (a Topic's `spec.workstreams[]`
 * lists the workstream slugs it belongs to), so they can't be read off the
 * workstream envelope: the caller resolves them and passes them in. The
 * renderer stays a pure function of `env` + `topics` (no I/O).
 */

import type { DocumentEnvelope, Topic } from '../controlPlaneClient';
import { asStr, deepLink, metadataSection } from './shared';

export function renderWorkstreamDocument(
  env: DocumentEnvelope,
  topics: Topic[] = [],
): string {
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

  if (topics.length > 0) {
    const sorted = [...topics].sort((a, b) => a.title.localeCompare(b.title));
    lines.push('## Topics', '');
    for (const t of sorted) {
      const slug = t.slug ?? t.id;
      let row = `- [${t.title}](${deepLink('topic', slug)}) \`${slug}\``;
      if (t.status !== 'open') {
        row += ` — _${t.status}_`;
      }
      lines.push(row);
    }
    lines.push('');
  }

  return lines.join('\n');
}
