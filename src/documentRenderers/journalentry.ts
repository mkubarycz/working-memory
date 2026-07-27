/**
 * Per-kind renderer for a control-plane `JournalEntry` document envelope → rich
 * markdown. Pure function of the envelope (no journal store, no VS Code).
 *
 * JournalEntry carries the richest ref set: `spec.workstream` (owning
 * workstream → workstream link), `spec.session` (optional grouping → session
 * link), and `spec.topics[]` (→ topic links). Missing / foreign-shaped fields
 * render `_none_`; the session link is omitted when absent.
 */

import type { DocumentEnvelope } from '../controlPlaneClient';
import {
  asStr,
  asStrArray,
  deepLink,
  linkList,
  metadataSection,
} from './shared';

export function renderJournalEntryDocument(env: DocumentEnvelope): string {
  const spec = env.spec ?? {};
  const body = asStr(spec.body);
  const workstream = asStr(spec.workstream);
  const session = asStr(spec.session);
  const createdBy = asStr(spec.createdBy) ?? 'system';
  const topics = asStrArray(spec.topics);

  const firstLine = body?.split('\n')[0] ?? `Entry ${env.metadata.id}`;
  const heading =
    firstLine.length > 80 ? `${firstLine.slice(0, 77)}…` : firstLine;

  const lines: string[] = [
    `# JournalEntry: ${heading}`,
    '',
    ...metadataSection(env, [`- \`createdBy\`: ${createdBy}`]),
    '',
    '## Body',
    '',
    body ?? '_none_',
    '',
    '## Workstream',
    '',
    workstream
      ? `- [${workstream}](${deepLink('workstream', workstream)})`
      : '_none_',
    '',
    '## Session',
    '',
    session ? `- [${session}](${deepLink('session', session)})` : '_none_',
    '',
    '## Topics',
    '',
    linkList('topic', topics),
    '',
  ];
  return lines.join('\n');
}
