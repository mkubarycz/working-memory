import type { ToolQueueSnapshot } from '../../../control-plane/src/diagnosticContract';

const outcomes: Record<string, string> = {
  completed: 'Completed', failed: 'Failed',
  full: 'Full (not executed)', expired: 'Expired (not executed)',
  cancelled: 'Cancelled (not executed)', shutdown: 'Shutdown (not executed)',
  not_executed: 'Denied (not executed)',
};

interface QueueRequest {
  requestId: string;
  operation: string;
  caller: string;
  queuedAt: number;
  durationMs: number | null;
  waitMs: number | null;
  runMs: number | null;
  state: string;
}

export function toolQueueRequests(snapshot: Pick<ToolQueueSnapshot, 'events' | 'items' | 'observedAt'>): QueueRequest[] {
  const latest = new Map<string, ToolQueueSnapshot['events'][number]>();
  for (const event of snapshot.events) {
    const previous = latest.get(event.requestId);
    if (!previous || previous.sequence < event.sequence) latest.set(event.requestId, event);
  }

  const requests = new Map<string, QueueRequest>();
  for (const event of latest.values()) {
    const finished = Object.hasOwn(outcomes, event.event);
    requests.set(event.requestId, {
      requestId: event.requestId, operation: event.operation, caller: event.caller,
      queuedAt: event.at - event.waitMs - event.runMs,
      durationMs: finished ? event.waitMs + event.runMs : null,
      waitMs: finished ? event.waitMs : null, runMs: finished ? event.runMs : null,
      state: finished ? outcomes[event.event] : 'Outcome unavailable',
    });
  }
  for (const item of snapshot.items) {
    const waitMs = Math.max(0, (item.startedAt ?? snapshot.observedAt) - item.queuedAt);
    const runMs = item.startedAt === undefined ? 0 : Math.max(0, snapshot.observedAt - item.startedAt);
    requests.set(item.requestId, {
      requestId: item.requestId, operation: item.operation, caller: item.caller, queuedAt: item.queuedAt,
      durationMs: waitMs + runMs, waitMs, runMs,
      state: item.startedAt === undefined ? 'Waiting' : 'Running',
    });
  }
  return [...requests.values()].sort((a, b) => b.queuedAt - a.queuedAt || a.requestId.localeCompare(b.requestId));
}

export function topQueueRequests(requests: readonly QueueRequest[], metric: 'waitMs' | 'runMs'): QueueRequest[] {
  return requests.filter(request => request[metric] !== null)
    .sort((a, b) => (b[metric] ?? 0) - (a[metric] ?? 0) || b.queuedAt - a.queuedAt || a.requestId.localeCompare(b.requestId))
    .slice(0, 50);
}
