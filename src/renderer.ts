import {
  JournalStore,
  type Session,
  type Topic,
  type TopicEntryLink,
  type TopicStatus,
} from './db';

const TZ = 'America/New_York';

export const EDITABLE_DIV_OPEN =
  '<div style="border-left: 5px solid green; padding-left: 15px;">';
export const EDITABLE_DIV_CLOSE = '</div>';
export const EDITABLE_COMMENT_START = '<!-- editable -->';
export const EDITABLE_COMMENT_END = '<!-- /editable -->';
export const EDITABLE_LABEL_COMMENT_START = '<!-- editable:label -->';
export const EDITABLE_LABEL_COMMENT_END = '<!-- /editable:label -->';
export const EDITABLE_DESCRIPTION_COMMENT_START = '<!-- editable:description -->';
export const EDITABLE_DESCRIPTION_COMMENT_END = '<!-- /editable:description -->';
export const DESCRIPTION_EMPTY_PLACEHOLDER = '—';

export function deepLink(
  kind: 'topic' | 'session' | 'workstream' | 'topic-type',
  id: string,
): string {
  return `vscode://kubarycz.working-memory/open/${kind}/${encodeURIComponent(id)}`;
}

export function fmtDateTime(unixSeconds: number | null | undefined): string {
  if (!unixSeconds) {
    return '—';
  }
  const d = new Date(unixSeconds * 1000);
  const date = d.toLocaleDateString('en-CA', { timeZone: TZ });
  const time = d.toLocaleTimeString('en-GB', {
    timeZone: TZ,
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  });
  return `${date} ${time}`;
}

function fmtDuration(
  startedAt: number | null | undefined,
  endedAt: number | null | undefined,
): string | null {
  if (!startedAt || !endedAt || endedAt < startedAt) {
    return null;
  }
  const totalSec = endedAt - startedAt;
  const h = Math.floor(totalSec / 3600);
  const m = Math.floor((totalSec % 3600) / 60);
  const s = totalSec % 60;
  const parts: string[] = [];
  if (h > 0) {
    parts.push(`${h}h`);
  }
  if (m > 0 || h > 0) {
    parts.push(`${m}m`);
  }
  parts.push(`${s}s`);
  return parts.join(' ');
}

type BreadcrumbNode = { slug: string; title: string; status: TopicStatus };

function fmtBreadcrumbNode(node: BreadcrumbNode): string {
  const link = deepLink('topic', node.slug);
  if (node.status === 'closed') {
    return `~~[${node.title}](${link})~~`;
  }
  return `[${node.title}](${link})`;
}

/**
 * Build the breadcrumb family trail for a topic virtual doc.
 *
 * Walks up the first-parent chain to collect ancestors, then down the
 * first-child chain to collect descendants.  Returns `'Orphan'` when the
 * topic has no family.  A visited set guards against cycles in the DAG.
 */
export function buildTopicBreadcrumb(
  store: JournalStore,
  slug: string,
): string {
  const current = store.getTopic(slug);
  if (!current) {
    return 'Orphan';
  }

  // ── Ancestor walk (up via first parent at each level) ───────────────────
  const ancestors: BreadcrumbNode[] = [];
  let cursor = slug;
  const visitedUp = new Set<string>([slug]);
  while (true) {
    const parents = store.listTopicParents(cursor);
    if (parents.length === 0) {
      break;
    }
    const parent = parents[0];
    if (visitedUp.has(parent.slug)) {
      break; // cycle guard
    }
    visitedUp.add(parent.slug);
    ancestors.unshift({ slug: parent.slug, title: parent.title, status: parent.status });
    cursor = parent.slug;
  }

  // ── Descendant walk (down via first child at each level) ─────────────────
  const descendants: BreadcrumbNode[] = [];
  cursor = slug;
  const visitedDown = new Set<string>([slug]);
  while (true) {
    const children = store.listTopicChildren(cursor);
    if (children.length === 0) {
      break;
    }
    const child = children[0];
    if (visitedDown.has(child.slug)) {
      break; // cycle guard
    }
    visitedDown.add(child.slug);
    descendants.push({ slug: child.slug, title: child.title, status: child.status });
    cursor = child.slug;
  }

  if (ancestors.length === 0 && descendants.length === 0) {
    return 'Orphan';
  }

  const currentLabel = `**${current.title}**`;

  const parts = [
    ...ancestors.map(fmtBreadcrumbNode),
    currentLabel,
    ...descendants.map(fmtBreadcrumbNode),
  ];

  return parts.join(' > ');
}

function topicPill(t: Topic): string {
  return `[${t.title}](${deepLink('topic', t.slug)})`;
}

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

export function renderTopicTypeDoc(store: JournalStore, id: string): string {
  const topicType = store.getTopicType(id);
  if (!topicType) {
    return `# Topic type not found\n\nNo topic type with id \`${id}\`.`;
  }
  const recentTopics = store
    .listTopics({ status: 'open', topicType: id })
    .slice()
    .sort((a, b) => b.updated_at - a.updated_at || a.slug.localeCompare(b.slug))
    .slice(0, 25);
  const recentBlock = recentTopics.length
    ? recentTopics
        .map(
          (topic) =>
            `- [${topic.title}](${deepLink('topic', topic.slug)}) \`${topic.slug}\` — updated ${fmtDateTime(topic.updated_at)}`,
        )
        .join('\n')
    : '_No open topics of this type._';

  const bodyTemplatePlaceholder =
    '_No body template — add one here, then save (⌘S)._';
  const bodyTemplateContent = topicType.body_template.trim()
    ? topicType.body_template
    : bodyTemplatePlaceholder;

  return [
    `# ${topicType.label} \`${topicType.id}\``,
    '',
    `- **Icon:** \`${topicType.icon}\``,
    `- **Id:** \`${topicType.id}\``,
    `- **Created:** ${fmtDateTime(topicType.created_at)}`,
    `- **Updated:** ${fmtDateTime(topicType.updated_at)}`,
    `- **Topics using this type:** ${topicType.topic_count}`,
    '',
    '## Label',
    '',
    EDITABLE_DIV_OPEN,
    EDITABLE_LABEL_COMMENT_START,
    '',
    topicType.label,
    '',
    EDITABLE_LABEL_COMMENT_END,
    EDITABLE_DIV_CLOSE,
    '',
    '## Description',
    '',
    EDITABLE_DIV_OPEN,
    EDITABLE_DESCRIPTION_COMMENT_START,
    '',
    topicType.description.trim() || DESCRIPTION_EMPTY_PLACEHOLDER,
    '',
    EDITABLE_DESCRIPTION_COMMENT_END,
    EDITABLE_DIV_CLOSE,
    '',
    '## Content Template',
    '',
    EDITABLE_DIV_OPEN,
    EDITABLE_COMMENT_START,
    '',
    bodyTemplateContent,
    '',
    EDITABLE_COMMENT_END,
    EDITABLE_DIV_CLOSE,
    '',
    '## Recent topics',
    '',
    recentBlock,
    '',
  ].join('\n');
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

export function extractTopicBody(full: string): string {
  const lines = full.split(/\r?\n/);
  const fenceIdxs: number[] = [];
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].trim() === '---') {
      fenceIdxs.push(i);
      if (fenceIdxs.length === 2) {
        break;
      }
    }
  }
  if (fenceIdxs.length < 2) {
    throw new Error(
      'topic doc is missing the two `---` body fences — refusing to save',
    );
  }
  const body = lines
    .slice(fenceIdxs[0] + 1, fenceIdxs[1])
    .join('\n')
    .replace(/^\s*\n+/, '')
    .replace(/\n+\s*$/, '');
  const placeholder = '_Empty body — write something here, then save (⌘S)._';
  if (body.trim() === placeholder) {
    return '';
  }
  return body;
}

export function extractTopicTypeBodyTemplate(full: string): string {
  const lines = full.split(/\r?\n/);
  let openIdx = -1;
  let closeIdx = -1;
  for (let i = 0; i < lines.length; i++) {
    if (openIdx === -1 && lines[i].trim() === EDITABLE_COMMENT_START) {
      openIdx = i;
    } else if (openIdx !== -1 && lines[i].trim() === EDITABLE_COMMENT_END) {
      closeIdx = i;
      break;
    }
  }
  if (openIdx === -1 || closeIdx === -1) {
    throw new Error(
      'topic-type doc is missing the editable comment markers — refusing to save',
    );
  }
  const template = lines
    .slice(openIdx + 1, closeIdx)
    .join('\n')
    .replace(/^\s*\n+/, '')
    .replace(/\n+\s*$/, '');
  const placeholder = '_No body template — add one here, then save (⌘S)._';
  if (template.trim() === placeholder) {
    return '';
  }
  return template;
}

export function extractTopicTypeLabel(full: string): string {
  const lines = full.split(/\r?\n/);
  let openIdx = -1;
  let closeIdx = -1;
  for (let i = 0; i < lines.length; i++) {
    if (openIdx === -1 && lines[i].trim() === EDITABLE_LABEL_COMMENT_START) {
      openIdx = i;
    } else if (openIdx !== -1 && lines[i].trim() === EDITABLE_LABEL_COMMENT_END) {
      closeIdx = i;
      break;
    }
  }
  if (openIdx === -1 || closeIdx === -1) {
    throw new Error(
      'topic-type doc is missing the label editable comment markers — refusing to save',
    );
  }
  return lines
    .slice(openIdx + 1, closeIdx)
    .join('\n')
    .replace(/^\s*\n+/, '')
    .replace(/\n+\s*$/, '');
}

export function extractTopicTypeDescription(full: string): string {
  const lines = full.split(/\r?\n/);
  let openIdx = -1;
  let closeIdx = -1;
  for (let i = 0; i < lines.length; i++) {
    if (openIdx === -1 && lines[i].trim() === EDITABLE_DESCRIPTION_COMMENT_START) {
      openIdx = i;
    } else if (openIdx !== -1 && lines[i].trim() === EDITABLE_DESCRIPTION_COMMENT_END) {
      closeIdx = i;
      break;
    }
  }
  if (openIdx === -1 || closeIdx === -1) {
    throw new Error(
      'topic-type doc is missing the description editable comment markers — refusing to save',
    );
  }
  const value = lines
    .slice(openIdx + 1, closeIdx)
    .join('\n')
    .replace(/^\s*\n+/, '')
    .replace(/\n+\s*$/, '');
  const placeholder = DESCRIPTION_EMPTY_PLACEHOLDER;
  if (value.trim() === placeholder) {
    return '';
  }
  return value;
}
