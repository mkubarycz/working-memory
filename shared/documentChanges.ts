export interface DocumentChange {
  id: string;
  kind: string;

  resourceVersion: number;
  deleted: boolean;
}

export interface DocumentChanges {
  resourceVersion: number;
  reset: boolean;
  changes: DocumentChange[];
}

export function parseDocumentChanges(value: unknown): DocumentChanges {
  if (!value || typeof value !== 'object'
    || !('resourceVersion' in value) || !Number.isSafeInteger(value.resourceVersion)
    || typeof value.resourceVersion !== 'number' || value.resourceVersion < 0
    || !('reset' in value) || typeof value.reset !== 'boolean'
    || !('changes' in value) || !Array.isArray(value.changes)) {
    throw new Error('Invalid document-change response.');
  }
  const changes = value.changes.map((change: unknown): DocumentChange => {
    if (!change || typeof change !== 'object'
      || !('id' in change) || typeof change.id !== 'string'
      || !('kind' in change) || typeof change.kind !== 'string'
      || !('resourceVersion' in change) || typeof change.resourceVersion !== 'number'
      || !Number.isSafeInteger(change.resourceVersion) || change.resourceVersion < 1
      || !('deleted' in change) || typeof change.deleted !== 'boolean') {
      throw new Error('Invalid document-change entry.');
    }
    return { id: change.id, kind: change.kind,  resourceVersion: change.resourceVersion, deleted: change.deleted };
  });
  return { resourceVersion: value.resourceVersion, reset: value.reset, changes };
}
