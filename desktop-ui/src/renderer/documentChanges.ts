import type { DocumentChange, DocumentChanges } from '../../../shared/documentChanges';
import type { DocumentVM } from './documents/types';
import type { DesktopResourceKind } from '../shared/contracts';
import { normalizeScopeKind } from './scopeIdentity';

export function documentMatchesChange(
  document: Pick<DocumentVM, 'kind' | 'slug'> & { id?: string },
  change: DocumentChange,
): boolean {
  return change.id === document.id || Boolean(change.slug && change.slug === document.slug
    && normalizeScopeKind(change.kind) === normalizeScopeKind(document.kind));
}

export function documentRefreshTarget(document: DocumentVM): { kind: DesktopResourceKind; identifier: string } | undefined {
  if (['settings', 'topic-create', 'topic-backlog', 'container-app'].includes(document.kind)) return undefined;
  if ((document.kind === 'topic' || document.kind === 'workstream') && document.slug) {
    return { kind: document.kind, identifier: document.slug };
  }
  return 'id' in document && document.id ? { kind: 'document', identifier: document.id } : undefined;
}

export function createDocumentChangeQueue(
  refresh: (change: DocumentChanges) => Promise<void>,
  onError: (error: unknown) => void,
) {
  let pending: DocumentChanges | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let running = false;
  let generation = 0;
  const schedule = () => {
    if (timer !== undefined || running || !pending) return;
    timer = setTimeout(() => { timer = undefined; void flush(); }, 100);
  };
  const flush = async () => {
    if (running) return;
    running = true;
    try {
      while (pending) {
        const change = pending;
        const epoch = generation;
        pending = undefined;
        try {
          await refresh(change);
        } catch (error) {
          if (epoch === generation) onError(error);
        }
      }
    } finally {
      running = false;
      schedule();
    }
  };
  return {
    enqueue(change: DocumentChanges) {
      const changes = new Map(pending?.changes.map((entry) => [entry.id, entry]));
      for (const entry of change.changes) changes.set(entry.id, entry);
      pending = {
        resourceVersion: Math.max(pending?.resourceVersion ?? 0, change.resourceVersion),
        reset: (pending?.reset ?? false) || change.reset,
        changes: [...changes.values()],
      };
      schedule();
    },
    clear() {
      generation += 1;
      pending = undefined;
      if (timer !== undefined) clearTimeout(timer);
      timer = undefined;
    },
  };
}
