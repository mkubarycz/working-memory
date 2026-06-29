import { JournalStore } from '../db';
import { AlertsStore } from '../alerts/store';
import type { AlertStatus } from '../alerts/types';
import { deepLink, fmtDateTime } from './shared';

const STATUS_LABEL: Record<AlertStatus, string> = {
  alert: '🔴 Alert',
  informational: '⚪ Informational',
  closed: '✔️ Closed',
};

/** A single alert virtual doc: `working-memory:/alert/<id>.md`. Read-only — */
/* editing routes through panel commands that call wm_update_alert. */
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

  return [
    `# Alert #${alert.id}`,
    '',
    `- **Status:** ${STATUS_LABEL[alert.status] ?? alert.status}`,
    `- **Raised by:** \`${alert.created_by}\``,
    `- **Created:** ${fmtDateTime(alert.created_at)}`,
    `- **Updated:** ${fmtDateTime(alert.updated_at)}`,
    '',
    '---',
    '',
    '## Description',
    '',
    alert.description.trim().length ? alert.description : '_(none)_',
    '',
    '## Recommended action',
    '',
    alert.recommended_action.trim().length
      ? alert.recommended_action
      : '_(none)_',
    '',
    '## Associated topics',
    '',
    topicsBlock,
    '',
    '---',
    '',
    '_This doc is read-only. Use the Alerts panel actions (⋯) to edit_',
    '_description / recommended action / status, which call `wm_update_alert`._',
    '',
  ].join('\n');
}
