import type { CommandJournalScopeRef } from '../../../shared/controlPlaneClient';
import type { ChatRun } from './chatHistory';

export interface UnreadResponse {
  key: string;
  refs: CommandJournalScopeRef[];
}

export function responseKey(run: ChatRun): string {
  return run.journalId ?? run.key;
}

export function hasResponse(run: ChatRun): boolean {
  return !['running', 'submitting', 'awaiting_confirmation'].includes(run.status) && Boolean(run.assistantText);
}

export function collectUnreadResponses(
  unread: UnreadResponse[],
  previous: ChatRun[],
  next: ChatRun[],
  includeNew: boolean,
): UnreadResponse[] {
  const records = new Map(unread.map((record) => [record.key, record]));
  for (const run of next) {
    if (!hasResponse(run)) continue;
    const old = previous.find((candidate) => responseKey(candidate) === responseKey(run)
      || candidate.key === run.key);
    if (old ? hasResponse(old) : !includeNew) continue;
    records.set(responseKey(run), {
      key: responseKey(run),
      refs: [run.scope, ...run.entityRefs].map(({ kind, id }) => ({ kind, id })),
    });
  }
  return [...records.values()].slice(-200);
}

export function unreadResponseCount(records: UnreadResponse[], kind: string, ...identifiers: Array<string | null | undefined>): number {
  const normalized = kind.toLowerCase().replaceAll('-', '');
  return records.filter((record) => record.refs.some((ref) =>
    ref.kind.toLowerCase().replaceAll('-', '') === normalized
    && identifiers.some((id) => id && ref.id === id))).length;
}

export function parseUnreadResponses(raw: string | null): UnreadResponse[] {
  if (!raw) return [];
  try {
    const value: unknown = JSON.parse(raw);
    if (!Array.isArray(value)) return [];
    return value.filter((record): record is UnreadResponse => (
      record && typeof record === 'object' && typeof record.key === 'string'
      && Array.isArray(record.refs) && record.refs.every((ref: unknown) =>
        ref && typeof ref === 'object' && 'kind' in ref && typeof ref.kind === 'string'
        && 'id' in ref && typeof ref.id === 'string'
        && (!('id' in ref) || typeof ref.id === 'string'))
    )).slice(-200);
  } catch {
    return [];
  }
}

export function observeResponse(
  node: HTMLElement,
  initial: { key: string; enabled: boolean; onViewed: (key: string) => void },
) {
  let options = initial;
  let visible = false;
  let observed = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const cancel = () => { if (timer !== undefined) clearTimeout(timer); timer = undefined; };
  const sync = () => {
    if (!options.enabled || !visible || document.visibilityState !== 'visible' || !document.hasFocus()) {
      cancel();
    } else if (!observed && timer === undefined) {
      timer = setTimeout(() => {
        timer = undefined;
        observed = true;
        options.onViewed(options.key);
      }, 3_000);
    }
  };
  const observer = new IntersectionObserver(([entry]) => { visible = entry.isIntersecting; sync(); });
  observer.observe(node);
  document.addEventListener('visibilitychange', sync);
  window.addEventListener('focus', sync);
  window.addEventListener('blur', sync);
  sync();
  return {
    update(next: typeof initial) {
      if (next.key !== options.key) { cancel(); observed = false; }
      options = next;
      sync();
    },
    destroy() {
      cancel();
      observer.disconnect();
      document.removeEventListener('visibilitychange', sync);
      window.removeEventListener('focus', sync);
      window.removeEventListener('blur', sync);
    },
  };
}
