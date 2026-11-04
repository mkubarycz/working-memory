import type { Store } from './store.js';
import { defaultStatus, validateSpec } from './kinds/registry.js';
import { validateTopicReferences } from './kinds/topic/references.js';
import type { SessionSnapshot } from './sessionPolicy.js';
import type { InstanceIncident } from './diagnosticContract.js';

export class HeapReportError extends Error {}

function saveIncidentReport(store: Store, incidentId: string, title: string, body: string): string {
  const existing = store.db.prepare(`SELECT id FROM resources WHERE kind='Topic' AND deleted_at IS NULL
    AND json_extract(labels, '$."wm.incident"')=? LIMIT 1`).get(incidentId);
  if (existing) return String(existing.id);
  const types = store.db.prepare(`SELECT id FROM resources WHERE kind='TopicType' AND deleted_at IS NULL
    AND lower(json_extract(spec,'$.label'))='bug' LIMIT 2`).all();
  if (types.length > 1) throw new HeapReportError('Multiple Bug topic types exist. Resolve the ambiguity before saving a heap report.');
  const defaults = types.length ? types : store.db.prepare(`SELECT id FROM resources WHERE kind='TopicType'
    AND deleted_at IS NULL AND json_extract(spec,'$.label')='Topic' LIMIT 2`).all();
  if (defaults.length !== 1) throw new HeapReportError('Create a unique Bug or default Topic type before saving a heap report.');
  const type = String(defaults[0].id);
  const streams = store.db.prepare(`SELECT id FROM resources WHERE kind='Workstream' AND deleted_at IS NULL
    AND json_extract(spec,'$.title')='Inbox' LIMIT 2`).all();
  if (streams.length > 1) throw new HeapReportError('Multiple Inbox workstreams exist. Resolve the ambiguity before saving a heap report.');
  const current = streams[0] ? store.getDocument({ id: String(streams[0].id), kind: 'Workstream' }) : null;
  if (current?.spec.status === 'closed') throw new HeapReportError('Inbox is closed. Reopen it yourself or rename it before saving a heap report.');
  const inbox = current ?? store.createDocument({
    kind: 'Workstream', spec: validateSpec('Workstream', { title: 'Inbox' }), status: defaultStatus('Workstream'),
  });
  const spec = validateSpec('Topic', { title, body, topicType: type, workstreams: [inbox.metadata.id] });
  validateTopicReferences(store, spec);
  return store.createDocument({ kind: 'Topic', labels: { 'wm.incident': incidentId },
    spec, status: defaultStatus('Topic') }).metadata.id;
}

export function createInstanceIncidentReport(
  store: Store,
  incident: Pick<InstanceIncident, 'id' | 'at' | 'environment' | 'kind' | 'evidence'>,
): string {
  const body = `# Automatically detected instance incident\n\nIncident ID: ${incident.id}\n\n`
    + `Detected: ${new Date(incident.at).toISOString()}\n\nEnvironment: ${incident.environment}\n\nClassification: ${incident.kind}\n\n`
    + `## Sanitized evidence\n\n${incident.evidence}\n\n`
    + 'This report records symptoms, not a proven root cause. No credentials, document content, request bodies or raw logs were collected. '
    + 'Review in Inbox; use Send feedback when ready. No topic lifecycle decisions were made automatically.';
  return saveIncidentReport(store, incident.id,
    `Instance ${incident.kind.replaceAll('_', ' ')}: ${new Date(incident.at).toISOString()}`, body);
}

export function createHeapReport(store: Store, snapshot: SessionSnapshot, incidentId: string): string {
  const memory = snapshot.memory;
  const body = `# Heap pressure diagnostic report\n\nIncident ID: ${incidentId}\n\n`
    + `Captured before user-confirmed garbage collection. Server started: ${new Date(snapshot.startedAt).toISOString()}.\n\n`
    + `Heap used: ${memory.heapUsedBytes} bytes; heap limit: ${memory.heapLimitBytes} bytes; `
    + `session admission blocked: ${memory.admissionBlocked}; active MCP sessions: ${snapshot.active.length}.\n\n`
    + `RSS: ${memory.rssBytes ?? 'unavailable'} bytes; external allocations: ${memory.externalBytes ?? 'unavailable'} bytes; `
    + `array buffers (subset of external): ${memory.arrayBufferBytes ?? 'unavailable'} bytes.\n\n`
    + (memory.spaces ?? []).map(space => `- ${space.name}: ${space.usedBytes} bytes used`).join('\n')
    + '\n\nThese are V8 allocation categories, not proof of object ownership or a leak. '
    + 'GC cannot free live objects; recovery only reclaims already-idle sessions and collects unreachable objects. '
    + 'This report does not assert that collection succeeded. See the Sessions event log for its outcome.\n\n'
    + 'No credentials, document contents, request bodies or raw heap snapshots were collected. '
    + 'Review in Inbox and use Send feedback manually when ready.';
  return saveIncidentReport(store, incidentId, `Heap pressure: ${new Date().toISOString()}`, body);
}
