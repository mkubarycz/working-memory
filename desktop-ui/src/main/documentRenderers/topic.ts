/**
 * Per-kind renderer for a control-plane `Topic` document envelope → rich
 * markdown. Pure function of the envelope (no journal store, no VS Code).
 *
 * The `## Workstreams` section renders friendly clickable links (title label,
 * not id). The `## Family` section renders the topic's hierarchical family —
 * ancestors, the current topic (marked), and descendants — as an indented tree
 * of friendly links (WM 13.0.2 `feature-family-tree-display`).
 *
 * Both the family tree and the workstream titles are REVERSE / cross-document
 * relations that can't be read off the topic envelope alone, so — exactly like
 * `alerts` — the caller resolves them and passes them in via `relations`; the
 * renderer stays a pure function of `env` + `alerts` + `relations` (no I/O).
 * When `relations` is omitted the renderer degrades gracefully: a single-node
 * Family (just this topic) and id-labeled workstream links from `spec`.
 */

import type { AgentMessage, DocumentEnvelope } from '../../../../shared/controlPlaneClient';
import type { FamilyNode } from './family';
import {
  asStr,
  asStrArray,
  deepLink,
  fmtTs,
  metadataSection,
} from './shared';

/**
 * Resolved cross-document relations for a topic doc, fetched by the content
 * provider and injected into the pure renderer.
 */
export interface TopicRelations {
  /** Unified family display tree roots (ancestors → current → descendants). */
  family?: FamilyNode[];
  /** Member workstreams with resolved friendly titles. */
  workstreams?: { id: string; title: string }[];
}

/** Render the unified family tree as indented (2 spaces / level) bullets. */
function familyLines(
  nodes: FamilyNode[],
  indent: number,
  out: string[],
): void {
  for (const n of nodes) {
    const pad = '  '.repeat(indent);
    if (n.isCurrent) {
      out.push(`${pad}- **${n.title}**`);
    } else {
      out.push(`${pad}- [${n.title}](${deepLink('topic', n.id)})`);
    }
    familyLines(n.children, indent + 1, out);
  }
}
export function renderTopicDocument(
  env: DocumentEnvelope,
  alerts: AgentMessage[] = [],
  relations: TopicRelations = {},
): string {
  const spec = env.spec ?? {};
  const title = asStr(spec.title) ?? env.metadata.id;
  const status = asStr(spec.status) ?? '—';
  const topicType = asStr(spec.topicType);
  const body = asStr(spec.body);

  // Workstreams: prefer resolved friendly links; degrade to id labels from
  // `spec.workstreams` when the caller injected none.
  const workstreamLinks =
    relations.workstreams && relations.workstreams.length > 0
      ? relations.workstreams
      : asStrArray(spec.workstreams).map((id) => ({ id, title: id }));

  // Family: prefer the injected tree; degrade to a single-node tree (this topic
  // only) so a direct render or an offline path still shows a sensible section.
  const family: FamilyNode[] =
    relations.family && relations.family.length > 0
      ? relations.family
      : [
          {
            id: env.metadata.id,
            title,
            isCurrent: true,
            children: [],
          },
        ];
  const familyOut: string[] = [];
  familyLines(family, 0, familyOut);

  const lines: string[] = [
    `# Topic: ${title}`,
    '',
    ...metadataSection(env, [
      `- \`status\`: ${status}`,
      topicType ? `- \`topicType\`: [${topicType}](${deepLink('topic-type', topicType)})` : '- `topicType`: _none_',
    ]),
    '',
    body ?? '_Empty body._',
    '',
    '## Workstreams',
    '',
    workstreamLinks.length > 0
      ? workstreamLinks
          .map((w) => `- [${w.title}](${deepLink('workstream', w.id)})`)
          .join('\n')
      : '_none_',
    '',
    '## Family',
    '',
    ...familyOut,
    '',
  ];

  if (alerts.length > 0) {
    const thisId = env.metadata.id;
    lines.push('## Agent messages', '');
    const blocks = alerts.map((alert) => {
      // Alerts have no id (always null), so deep-link by id.
      const link = deepLink('agent-message', alert.id);
      const iconName =
        alert.status === 'open' && alert.attention
          ? 'bell'
          : alert.status === 'open'
            ? 'info'
            : 'pass';
      // Colored codicon via inline style only — the markdown preview keeps the
      // glyph + color but strips CSS class styling. Red bell for active alerts;
      // text-bottom keeps the glyph on the text baseline.
      const color = alert.severity === 'error' ? 'color:#f14c4c;' : '';
      const icon = `<span class="codicon codicon-${iconName}" style="${color}vertical-align:text-bottom"></span>`;
      const title =
        alert.title.trim() ||
        alert.description.split('\n')[0] ||
        `Agent message ${alert.id}`;
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
      const others = asStrArray(alert.topics).filter((t) => t !== thisId);
      if (others.length) {
        const shown = others
          .slice(0, 3)
          .map((t) => `[${t}](${deepLink('topic', t)})`);
        const more = others.length > 3 ? ' …' : '';
        alertLines.push(`Other topics: ${shown.join(', ')}${more}`);
      }
      return alertLines.join('  \n');
    });
    lines.push(blocks.join('\n\n'), '');
  }

  return lines.join('\n');
}
