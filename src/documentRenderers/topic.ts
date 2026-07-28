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
import {
  alertActionLink,
  asStr,
  asStrArray,
  deepLink,
  fmtTs,
  linkList,
  metadataSection,
} from './shared';

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
      `- \`topicType\`: [${topicType}](${deepLink('topic-type', topicType)})`,
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
    const thisSlug = env.metadata.slug;
    lines.push('## Alerts', '');
    const blocks = alerts.map((alert) => {
      // Alerts have no slug (always null), so deep-link by id.
      const link = deepLink('alert', alert.slug ?? alert.id);
      const iconName =
        alert.status === 'alert'
          ? 'bell'
          : alert.status === 'informational'
            ? 'info'
            : 'pass';
      // Colored codicon via inline style only — the markdown preview keeps the
      // glyph + color but strips CSS class styling. Red bell for active alerts;
      // text-bottom keeps the glyph on the text baseline.
      const color = alert.status === 'alert' ? 'color:#f14c4c;' : '';
      const icon = `<span class="codicon codicon-${iconName}" style="${color}vertical-align:text-bottom"></span>`;
      const title =
        alert.title.trim() ||
        alert.description.split('\n')[0] ||
        `Alert ${alert.id}`;
      const desc = alert.description.trim();
      const next = alert.recommended_action.trim();
      const alertLines = [
        `[${icon}](${link}) **[${title}](${link})** — ${fmtTs(alert.updated_at)}`,
      ];
      if (desc) {
        alertLines.push(desc);
      }
      if (next) {
        alertLines.push(`Next: ${next}`);
      }
      const others = asStrArray(alert.topics).filter((t) => t !== thisSlug);
      if (others.length) {
        const shown = others
          .slice(0, 3)
          .map((t) => `[${t}](${deepLink('topic', t)})`);
        const more = others.length > 3 ? ' …' : '';
        alertLines.push(`Other topics: ${shown.join(', ')}${more}`);
      }
      if (alert.status === 'alert') {
        alertLines.push(
          [
            `[Acknowledge](${alertActionLink(alert.id, 'acknowledge')})`,
            `[Close](${alertActionLink(alert.id, 'close')})`,
          ].join(' · '),
        );
      } else if (alert.status === 'informational') {
        alertLines.push(
          [
            `[Escalate](${alertActionLink(alert.id, 'reopen')})`,
            `[Close](${alertActionLink(alert.id, 'close')})`,
          ].join(' · '),
        );
      } else {
        alertLines.push(
          [
            `[Reopen (Alert)](${alertActionLink(alert.id, 'reopen')})`,
            `[Reopen (Information)](${alertActionLink(alert.id, 'acknowledge')})`,
          ].join(' · '),
        );
      }
      return alertLines.join('  \n');
    });
    lines.push(blocks.join('\n\n'), '');
  }

  return lines.join('\n');
}
