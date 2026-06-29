import { JournalStore, type TopicEntryLink } from '../db';
import { AlertsStore } from '../alerts/store';
import { buildTopicBreadcrumb, deepLink, fmtDateTime } from './shared';

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
          const badge =
            a.status === 'alert'
              ? '🔴'
              : a.status === 'informational'
                ? '⚪'
                : '✔️';
          const desc = a.description.split('\n')[0];
          return `- ${badge} [#${a.id}](${deepLink('alert', String(a.id))}) ${desc} — ${a.status}, updated ${fmtDateTime(a.updated_at)}`;
        })
        .join('\n')
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
    '---',
    '',
    '## Alerts',
    '',
    alertsBlock,
    '',
    '---',
    '',
    topic.body.trim().length
      ? topic.body
      : '_Empty body — write something here, then save (⌘S)._',
    '',
    '---',
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
