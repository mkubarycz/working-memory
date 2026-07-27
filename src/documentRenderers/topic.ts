/**
 * Per-kind renderer for a control-plane `Topic` document envelope → rich
 * markdown. Pure function of the envelope (no journal store, no VS Code).
 *
 * Topic carries two outbound ref lists: `spec.workstreams[]` (membership →
 * workstream deep links) and `spec.parents[]` (→ topic deep links). Both are
 * rendered as clickable lists; missing / foreign-shaped fields render `_none_`.
 *
 * Alerts are a REVERSE relation (an Alert's `spec.topics[]` lists the topic
 * slugs it concerns), so they can't be read off the topic envelope. The caller
 * resolves the matching open alerts and passes them in; the renderer stays a
 * pure function of `env` + `alerts` (no I/O).
 */

import type { Alert, DocumentEnvelope } from '../controlPlaneClient';
import { asStr, asStrArray, deepLink, linkList, metadataSection } from './shared';

export function renderTopicDocument(
  env: DocumentEnvelope,
  alerts: Alert[] = [],
): string {
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

  if (alerts.length > 0) {
    lines.push('## Alerts', '');
    for (const alert of alerts) {
      const label =
        asStr(alert.title) ??
        asStr(alert.description)?.split('\n')[0] ??
        `Alert ${alert.id}`;
      // Alerts have no slug (always null), so deep-link by id.
      lines.push(`- [${label}](${deepLink('alert', alert.slug ?? alert.id)})`);
    }
    lines.push('');
  }

  return lines.join('\n');
}
