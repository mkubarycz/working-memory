import type { Store } from './store.js';

export const REMINDER_SWEEP_INTERVAL_MS = 1000;

export function activateDueReminders(store: Store): number {
  const now = Math.floor(Date.now() / 1000);
  const rows = store.db.prepare(`SELECT id FROM resources
    WHERE kind = 'AgentMessage' AND deleted_at IS NULL
      AND json_extract(spec, '$.category') = 'reminder'
      AND json_extract(spec, '$.status') = 'open'
      AND json_extract(spec, '$.due_at') <= ?
      AND json_extract(spec, '$.attention') = 0`).all(now);
  for (const row of rows) {
    if (typeof row.id !== 'string') throw new Error('Invalid reminder document ID.');
    const document = store.getDocument({ id: row.id });
    if (!document) throw new Error(`Due reminder disappeared: ${row.id}`);
    store.updateDocument({
      id: document.metadata.id,
      expectedResourceVersion: document.metadata.resourceVersion,
      spec: document.spec,
    });
  }
  return rows.length;
}
