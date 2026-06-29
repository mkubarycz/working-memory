import { JournalStore } from '../db';
import { AlertsStore } from '../alerts/store';
import type { AlertStatus } from '../alerts/types';
import {
  DESCRIPTION_EMPTY_PLACEHOLDER,
  EDITABLE_ACTION_COMMENT_END,
  EDITABLE_ACTION_COMMENT_START,
  EDITABLE_DESCRIPTION_COMMENT_END,
  EDITABLE_DESCRIPTION_COMMENT_START,
  EDITABLE_DIV_CLOSE,
  EDITABLE_DIV_OPEN,
  EDITABLE_LABEL_COMMENT_END,
  EDITABLE_LABEL_COMMENT_START,
  EDITABLE_STATUS_COMMENT_END,
  EDITABLE_STATUS_COMMENT_START,
  alertActionLink,
  deepLink,
  fmtDateTime,
} from './shared';

const STATUS_LABEL: Record<AlertStatus, string> = {
  alert: '<span class="codicon codicon-bell" style="color:#f14c4c;vertical-align:text-bottom"></span> Alert',
  informational: '<span class="codicon codicon-info" style="vertical-align:text-bottom"></span> Informational',
  closed: '<span class="codicon codicon-pass" style="vertical-align:text-bottom"></span> Closed',
};

/**
 * A single alert virtual doc: `working-memory:/alert/<id>.md`. Writable —
 * description, recommended action, and status live in editable regions and
 * persist via `AlertsStore.updateAlert()` on save (mirrors topic-type docs).
 * Associated topics stay read-only (edit links via tools).
 */
export function renderAlertDoc(store: JournalStore, idStr: string): string {
  const id = Number(idStr);
  if (!Number.isInteger(id) || id <= 0) {
    return `# Alert not found\n\nNo alert with id \`${idStr}\`.\n`;
  }
  const alerts = new AlertsStore(store.connection);
  const alert = alerts.getAlert(id);
  if (!alert) {
    return `# Alert not found\n\nNo alert with id \`${id}\`.\n`;
  }

  const topicsBlock = alert.topics.length
    ? alert.topics
        .map((slug) => `- [${slug}](${deepLink('topic', slug)})`)
        .join('\n')
    : '_No topics linked._';

  const reopenBlock =
    alert.status === 'closed'
      ? [
          [
            `[Reopen (Alert)](${alertActionLink(alert.id, 'reopen')})`,
            `[Reopen (Information)](${alertActionLink(alert.id, 'acknowledge')})`,
          ].join(' · '),
          '',
        ]
      : alert.status === 'informational'
        ? [
            [
              `[Escalate](${alertActionLink(alert.id, 'reopen')})`,
              `[Close](${alertActionLink(alert.id, 'close')})`,
            ].join(' · '),
            '',
          ]
        : [];

  // Status picker: each status is a clickable deep link except the current one,
  // which is shown in bold as the active selection.
  const STATUS_ACTION: Record<AlertStatus, 'reopen' | 'acknowledge' | 'close'> = {
    alert: 'reopen',
    informational: 'acknowledge',
    closed: 'close',
  };
  const statusPicker = (['alert', 'informational', 'closed'] as AlertStatus[])
    .map((s) =>
      s === alert.status
        ? `**${s}**`
        : `[${s}](${alertActionLink(alert.id, STATUS_ACTION[s])})`,
    )
    .join(' · ');

  return [
    `# ${alert.title.trim() || `Alert #${alert.id}`}`,
    '',
    `- **Id:** \`#${alert.id}\``,
    `- **Status:** ${STATUS_LABEL[alert.status] ?? alert.status}`,
    `- **Raised by:** \`${alert.created_by}\``,
    `- **Created:** ${fmtDateTime(alert.created_at)}`,
    `- **Updated:** ${fmtDateTime(alert.updated_at)}`,
    '',
    ...reopenBlock,
    '## Title',
    '',
    EDITABLE_DIV_OPEN,
    EDITABLE_LABEL_COMMENT_START,
    '',
    alert.title.trim() || DESCRIPTION_EMPTY_PLACEHOLDER,
    '',
    EDITABLE_LABEL_COMMENT_END,
    EDITABLE_DIV_CLOSE,
    '',
    '## Status',
    '',
    statusPicker,
    '',
    EDITABLE_DIV_OPEN,
    EDITABLE_STATUS_COMMENT_START,
    '',
    alert.status,
    '',
    EDITABLE_STATUS_COMMENT_END,
    EDITABLE_DIV_CLOSE,
    '',
    '## Description',
    '',
    EDITABLE_DIV_OPEN,
    EDITABLE_DESCRIPTION_COMMENT_START,
    '',
    alert.description.trim() || DESCRIPTION_EMPTY_PLACEHOLDER,
    '',
    EDITABLE_DESCRIPTION_COMMENT_END,
    EDITABLE_DIV_CLOSE,
    '',
    '## Recommended action',
    '',
    EDITABLE_DIV_OPEN,
    EDITABLE_ACTION_COMMENT_START,
    '',
    alert.recommended_action.trim() || DESCRIPTION_EMPTY_PLACEHOLDER,
    '',
    EDITABLE_ACTION_COMMENT_END,
    EDITABLE_DIV_CLOSE,
    '',
    '## Associated topics',
    '',
    topicsBlock,
    '',
  ].join('\n');
}
