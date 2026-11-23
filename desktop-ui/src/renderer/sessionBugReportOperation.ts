import { getContext, onMount, setContext } from 'svelte';
import type { SessionBugReportOperation } from '../shared/contracts';

const contextKey = Symbol('session-bug-report-operation');
type Collector = () => SessionBugReportOperation | null;

export function createSessionBugReportOperationCollector(): Collector {
  let current: Collector | undefined;
  setContext(contextKey, (collect: Collector) => {
    current = collect;
    return () => { if (current === collect) current = undefined; };
  });
  return () => current?.() ?? null;
}

export function useSessionBugReportOperation(collect: Collector): void {
  const register = getContext<((collect: Collector) => () => void) | undefined>(contextKey);
  onMount(() => register?.(collect));
}
