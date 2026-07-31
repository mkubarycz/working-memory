/**
 * The nanite EXECUTION DISPATCHER — the centralized "execution plane."
 *
 * Nanites reach `Queued` (via the Run action's approved enqueue, or a template
 * with `allowRunWithoutHuman`). This poller picks Queued nanites up and runs
 * them through the injected runner, throttled to `maxConcurrent` at a time
 * (default 1). It's the ONLY thing that starts execution, so lifecycle stays:
 * Pending → Queued → Running → terminal.
 *
 * VS Code-free by design (uses `setInterval` + injected seams) so the core is
 * unit-testable; `extension.ts` wires the real control-plane client + runner.
 */

import type { Nanite } from '../controlPlaneClient';

/** The slice of the control-plane client the dispatcher reads through. */
export interface DispatcherClient {
  naniteRead(input: { phase?: Nanite['phase'] }): Promise<Nanite[]>;
}

export interface NaniteDispatcherDeps {
  /** Resolve the control-plane client, or null when the daemon is unavailable. */
  readClient: () => DispatcherClient | null;
  /** Run ONE nanite to a terminal phase (the extension-host runner). */
  run: (nanite: Nanite) => Promise<unknown>;
  /** Max nanites to run concurrently (read live so config changes apply). */
  maxConcurrent: () => number;
  /** Notify the panel/UI after a run settles (best-effort). */
  onChange?: () => void;
  /** Poll cadence in ms (default 5000). */
  pollIntervalMs?: number;
}

/**
 * Choose which Queued nanite ids to start now: oldest-`queuedAt` first, never
 * one already in flight, up to the free-slot budget. Pure.
 */
export function selectDispatchable(
  queued: Array<{ id: string; queuedAt: number | null }>,
  inFlight: ReadonlySet<string>,
  maxConcurrent: number,
): string[] {
  const free = Math.max(0, maxConcurrent - inFlight.size);
  if (free === 0) {
    return [];
  }
  return [...queued]
    .filter((n) => !inFlight.has(n.id))
    .sort((a, b) => (a.queuedAt ?? 0) - (b.queuedAt ?? 0))
    .slice(0, free)
    .map((n) => n.id);
}

export class NaniteDispatcher {
  private readonly inFlight = new Set<string>();
  private timer: ReturnType<typeof setInterval> | undefined;
  private disposed = false;

  constructor(private readonly deps: NaniteDispatcherDeps) {}

  /** Begin polling (idempotent) and run an immediate tick. */
  start(): void {
    if (this.timer || this.disposed) {
      return;
    }
    const ms = this.deps.pollIntervalMs ?? 5000;
    this.timer = setInterval(() => void this.pump(), ms);
    void this.pump();
  }

  /** One dispatch tick: fill free slots with the oldest Queued nanites. */
  async pump(): Promise<void> {
    if (this.disposed) {
      return;
    }
    const client = this.deps.readClient();
    if (!client) {
      return;
    }
    const max = Math.max(1, this.deps.maxConcurrent());
    if (this.inFlight.size >= max) {
      return;
    }
    let queued: Nanite[];
    try {
      queued = await client.naniteRead({ phase: 'Queued' });
    } catch {
      return; // daemon hiccup — try again next tick
    }
    for (const id of selectDispatchable(queued, this.inFlight, max)) {
      const nanite = queued.find((n) => n.id === id);
      if (!nanite) {
        continue;
      }
      this.inFlight.add(id);
      void Promise.resolve(this.deps.run(nanite))
        .catch(() => {
          // The runner persists its own terminal failure; swallow here.
        })
        .finally(() => {
          this.inFlight.delete(id);
          this.deps.onChange?.();
          // A slot freed — immediately look for the next Queued nanite.
          void this.pump();
        });
    }
  }

  dispose(): void {
    this.disposed = true;
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
  }
}
