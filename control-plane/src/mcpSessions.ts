import { randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { getHeapStatistics } from 'node:v8';
import type { InstancePrincipal } from './instanceAccess.js';
import {
  DEFAULT_SESSION_POLICY, SESSION_HEAP_FRACTION, sessionPolicySchema, sessionSnapshotSchema,
  type SessionPolicy, type SessionSnapshot, type SessionEventType,
} from './sessionPolicy.js';

export interface SessionDiagnosticsOptions {
  clock?: () => number;
  memory?: () => { used: number; limit: number };
}
type Client = { clientId: string | null; clientLabel: string; application: string };
export interface ManagedSession extends Client {
  readonly protocolId: string;
  readonly id: string;
  readonly principalKey: string;
  readonly quotaKey: string;
  createdAt: number;
  lastActivityAt: number;
  activeRequests: number;
  requests: number;
  state: 'initializing' | 'active';
  close: () => Promise<void>;
}
export class SessionAdmissionError extends Error {
  constructor(readonly status: number, message: string, readonly retryAfter: number = 60) { super(message); }
}

export class McpSessions {
  private readonly sessions = new Map<string, ManagedSession>();
  private readonly rates = new Map<string, { startedAt: number; attempts: number }>();
  private readonly closing = new Set<Promise<void>>();
  private readonly clock: () => number;
  private readonly memoryUsage: () => { used: number; limit: number };
  private readonly startedAt: number;
  private policy: SessionPolicy;
  private stopped = false;

  constructor(private readonly db: DatabaseSync, options: SessionDiagnosticsOptions = {}) {
    this.clock = options.clock ?? Date.now;
    this.memoryUsage = options.memory ?? (() => ({
      used: process.memoryUsage().heapUsed, limit: getHeapStatistics().heap_size_limit,
    }));
    this.startedAt = this.clock();
    db.exec(`
      CREATE TABLE IF NOT EXISTS mcp_session_policy (
        singleton INTEGER PRIMARY KEY CHECK(singleton=1), policy TEXT NOT NULL
      ) STRICT;
      CREATE TABLE IF NOT EXISTS mcp_session_events (
        sequence INTEGER PRIMARY KEY AUTOINCREMENT, type TEXT NOT NULL, client_id TEXT, client_label TEXT NOT NULL,
        application TEXT NOT NULL, session_id TEXT, first_at INTEGER NOT NULL, last_at INTEGER NOT NULL,
        count INTEGER NOT NULL, detail TEXT NOT NULL, bucket TEXT UNIQUE
      ) STRICT;
      CREATE INDEX IF NOT EXISTS idx_mcp_session_events_retention ON mcp_session_events(last_at);
    `);
    const saved = db.prepare('SELECT policy FROM mcp_session_policy WHERE singleton=1').get();
    this.policy = saved ? sessionPolicySchema.parse(JSON.parse(String(saved.policy))) : { ...DEFAULT_SESSION_POLICY };
    this.prune();
  }

  private client(principal: InstancePrincipal, application: string): Client {
    const clientId = principal.clientId ?? null;
    const row = clientId ? this.db.prepare('SELECT label FROM instance_clients WHERE id=?').get(clientId) : undefined;
    return { clientId, clientLabel: clientId ? String(row?.label ?? clientId) : 'Instance owner',
      application: application.replace(/[\u0000-\u001f\u007f]/g, ' ').slice(0, 120) };
  }

  private event(type: SessionEventType, client: Client, detail: string, sessionId: string | null = null, aggregate = false): void {
    const now = this.clock();
    const bucket = aggregate ? `${type}:${client.clientId ?? 'owner'}:${Math.floor(now / 60000)}` : null;
    this.db.prepare(`INSERT INTO mcp_session_events
      (type,client_id,client_label,application,session_id,first_at,last_at,count,detail,bucket)
      VALUES (?,?,?,?,?,?,?,1,?,?)
      ON CONFLICT(bucket) DO UPDATE SET last_at=excluded.last_at,count=count+1`)
      .run(type, client.clientId, client.clientLabel, client.application, sessionId, now, now, detail, bucket);
  }

  admit(principal: InstancePrincipal, application: string): ManagedSession {
    if (this.stopped) throw new SessionAdmissionError(503, 'The instance is shutting down.');
    this.sweep();
    const client = this.client(principal, application);
    const quotaKey = principal.clientId ?? 'owner';
    const now = this.clock();
    let rate = this.rates.get(quotaKey);
    if (!rate || rate.startedAt <= now - 60000) {
      rate = { startedAt: now, attempts: 0 };
      this.rates.set(quotaKey, rate);
    }
    rate.attempts = Math.min(rate.attempts + 1, 100001);
    const reject = (type: SessionEventType, status: number, detail: string): never => {
      this.event(type, client, detail, null, true);
      throw new SessionAdmissionError(status, detail, Math.max(1, Math.ceil((rate.startedAt + 60000 - now) / 1000)));
    };
    if (rate.attempts > this.policy.handshakesPerMinute) {
      reject('rate_limited', 429, 'New-session attempts exceeded this client\'s per-minute limit.');
    }
    const owned = Array.from(this.sessions.values()).filter(session => session.quotaKey === quotaKey).length;
    if (owned >= this.policy.maxPerClient) reject('client_quota', 429, 'This client reached its active-session limit.');
    if (this.sessions.size >= this.policy.maxTotal) reject('global_quota', 503, 'The instance reached its active-session limit.');
    const memory = this.memoryUsage();
    if (memory.used >= memory.limit * SESSION_HEAP_FRACTION) {
      reject('memory_rejected', 503, 'New sessions are paused: JavaScript heap usage reached the 60% safety cutoff.');
    }
    const session: ManagedSession = {
      ...client, protocolId: randomUUID(), id: randomUUID(), principalKey: principal.key, quotaKey,
      createdAt: now, lastActivityAt: now, activeRequests: 0, requests: 0, state: 'initializing',
      close: async () => {},
    };
    this.sessions.set(session.protocolId, session);
    return session;
  }

  initialized(session: ManagedSession): void {
    session.state = 'active';
    this.event('opened', session, 'MCP session initialized.', session.id);
  }

  get(protocolId: string): ManagedSession | undefined {
    const session = this.sessions.get(protocolId);
    if (session && this.isIdle(session)) { this.remove(session, 'idle_expired', 'Idle session resources reclaimed.'); return; }
    return session;
  }

  async request<T>(session: ManagedSession, action: () => Promise<T>): Promise<T> {
    session.activeRequests += 1;
    this.touch(session);
    try { return await action(); }
    finally { session.activeRequests -= 1; session.lastActivityAt = this.clock(); }
  }

  touch(session: ManagedSession): void {
    session.requests += 1;
    session.lastActivityAt = this.clock();
  }

  closed(session: ManagedSession): void {
    if (!this.sessions.delete(session.protocolId)) return;
    this.event('closed', session, 'Client closed its MCP session.', session.id);
  }

  failed(session: ManagedSession): void {
    this.remove(session, 'initialization_failed', 'Session initialization did not complete.');
  }

  private isIdle(session: ManagedSession): boolean {
    return session.activeRequests === 0 && session.lastActivityAt <= this.clock() - this.policy.idleMinutes * 60000;
  }

  private remove(session: ManagedSession, type: SessionEventType, detail: string): void {
    if (!this.sessions.delete(session.protocolId)) return;
    const closing = Promise.resolve().then(() => session.close()).catch(error => {
      console.error('[mcp-sessions] Resource cleanup failed:', error);
      try {
        this.event('cleanup_failed', session, 'Session resource cleanup failed; see backend logs.', session.id);
      } catch (auditError) {
        console.error('[mcp-sessions] Unable to persist cleanup failure:', auditError);
      }
    }).finally(() => { this.closing.delete(closing); });
    this.closing.add(closing);
    this.event(type, session, detail, session.id);
  }

  sweep(): void {
    for (const session of this.sessions.values()) {
      if (this.isIdle(session)) this.remove(session, 'idle_expired', 'Idle session resources reclaimed.');
    }
    const cutoff = this.clock() - 60000;
    for (const [key, rate] of this.rates) if (rate.startedAt <= cutoff) this.rates.delete(key);
    this.prune();
  }

  private prune(): void {
    this.db.prepare('DELETE FROM mcp_session_events WHERE last_at<?')
      .run(this.clock() - this.policy.retentionDays * 86400000);
  }

  setPolicy(input: unknown): void {
    const policy = sessionPolicySchema.parse(input);
    this.db.prepare(`INSERT INTO mcp_session_policy VALUES (1,?)
      ON CONFLICT(singleton) DO UPDATE SET policy=excluded.policy`).run(JSON.stringify(policy));
    this.policy = policy;
    this.event('policy_updated', { clientId: null, clientLabel: 'Instance owner', application: 'Settings' },
      'Session policy updated. Count limits apply to new sessions; in-flight requests are not interrupted.');
    this.sweep();
  }

  snapshot(before?: number): SessionSnapshot {
    const memory = this.memoryUsage();
    const rows = this.db.prepare(`SELECT * FROM mcp_session_events
      WHERE last_at>=? AND sequence<? ORDER BY sequence DESC LIMIT 101`)
      .all(this.clock() - this.policy.retentionDays * 86400000, before ?? Number.MAX_SAFE_INTEGER);
    return sessionSnapshotSchema.parse({
      startedAt: this.startedAt, policy: this.policy,
      memory: { heapUsedBytes: memory.used, heapLimitBytes: memory.limit,
        admissionThresholdBytes: Math.floor(memory.limit * SESSION_HEAP_FRACTION),
        admissionBlocked: memory.used >= memory.limit * SESSION_HEAP_FRACTION },
      active: Array.from(this.sessions.values(), session => ({
        id: session.id, clientId: session.clientId, clientLabel: session.clientLabel, application: session.application,
        createdAt: session.createdAt, lastActivityAt: session.lastActivityAt,
        activeRequests: session.activeRequests, requests: session.requests, state: session.state,
      })),
      events: rows.slice(0, 100).map(row => ({
        sequence: Number(row.sequence), type: row.type, clientId: row.client_id, clientLabel: row.client_label,
        application: row.application, sessionId: row.session_id, firstAt: Number(row.first_at),
        lastAt: Number(row.last_at), count: Number(row.count), detail: row.detail,
      })),
      nextCursor: rows.length > 100 ? Number(rows[99].sequence) : null,
    });
  }

  async close(): Promise<void> {
    this.stopped = true;
    for (const session of this.sessions.values()) this.remove(session, 'server_shutdown', 'Instance shutdown.');
    this.rates.clear();
    await Promise.all(this.closing);
  }
}
