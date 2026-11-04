import { randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { monitorStateSchema, type MonitorState, type InstanceIncident, type InstanceDiagnostics } from '../../../control-plane/src/diagnosticContract';
import type { DesktopInstanceIdentity } from './instanceIdentity';
import type { SessionSnapshot } from '../../../control-plane/src/sessionPolicy';

export interface MonitorTarget { mcpUrl: string }
export interface MonitorProbe {
  healthy: boolean;
  bootId: string | null;
  diagnostics: InstanceDiagnostics | null;
  evidence: string;
}
interface MonitorOptions {
  file: string;
  selected: () => MonitorTarget | null;
  probe: (target: MonitorTarget) => Promise<MonitorProbe>;
  deliver: (target: MonitorTarget, incident: InstanceIncident, current: () => boolean, signal: AbortSignal) => Promise<string>;
  clock?: () => number;
}

export async function deliverIncident(
  identity: Pick<DesktopInstanceIdentity, 'saveIncidentReport'>,
  incident: InstanceIncident,
  current: () => boolean,
  signal?: AbortSignal,
): Promise<string> {
  const check = () => { if (!current()) throw new Error('Selected environment changed; report remains queued for its original instance.'); };
  check();
  const topicId = await identity.saveIncidentReport(incident.environment, incident, signal);
  check();
  return topicId;
}

export class InstanceMonitor {
  private state: MonitorState;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private busy = false;
  private stopped = false;
  private readonly clock: () => number;
  private readonly suspended = new Map<string, number>();
  private readonly generations = new Map<string, number>();
  private readonly manualReports = new Set<string>();
  private delivery: { controller: AbortController; environment: string } | null = null;

  async recordMemoryReport(target: MonitorTarget, snapshot: SessionSnapshot, saveReport: (incidentId: string) => Promise<string>): Promise<string> {
      const current = () => !this.stopped && this.options.selected()?.mcpUrl === target.mcpUrl;
      if (!current()) throw new Error('Selected environment changed. No heap report was saved to another instance.');
      const memory = snapshot.memory;
      const incident: InstanceIncident = {
        id: randomUUID(), environment: target.mcpUrl, at: this.clock(), kind: 'memory_pressure',
        topicId: null, deliveryError: null,
        evidence: `User requested a diagnostic report before manual heap collection.\n\n`
          + `Server started: ${new Date(snapshot.startedAt).toISOString()}; heap used: ${memory.heapUsedBytes} bytes; `
          + `heap limit: ${memory.heapLimitBytes} bytes; session admission blocked: ${memory.admissionBlocked}; `
          + `active sessions: ${snapshot.active.length}.\n\n`
          + (memory.spaces ?? []).map(space => `${space.name}: ${space.usedBytes} bytes used`).join('\n')
          + '\n\nGarbage collection does not release live objects. Idle cleanup never interrupts active requests.',
      };
      this.state.incidents.push(incident);
      this.manualReports.add(incident.id);
      this.save();
      try {
        if (!current()) throw new Error('Selected environment changed before saving the heap report.');
        incident.topicId = await saveReport(incident.id);
        this.save();
        return incident.topicId;
      } catch (error) {
        incident.deliveryError = error instanceof Error ? error.message : String(error);
        this.save();
        throw error;
      } finally {
        this.manualReports.delete(incident.id);
      }
  }

  constructor(private readonly options: MonitorOptions) {
    this.clock = options.clock ?? Date.now;
    try { this.state = monitorStateSchema.parse(JSON.parse(readFileSync(options.file, 'utf8'))); }
    catch (error) {
      if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error;
      this.state = { environments: {}, incidents: [] };
    }
  }

  incidents(mcpUrl: string): InstanceIncident[] {
    return this.state.incidents.filter(incident => incident.environment === mcpUrl).map(incident => ({ ...incident }));
  }

  suspend(mcpUrl: string): () => void {
    this.generations.set(mcpUrl, (this.generations.get(mcpUrl) ?? 0) + 1);
    this.suspended.set(mcpUrl, (this.suspended.get(mcpUrl) ?? 0) + 1);
    if (this.delivery?.environment === mcpUrl) this.delivery.controller.abort();
    let resumed = false;
    return () => {
      if (resumed) return;
      resumed = true;
      const remaining = this.suspended.get(mcpUrl)! - 1;
      if (remaining > 0) { this.suspended.set(mcpUrl, remaining); return; }
      this.suspended.delete(mcpUrl);
      delete this.state.environments[mcpUrl];
      this.save();
    };
  }

  start(): void {
    const poll = async () => {
      try { await this.tick(); }
      catch (error) { console.error('[instance-monitor] Monitoring failed:', error); }
      if (!this.stopped) this.timer = setTimeout(() => void poll(), 10000);
    };
    void poll();
  }
  stop(): void { this.stopped = true; clearTimeout(this.timer); this.delivery?.controller.abort(); }

  private save(): void {
    // Keep all undelivered incidents; bound completed history without losing queued reports.
    const completed = this.state.incidents.filter(incident => incident.topicId !== null).slice(-100);
    this.state.incidents = [...this.state.incidents.filter(incident => incident.topicId === null), ...completed];
    mkdirSync(dirname(this.options.file), { recursive: true });
    writeFileSync(`${this.options.file}.tmp`, JSON.stringify(this.state), { mode: 0o600 });
    renameSync(`${this.options.file}.tmp`, this.options.file);
  }

  tick(): Promise<void> { return this.tickOnce(); }

  private async tickOnce(): Promise<void> {
    const target = this.options.selected();
    if (this.busy || this.stopped || !target || this.suspended.has(target.mcpUrl)) return;
    this.busy = true;
    const generation = this.generations.get(target.mcpUrl);
    const current = () => !this.stopped && this.options.selected()?.mcpUrl === target.mcpUrl
      && !this.suspended.has(target.mcpUrl) && this.generations.get(target.mcpUrl) === generation;
    try {
      const probe = await this.options.probe(target);
      if (!current()) return;
      const state = this.state.environments[target.mcpUrl] ??= {
        bootId: null, failures: 0, outageId: null, memoryBlocked: false, stallAt: 0,
        lastEvidence: 'No pre-incident runtime sample was available.',
      };
      const add = (kind: InstanceIncident['kind'], evidence: string): string => {
        const id = randomUUID();
        this.state.incidents.push({ id, environment: target.mcpUrl, at: this.clock(), kind,
          evidence, topicId: null, deliveryError: null });
        return id;
      };
      if (!probe.healthy) {
        state.failures += 1;
        if (state.failures >= 3 && !state.outageId) state.outageId = add('outage',
          `Three consecutive health probes failed (10 seconds between attempts). This is an outage, not proof of a crash.\n\n${probe.evidence}\n\n`
            + `Last successful sample:\n${state.lastEvidence}`);
      } else {
        if (state.bootId && probe.bootId && state.bootId !== probe.bootId) {
          if (state.outageId) {
            const incident = this.state.incidents.find(item => item.id === state.outageId);
            if (incident && !incident.topicId) {
              incident.kind = 'restart';
              incident.evidence += '\n\nA changed backend boot ID confirms a process restart after the outage.';
            }
          } else add('restart', 'The selected backend boot ID changed between successful health probes. A process restart is confirmed; the cause is unknown.\n\n'
            + state.lastEvidence + '\n\n' + probe.evidence);
        }
        state.bootId = probe.bootId ?? state.bootId;
        state.failures = 0;
        state.outageId = null;
        const diagnostics = probe.diagnostics;
        if (diagnostics) {
          state.lastEvidence = `Backend version: ${diagnostics.version}; observed: ${new Date(diagnostics.observedAt).toISOString()}; `
            + `heap used: ${diagnostics.runtime.heapUsedBytes}; heap limit: ${diagnostics.runtime.heapLimitBytes}; `
            + `RSS: ${diagnostics.runtime.rssBytes}; event-loop max: ${Math.round(diagnostics.runtime.eventLoopMaxMs)} ms; `
            + `active requests: ${diagnostics.runtime.activeRequests}; active sessions: ${diagnostics.runtime.activeSessions}.\n`
            + diagnostics.events.slice(0, 5).map(event => `${event.code}: HTTP ${event.status}, ${Math.round(event.durationMs)} ms, count ${event.count}`).join('\n');
          if (diagnostics.runtime.admissionBlocked && !state.memoryBlocked) {
            add('memory_pressure', `JavaScript heap usage reached the 60% session-admission cutoff.\n\n`
              + `Heap used: ${diagnostics.runtime.heapUsedBytes} bytes; heap limit: ${diagnostics.runtime.heapLimitBytes} bytes; `
              + `RSS: ${diagnostics.runtime.rssBytes} bytes; active sessions: ${diagnostics.runtime.activeSessions}; version: ${diagnostics.version}.`);
          }
          state.memoryBlocked = diagnostics.runtime.admissionBlocked;
          const stall = diagnostics.events.find(event => event.code === 'event_loop_stall' && event.at > state.stallAt
            && event.at >= this.clock() - 60000);
          if (stall) {
            if (state.stallAt < this.clock() - 300000) add('event_loop_stall',
              `The backend measured event-loop delay of ${Math.round(stall.durationMs)} ms (threshold: 1000 ms). `
              + 'This can explain stalled health checks but does not identify the allocation or scheduling cause.');
            state.stallAt = stall.at;
          }
        }
      }
      this.save();
      if (probe.healthy) this.deliverNext(target, current);
    } finally { this.busy = false; }
  }

  private deliverNext(target: MonitorTarget, current: () => boolean): void {
    if (this.delivery || !current()) return;
    const incident = this.state.incidents.find(item => item.environment === target.mcpUrl
      && !item.topicId && !this.manualReports.has(item.id));
    if (!incident) return;
    const controller = new AbortController();
    const delivery = this.delivery = { controller, environment: target.mcpUrl };
    const timer = setTimeout(() => controller.abort(new Error('Incident delivery exceeded its 10-second deadline.')), 10000);
    let onAbort: (() => void) | undefined;
    const cancelled = new Promise<never>((_resolve, reject) => {
      onAbort = () => reject(controller.signal.reason);
      controller.signal.addEventListener('abort', onAbort, { once: true });
    });
    void (async () => {
      try {
        const topicId = await Promise.race([
          this.options.deliver(target, { ...incident }, current, controller.signal), cancelled,
        ]);
        if (current()) { incident.topicId = topicId; incident.deliveryError = null; }
      } catch (error) {
        if (current()) {
          incident.deliveryError = error instanceof Error ? error.message : String(error);
          console.error('[instance-monitor] Inbox delivery failed:', error);
        }
      } finally {
        clearTimeout(timer);
        if (onAbort) controller.signal.removeEventListener('abort', onAbort);
        if (this.delivery === delivery) this.delivery = null;
        this.save();
      }
    })().catch(error => console.error('[instance-monitor] Delivery state could not be saved:', error));
  }
}
