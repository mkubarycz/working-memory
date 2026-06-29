import { JournalStore, type TopicEntryLink } from '../db';
import { AlertsStore } from '../alerts/store';
import {
  alertActionLink,
  buildTopicBreadcrumb,
  deepLink,
  EDITABLE_DESCRIPTION_COMMENT_END,
  EDITABLE_DESCRIPTION_COMMENT_START,
  fmtDateTime,
  fmtRelative,
} from './shared';

export function renderTopicDoc(store: JournalStore, slug: string): string {
  const topic = store.getTopic(slug);
  if (!topic) {
    return `# Topic not found\n\nNo topic with slug \`${slug}\`.\n\n_Tip: use the \`wm_create_topic\` tool to create it._\n`;
  }
  const workstreams = store.listWorkstreamsForTopic(slug);
  const entries = store.listEntriesForTopic(slug, 25);

  const typeLabels = new Map<string, string>(
    store.listTopicTypes().map((t) => [t.id, t.label]),
  );
  const typeLabel =
    typeLabels.get(topic.topic_type) ??
    `${topic.topic_type} _(unknown type)_`;
  const topicTypeUri = deepLink('topic-type', topic.topic_type);

  const wsBlock = workstreams.length
    ? workstreams
        .map(
          (w) =>
            `- [${w.workstream_title}](${deepLink('workstream', w.workstream_slug)}) \`${w.workstream_slug}\` — linked ${fmtDateTime(w.linked_at)}`,
        )
        .join('\n')
    : '_No workstreams linked yet._';

  const byWs = new Map<string, { title: string; rows: TopicEntryLink[] }>();
  for (const e of entries) {
    const key = e.workstream_slug;
    if (!byWs.has(key)) {
      byWs.set(key, { title: e.workstream_title, rows: [] });
    }
    byWs.get(key)!.rows.push(e);
  }
  const entriesBlock = entries.length
    ? Array.from(byWs.entries())
        .map(([wsSlug, { title, rows }]) => {
          const lines = rows
            .map(
              (e) =>
                `- \`${fmtDateTime(e.timestamp)}\` [#${e.entry_id}](${deepLink('workstream', wsSlug)}) ${e.snippet}`,
            )
            .join('\n');
          return `### [${title}](${deepLink('workstream', wsSlug)}) \`${wsSlug}\`\n\n<div class="wm-entries">\n\n${lines}\n\n</div>`;
        })
        .join('\n\n')
    : '_No entries linked yet._';

  const breadcrumb = buildTopicBreadcrumb(store, slug);

  const alerts = new AlertsStore(store.connection).topicAlertsWithRecentClosed(slug);
  const alertsBlock = alerts.length
    ? alerts
        .map((a) => {
          const link = deepLink('alert', String(a.id));
          const iconName =
            a.status === 'alert'
              ? 'bell'
              : a.status === 'informational'
                ? 'info'
                : 'pass';
          // Colored codicon via inline style only — the markdown preview keeps
          // the glyph and color but strips any CSS class styling, so no wrapper
          // divs / .wm-alert rules. Red bell for active alerts; text-bottom keeps
          // it on the text baseline instead of riding high.
          const color = a.status === 'alert' ? 'color:#f14c4c;' : '';
          const icon = `<span class="codicon codicon-${iconName}" style="${color}vertical-align:text-bottom"></span>`;
          const title = a.title.trim() || a.description.split('\n')[0] || `Alert #${a.id}`;
          const desc = a.description.trim();
          const next = a.recommended_action.trim();
          const lines = [
            `[${icon}](${link}) **[${title}](${link})** — ${fmtDateTime(a.updated_at)} (${fmtRelative(a.updated_at)})`,
          ];
          if (desc) {
            lines.push(desc);
          }
          if (next) {
            lines.push(`Next: ${next}`);
          }
          if (a.topics.length) {
            const others = a.topics.filter((t) => t !== slug);
            if (others.length) {
              const shown = others
                .slice(0, 3)
                .map((t) => `[${t}](${deepLink('topic', t)})`);
              const more = others.length > 3 ? ' …' : '';
              lines.push(`Other topics: ${shown.join(', ')}${more}`);
            }
          }
          if (a.status !== 'closed') {
            const actions: string[] = [];
            if (a.status !== 'informational') {
              actions.push(`[Acknowledge](${alertActionLink(a.id, 'acknowledge')})`);
            } else {
              actions.push(`[Escalate](${alertActionLink(a.id, 'reopen')})`);
            }
            actions.push(`[Close](${alertActionLink(a.id, 'close')})`);
            lines.push(actions.join(' · '));
          } else {
            lines.push(
              [
                `[Reopen (Alert)](${alertActionLink(a.id, 'reopen')})`,
                `[Reopen (Information)](${alertActionLink(a.id, 'acknowledge')})`,
              ].join(' · '),
            );
          }
          return lines.join('  \n');
        })
        .join('\n\n')
    : '_No active alerts._';

  return [
    `# ${topic.title}`,
    '',
    `- **Slug:** \`${topic.slug}\``,
    `- **Type:** [${typeLabel}](${topicTypeUri})`,
    `- **Status:** ${topic.status}`,
    `- **Family:** ${breadcrumb}`,
    `- **Created:** ${fmtDateTime(topic.created_at)}`,
    `- **Updated:** ${fmtDateTime(topic.updated_at)}`,
    '',
    '## Alerts',
    '',
    alertsBlock,
    '',
    '## Description',
    '',
    EDITABLE_DESCRIPTION_COMMENT_START,
    topic.body.trim().length
      ? topic.body
      : '_Empty body — write something here, then save (⌘S)._',
    EDITABLE_DESCRIPTION_COMMENT_END,
    '',
    '## Linked workstreams',
    '',
    wsBlock,
    '',
    '## Recent entries',
    '',
    entriesBlock,
    '',
  ].join('\n');
}
