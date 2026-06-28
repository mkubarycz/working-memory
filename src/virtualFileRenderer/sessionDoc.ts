import { JournalStore, type Session } from '../db';
import { deepLink, fmtDateTime, fmtDuration, topicPill } from './shared';

export function renderSession(store: JournalStore, session: Session): string {
  const header = `### [${session.session_id}](${deepLink('session', session.session_id)}) — ${fmtDateTime(session.started_at)}`;
  const summary = session.summary?.trim()
    ? session.summary.trim()
    : '_No summary._';
  const entries = store.listEntriesForSession(session.session_id).slice().reverse();
  const entryLines = entries.length
    ? `<div class="wm-entries">\n\n` +
      entries
        .map((e) => {
          const tags = store.listTopicsForEntry(e.id);
          const tagsSuffix = tags.length
            ? ` — _${tags.map(topicPill).join(' · ')}_`
            : '';
          return `- \`${fmtDateTime(e.timestamp)}\` (${e.created_by}) ${e.body}${tagsSuffix}`;
        })
        .join('\n') +
      `\n\n</div>`
    : '_No entries._';
  return `${header}\n${summary}\n\n${entryLines}`;
}

export function renderSessionDoc(
  store: JournalStore,
  sessionId: string,
): string {
  const liveSession = store.getSession(sessionId, false);
  const session = liveSession ?? store.getSession(sessionId, true);

  if (!session) {
    return [
      '# Session not found',
      '',
      `No session with id \`${sessionId}\`.`,
      '',
      '_Tip: check the workstream doc for the current list of sessions._',
      '',
    ].join('\n');
  }

  if (session.deleted_at !== null) {
    return [
      '# Session deleted',
      '',
      `Session \`${sessionId}\` was soft-deleted at ${fmtDateTime(session.deleted_at)}.`,
      '',
      '_Soft-deleted sessions are hidden from normal listings. To inspect_',
      '_one, query the DB directly._',
      '',
    ].join('\n');
  }

  const ws = store.getWorkstreamById(session.workstream_id, true);
  const wsHeader = ws
    ? `[${ws.title}](${deepLink('workstream', ws.slug)}) \`${ws.slug}\``
    : `_(unknown workstream id ${session.workstream_id})_`;

  const durationStr = fmtDuration(session.started_at, session.ended_at);
  const durationLine = session.ended_at
    ? `- **Duration:** ${durationStr ?? '—'}`
    : `- **Duration:** _(in progress)_`;

  const chatLine = session.chat_ref
    ? `- **Chat:** \`${session.chat_ref}\``
    : `- **Chat:** _(no chat link recorded)_`;

  const entries = store.listEntriesForSession(session.session_id);
  const sessionTopics = store.listTopicsForSession(session.session_id);

  const summary = session.summary?.trim()
    ? session.summary.trim()
    : '_No summary._';

  const topicsBlock = sessionTopics.length
    ? sessionTopics
        .map(
          (t) =>
            `- [${t.title}](${deepLink('topic', t.slug)}) \`${t.slug}\``,
        )
        .join('\n')
    : '_No topics tagged on entries in this session._';

  const entriesBlock = entries.length
    ? `<div class="wm-entries">\n\n` +
      entries
        .slice()
        .reverse()
        .map((e) => {
          const tags = store.listTopicsForEntry(e.id);
          const tagsSuffix = tags.length
            ? ` — _${tags.map(topicPill).join(' · ')}_`
            : '';
          return `- \`${fmtDateTime(e.timestamp)}\` (${e.created_by}) ${e.body}${tagsSuffix}`;
        })
        .join('\n') +
      `\n\n</div>`
    : '_No entries._';

  const prev = ws
    ? store.getPreviousSessionInWorkstream(
        ws.id,
        session.started_at,
        session.session_id,
      )
    : null;
  const next = ws
    ? store.getNextSessionInWorkstream(
        ws.id,
        session.started_at,
        session.session_id,
      )
    : null;
  const prevStr = prev
    ? `[${fmtDateTime(prev.started_at)}](${deepLink('session', prev.session_id)})`
    : '—';
  const nextStr = next
    ? `[${fmtDateTime(next.started_at)}](${deepLink('session', next.session_id)})`
    : '—';

  return [
    `# Session ${session.session_id}`,
    '',
    `- **Workstream:** ${wsHeader}`,
    `- **Session id:** \`${session.session_id}\``,
    `- **Started:** ${fmtDateTime(session.started_at)}`,
    `- **Ended:** ${fmtDateTime(session.ended_at)}`,
    durationLine,
    chatLine,
    `- **Entries:** ${entries.length}`,
    '',
    '## Summary',
    '',
    summary,
    '',
    '## Linked topics',
    '',
    topicsBlock,
    '',
    '## Entries',
    '',
    entriesBlock,
    '',
    '---',
    '',
    `**Prev session:** ${prevStr}   ·   **Next session:** ${nextStr}`,
    '',
  ].join('\n');
}
