/**
 * Pure renderer for a control-plane document envelope → readable markdown
 * (WM 13.0 "blackboard-tab"). Used by the `working-memory:/document/<id>.md`
 * virtual document. VS Code-free so it can be unit-tested directly.
 *
 * The envelope is the k8s-resource-style shape returned by the control-plane
 * store: `{ kind, metadata, spec, status }`. We render a section per field
 * plus a fenced ```json block of the whole envelope, so what the reader sees
 * is exactly what an agent gets from `wm_get_document`.
 */

import type { DocumentEnvelope } from './controlPlaneClient';

function formatTimestamp(seconds: number | null | undefined): string {
  if (typeof seconds !== 'number' || !Number.isFinite(seconds)) {
    return '—';
  }
  return `${seconds} (${new Date(seconds * 1000).toISOString()})`;
}

function renderKeyValues(obj: Record<string, unknown>): string {
  const keys = Object.keys(obj);
  if (keys.length === 0) {
    return '_none_';
  }
  return keys
    .map((k) => {
      const value = obj[k];
      const rendered =
        typeof value === 'string' ? value : JSON.stringify(value);
      return `- \`${k}\`: ${rendered}`;
    })
    .join('\n');
}

/** Render a control-plane document envelope as a markdown virtual document. */
export function renderDocumentEnvelopeDoc(env: DocumentEnvelope): string {
  const { kind, metadata, spec, status } = env;
  const slug = metadata.slug ?? '_(none)_';
  const lines: string[] = [
    `# ${kind}: ${metadata.slug ?? metadata.id}`,
    '',
    '## Kind',
    '',
    `\`${kind}\``,
    '',
    '## Metadata',
    '',
    `- \`id\`: \`${metadata.id}\``,
    `- \`slug\`: ${slug}`,
    `- \`resourceVersion\`: ${metadata.resourceVersion}`,
    `- \`createdAt\`: ${formatTimestamp(metadata.createdAt)}`,
    `- \`updatedAt\`: ${formatTimestamp(metadata.updatedAt)}`,
    `- \`deletedAt\`: ${metadata.deletedAt === null ? '—' : formatTimestamp(metadata.deletedAt)}`,
    '',
    '### Labels',
    '',
    renderKeyValues(metadata.labels ?? {}),
    '',
    '## Spec',
    '',
    renderKeyValues(spec ?? {}),
    '',
    '## Status',
    '',
    renderKeyValues(status ?? {}),
    '',
    '## Envelope',
    '',
    '```json',
    JSON.stringify(env, null, 2),
    '```',
    '',
  ];
  return lines.join('\n');
}

/** Body shown when the document store is reachable but the id is unknown. */
export function renderDocumentNotFoundDoc(id: string): string {
  return [
    `# Document not found`,
    '',
    `No control-plane document matches id \`${id}\`.`,
    '',
    '_It may have been deleted, or the id is stale. Refresh the Blackboard tab._',
    '',
  ].join('\n');
}

/** Body shown when the control-plane daemon is not reachable. */
export function renderControlPlaneUnavailableDoc(id: string): string {
  return [
    `# Control plane not running`,
    '',
    `Cannot fetch document \`${id}\` — the Working Memory control-plane`,
    `daemon is not reachable.`,
    '',
    '_Start the control-plane service, then refresh the Blackboard tab._',
    '',
  ].join('\n');
}
