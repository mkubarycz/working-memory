import { JournalStore } from '../db';
import { NanitesStore } from '../nanites/store';
import type { NaniteRun } from '../nanites/types';
import {
  EDITABLE_INSTRUCTIONS_COMMENT_END,
  EDITABLE_INSTRUCTIONS_COMMENT_START,
  deepLink,
  fmtDateTime,
  fmtDuration,
  fmtRelative,
} from './shared';

const RUN_STATUS_ICON: Record<NaniteRun['status'], string> = {
  pending: 'circle-outline',
  running: 'sync',
  succeeded: 'pass',
  failed: 'error',
};

function renderRun(run: NaniteRun): string {
  const icon = RUN_STATUS_ICON[run.status] ?? 'circle-outline';
  const when = run.started_at ?? run.created_at;
  const duration = fmtDuration(run.started_at, run.ended_at);
  const label = [
    `<span class="codicon codicon-${icon}" style="vertical-align:text-bottom"></span> **${run.status}**`,
    `#${run.id}`,
    fmtDateTime(when),
    `(${fmtRelative(when)})`,
  ];
  if (duration) {
    label.push(`— ${duration}`);
  }
  const link = `[${label.join(' ')}](${deepLink('nanite-run', String(run.id))})`;
  const lines = [`- ${link}`];
  if (run.error) {
    lines.push(`  - error: ${run.error}`);
  }
  return lines.join('\n');
}

/**
 * Render the read-mostly nanite virtual doc. The metadata + run trail render
 * fresh from the DB on every read; the **Instructions** section sits inside an
 * editable comment-marker region (mirrors the topic doc's editable Description)
 * so saving the doc persists the playbook via `NanitesStore.updateNanite`.
 * All other fields (title, kind, trigger phrase, model, tool allow-list,
 * enabled) are edited through the `wm_update_nanite` tool.
 */
export function renderNaniteDoc(store: JournalStore, slug: string): string {
  const nanites = new NanitesStore(store.connection);
  const nanite = nanites.getNaniteBySlug(slug, true);
  if (!nanite) {
    return `# Nanite not found\n\nNo nanite with slug \`${slug}\`.\n\n_Tip: use the \`wm_create_nanite\` tool to create it._\n`;
  }

  const runs = nanites.listRuns(nanite.id, 10);
  const runsBlock = runs.length
    ? runs.map(renderRun).join('\n')
    : '_No runs yet._';

  const allowlistBlock = nanite.tool_allowlist.length
    ? nanite.tool_allowlist.map((t) => `- \`${t}\``).join('\n')
    : '_No tools allow-listed — the nanite can call nothing._';

  const trigger = nanite.trigger_phrase.trim()
    ? `\`${nanite.trigger_phrase.trim()}\``
    : '_none_';

  return [
    `# ${nanite.title}`,
    '',
    `- **Slug:** \`${nanite.slug}\``,
    `- **Kind:** ${nanite.kind}`,
    `- **Enabled:** ${nanite.enabled ? 'yes' : 'no'}`,
    `- **Trigger phrase:** ${trigger}`,
    `- **Model:** ${nanite.model ? `\`${nanite.model}\`` : '_(runner default)_'}`,
    `- **Acceptance threshold:** ${nanite.acceptance_threshold} / 100`,
    `- **Created:** ${fmtDateTime(nanite.created_at)}`,
    `- **Updated:** ${fmtDateTime(nanite.updated_at)}`,
    nanite.deleted_at ? `- **Deleted:** ${fmtDateTime(nanite.deleted_at)}` : null,
    '',
    '_Metadata (title, kind, trigger phrase, model, tool allow-list, enabled)_',
    '_is edited via the `wm_update_nanite` tool. The Instructions below are_',
    '_editable here — edit and save (⌘S)._',
    '',
    '## Acceptance criteria',
    '',
    nanite.acceptance_criteria.trim().length
      ? nanite.acceptance_criteria
      : '_No acceptance criteria set._',
    '',
    '## Tool allow-list',
    '',
    allowlistBlock,
    '',
    '## Instructions',
    '',
    EDITABLE_INSTRUCTIONS_COMMENT_START,
    nanite.instructions.trim().length
      ? nanite.instructions
      : '_No instructions yet — write the nanite playbook here, then save (⌘S)._',
    EDITABLE_INSTRUCTIONS_COMMENT_END,
    '',
    '## Recent runs',
    '',
    runsBlock,
    '',
  ]
    .filter((line): line is string => line !== null)
    .join('\n');
}
