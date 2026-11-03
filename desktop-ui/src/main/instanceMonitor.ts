import { randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { monitorStateSchema, type MonitorState, type InstanceIncident, type InstanceDiagnostics } from '../../../control-plane/src/diagnosticContract';
import type { ControlPlaneClient } from '../../../shared/controlPlaneClient';
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
  deliver: (target: MonitorTarget, incident: InstanceIncident, current: () => boolean) => Promise<string>;
  clock?: () => number;
}

export async function deliverIncident(
  client: Pick<ControlPlaneClient, 'listDocuments' | 'wsRead' | 'wsCreate' | 'topicTypeRead' | 'createDocument'>,
  incident: InstanceIncident,
  current: () => boolean,
): Promise<string> {
  const check = () => { if (!current()) throw new Error('Selected environment changed; report remains queued for its original instance.'); };
  check();
  const topics = await client.listDocuments('Topic', { query: incident.id, limit: 2 });
  if (!topics.available) throw new Error(topics.error ?? 'Unable to check existing incident reports.');
  const existing = topics.documents.find(doc => doc.metadata.labels['wm.incident'] === incident.id);
  if (existing) return existing.metadata.id;
  check();
  const streams = (await client.wsRead()).filter(stream => stream.title === 'Inbox');
  if (streams.length > 1) throw new Error('Multiple Inbox workstreams exist. Rename the duplicate before retrying delivery.');
  if (streams[0]?.status === 'closed') throw new Error('Inbox is closed. Reopen it yourself or rename it before retrying delivery.');
  check();
  const inbox = streams[0] ?? await client.wsCreate({ title: 'Inbox' });
  check();
  const types = (await client.topicTypeRead()).filter(type => type.label.toLowerCase() === 'bug');
  if (types.length > 1) throw new Error('Multiple Bug topic types exist. Resolve the ambiguity before retrying delivery.');
  check();
  const body = `# Automatically detected instance incident\n\n`
    + `Incident ID: ${incident.id}\n\nDetected: ${new Date(incident.at).toISOString()}\n\n`
    + `Environment: ${incident.environment}\n\nClassification: ${incident.kind}\n\n`
    + `## Sanitized evidence\n\n${incident.evidence}\n\n`
    + 'This report records symptoms, not a proven root cause. No credentials, document content, request bodies or raw logs were collected. '
    + 'Review in Inbox; use Send feedback when ready. No topic lifecycle decisions were made automatically.';
  const result = await client.createDocument({
    kind: 'Topic', labels: { 'wm.incident': incident.id },
    spec: { title: `Instance ${incident.kind.replaceAll('_', ' ')}: ${new Date(incident.at).toISOString()}`,
      body, workstreams: [inbox.id], ...(types[0] ? { topicType: types[0].id } : {}) },
  });
  if (!result.available || !result.document) throw new Error(result.error ?? 'Unable to save incident report.');
  return result.document.metadata.id;
}

export class InstanceMonitor {
  private state: MonitorState;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private busy = false;
  private stopped = false;
  private readonly clock: () => number;
  private readonly suspended = new Set<string>();
  private operation: Promise<unknown> = Promise.resolve();

  private serialize<T>(action: () => Promise<T>): Promise<T> {
    const pending = this.operation.then(action, action);
    this.operation = pending;
    return pending;
  }

  recordMemoryReport(target: MonitorTarget, snapshot: SessionSnapshot, saveReport: (incidentId: string) => Promise<string>): Promise<string> {
    return this.serialize(async () => {
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
      }
    });
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
    this.suspended.add(mcpUrl);
    return () => {
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
  stop(): void { this.stopped = true; clearTimeout(this.timer); }

  private save(): void {
    // Keep all undelivered incidents; bound completed history without losing queued reports.
    const completed = this.state.incidents.filter(incident => incident.topicId !== null).slice(-100);
    this.state.incidents = [...this.state.incidents.filter(incident => incident.topicId === null), ...completed];
    mkdirSync(dirname(this.options.file), { recursive: true });
    writeFileSync(`${this.options.file}.tmp`, JSON.stringify(this.state), { mode: 0o600 });
    renameSync(`${this.options.file}.tmp`, this.options.file);
  }

  tick(): Promise<void> { return this.serialize(() => this.tickOnce()); }

  private async tickOnce(): Promise<void> {
    const target = this.options.selected();
    if (this.busy || this.stopped || !target || this.suspended.has(target.mcpUrl)) return;
    this.busy = true;
    const current = () => !this.stopped && this.options.selected()?.mcpUrl === target.mcpUrl && !this.suspended.has(target.mcpUrl);
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
      if (probe.healthy) {
        for (const incident of this.state.incidents.filter(item => item.environment === target.mcpUrl && !item.topicId)) {
          if (!current()) break;
          try {
            incident.topicId = await this.options.deliver(target, { ...incident }, current);
            incident.deliveryError = null;
          } catch (error) {
            incident.deliveryError = error instanceof Error ? error.message : String(error);
            console.error('[instance-monitor] Inbox delivery failed:', error);
          }
          this.save();
        }
      }
    } finally { this.busy = false; }
  }
}
