import { JournalStore } from '../db';
import { deepLink, fmtDateTime } from './shared';
import { renderSession } from './sessionDoc';

export function renderWorkstreamDoc(store: JournalStore, slug: string): string {
  const ws = store.getWorkstreamBySlug(slug);
  if (!ws) {
    return `# Workstream not found\n\nNo workstream with slug \`${slug}\`.`;
  }
  const topics = store.listTopicsForWorkstream(ws.id);
  const topicsBlock = topics.length
    ? topics
        .map((t) => {
          const here = t.entry_count_in_workstream;
          const elsewhere = t.entry_count - here;
          const parts: string[] = [];
          if (here > 0) {
            parts.push(`${here} entr${here === 1 ? 'y' : 'ies'} here`);
          }
          if (elsewhere > 0) {
            parts.push(`${elsewhere} elsewhere`);
          }
          if (t.status !== 'open') {
            parts.push(`_${t.status}_`);
          }
          const meta = parts.length ? ` — ${parts.join(' • ')}` : '';
          return `- [${t.title}](${deepLink('topic', t.slug)}) \`${t.slug}\`${meta}`;
        })
        .join('\n')
    : '_No topics linked yet._';

  const sessions = store.listSessionsForWorkstream(ws.id);
  const sessionsBlock = sessions.length
    ? sessions.map((s) => renderSession(store, s)).join('\n\n')
    : '_No sessions logged yet._';

  return [
    `# ${ws.title}`,
    '',
    `- **Slug:** \`${ws.slug}\``,
    `- **Status:** ${ws.status}`,
    `- **Opened:** ${fmtDateTime(ws.opened_at)}`,
    `- **Closed:** ${fmtDateTime(ws.closed_at)}`,
    `- **Closure:** ${ws.closure?.trim() ? ws.closure.trim() : '—'}`,
    '',
    '---',
    '',
    '## Topics',
    '',
    topicsBlock,
    '',
    '---',
    '',
    '## Sessions',
    '',
    sessionsBlock,
    '',
  ].join('\n');
}
