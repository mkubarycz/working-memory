import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openStore } from '../src/store';
import { InstanceIdentity } from '../src/instanceIdentity';
import { InstanceAccess, type InstancePrincipal } from '../src/instanceAccess';
import { defaultInstancePermissions } from '../src/instancePermissions';
import { McpSessions, SessionAdmissionError } from '../src/mcpSessions';
import { DEFAULT_SESSION_POLICY } from '../src/sessionPolicy';

const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });
const owner: InstancePrincipal = {
  key: 'private-owner-credential-hash', role: 'owner', access: 'write', permissions: defaultInstancePermissions('write'),
};
const other: InstancePrincipal = { ...owner, key: 'private-client-hash', role: 'client', clientId: 'approved-client-id' };

function fixture() {
  const store = openStore(':memory:');
  new InstanceAccess(store.db, new InstanceIdentity(store.db));
  let now = 1800000000000;
  let used = 100;
  const sessions = new McpSessions(store.db, { clock: () => now, memory: () => ({ used, limit: 1000 }) });
  cleanup.push(async () => { await sessions.close(); store.close(); });
  return { sessions, store, advance: (ms: number) => { now += ms; }, memory: (bytes: number) => { used = bytes; } };
}

describe('MCP session lifecycle and persisted diagnostics', () => {
  it('uses the approved defaults and never exposes protocol IDs or credential hashes', () => {
    const f = fixture();
    const session = f.sessions.admit(owner, 'Test\u0000app');
    f.sessions.initialized(session);
    const snapshot = f.sessions.snapshot();
    expect(snapshot.policy).toEqual(DEFAULT_SESSION_POLICY);
    expect(snapshot.active[0]).toMatchObject({ application: 'Test app', id: session.id });
    const serialized = JSON.stringify(snapshot);
    expect(serialized).not.toContain(session.protocolId);
    expect(serialized).not.toContain(owner.key);
    expect(snapshot.memory).toMatchObject({ admissionThresholdBytes: 600, admissionBlocked: false });
  });

  it('protects in-flight requests and reclaims the entire idle session once after completion', async () => {
    const f = fixture();
    f.sessions.setPolicy({ ...DEFAULT_SESSION_POLICY, idleMinutes: 1 });
    const session = f.sessions.admit(owner, 'busy');
    const close = vi.fn(async () => { f.sessions.closed(session); });
    session.close = close;
    let release!: () => void;
    const request = f.sessions.request(session, () => new Promise<void>(resolve => { release = resolve; }));
    f.advance(120000);
    f.sessions.sweep();
    expect(f.sessions.get(session.protocolId)).toBe(session);
    expect(f.sessions.snapshot().active[0].activeRequests).toBe(1);
    release(); await request;
    f.advance(59999);
    expect(f.sessions.get(session.protocolId)).toBe(session);
    f.advance(1);
    expect(f.sessions.get(session.protocolId)).toBeUndefined();
    await f.sessions.close();
    expect(close).toHaveBeenCalledTimes(1);
    expect(f.sessions.snapshot().events.filter(event => event.type === 'idle_expired')).toHaveLength(1);
  });

  it('shares quotas across renewed credentials for the same client, but isolates other identities', () => {
    const f = fixture();
    f.sessions.setPolicy({ ...DEFAULT_SESSION_POLICY, maxPerClient: 1, maxTotal: 2 });
    f.sessions.admit(other, 'client');
    expect(() => f.sessions.admit({ ...other, key: 'renewed-client-hash' }, 'second')).toThrow('client reached');
    f.sessions.admit(owner, 'owner');
    expect(() => f.sessions.admit({ ...other, clientId: 'another-client' }, 'third')).toThrow('instance reached');
    expect(f.sessions.snapshot().events.map(event => event.type)).toContain('global_quota');
  });

  it('counts attempts, aggregates repeated rate rejections, and recovers after the minute window', () => {
    const f = fixture();
    f.sessions.setPolicy({ ...DEFAULT_SESSION_POLICY, handshakesPerMinute: 2 });
    const first = f.sessions.admit(owner, 'one');
    f.sessions.closed(first);
    f.sessions.closed(f.sessions.admit(owner, 'two'));
    for (let i = 0; i < 15; i++) expect(() => f.sessions.admit(owner, 'blocked')).toThrow(SessionAdmissionError);
    expect(f.sessions.snapshot().events.filter(event => event.type === 'rate_limited')).toMatchObject([{ count: 15 }]);
    f.sessions.admit(other, 'unaffected');
    f.advance(60000);
    expect(() => f.sessions.admit(owner, 'next minute')).not.toThrow();
  });

  it('rejects exactly at the heap cutoff, logs it, and leaves existing sessions usable', async () => {
    const f = fixture();
    f.memory(599);
    const session = f.sessions.admit(owner, 'existing');
    f.memory(600);
    expect(() => f.sessions.admit(other, 'new')).toThrow('60% safety cutoff');
    expect(f.sessions.snapshot().memory.admissionBlocked).toBe(true);
    await expect(f.sessions.request(session, async () => 'read')).resolves.toBe('read');
    expect(f.sessions.snapshot().events[0]).toMatchObject({ type: 'memory_rejected', count: 1 });
    f.memory(500);
    expect(() => f.sessions.admit(other, 'recovered')).not.toThrow();
  });

  it('applies lower quotas only to new sessions and refuses invalid policy without changing it', () => {
    const f = fixture();
    f.sessions.admit(owner, 'one');
    f.sessions.admit(owner, 'two');
    f.sessions.setPolicy({ ...DEFAULT_SESSION_POLICY, maxPerClient: 1, maxTotal: 1 });
    expect(f.sessions.snapshot().active).toHaveLength(2);
    expect(() => f.sessions.admit(other, 'blocked')).toThrow('instance reached');
    expect(() => f.sessions.setPolicy({ ...DEFAULT_SESSION_POLICY, maxPerClient: 501 })).toThrow();
    expect(() => f.sessions.setPolicy({ ...DEFAULT_SESSION_POLICY, idleMinutes: 0 })).toThrow();
    expect(f.sessions.snapshot().policy.maxTotal).toBe(1);
  });

  it('keeps ten days without a row cap, paginates without duplicates, and prunes by age', () => {
    const f = fixture();
    for (let i = 0; i < 625; i++) {
      const session = f.sessions.admit(owner, 'short-lived');
      f.sessions.closed(session);
    }
    const first = f.sessions.snapshot();
    expect(first.events).toHaveLength(100);
    const second = f.sessions.snapshot(first.nextCursor!);
    expect(second.events).toHaveLength(100);
    const all = [...first.events, ...second.events];
    let cursor = second.nextCursor;
    while (cursor !== null) {
      const page = f.sessions.snapshot(cursor);
      all.push(...page.events);
      cursor = page.nextCursor;
    }
    expect(all).toHaveLength(625);
    expect(new Set(all.map(event => event.sequence)).size).toBe(625);
    f.advance(10 * 86400000 - 1);
    expect(f.sessions.snapshot().events).toHaveLength(100);
    f.advance(2);
    f.sessions.sweep();
    expect(f.sessions.snapshot().events).toEqual([]);
    expect(f.store.db.prepare('SELECT count(*) AS n FROM mcp_session_events').get()?.n).toBe(0);
    f.sessions.closed(f.sessions.admit(owner, 'after pruning'));
    expect(f.sessions.snapshot().events[0].sequence).toBeGreaterThan(first.events[0].sequence);
  });

  it('persists policy and audit events across SQLite store reopen, but not active sessions', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'wm-session-persistence-'));
    try {
      const path = join(directory, 'store.sqlite');
      let store = openStore(path);
      let sessions = new McpSessions(store.db);
      sessions.setPolicy({ ...DEFAULT_SESSION_POLICY, idleMinutes: 75 });
      sessions.admit(owner, 'persisted audit');
      await sessions.close(); store.close();
      store = openStore(path);
      sessions = new McpSessions(store.db);
      try {
        expect(sessions.snapshot().policy.idleMinutes).toBe(75);
        expect(sessions.snapshot().active).toEqual([]);
        expect(sessions.snapshot().events.map(event => event.type)).toEqual(['server_shutdown', 'policy_updated']);
      } finally { await sessions.close(); store.close(); }
    } finally { rmSync(directory, { recursive: true, force: true }); }
  });

  it('logs cleanup failures explicitly without retaining the expired session', async () => {
    const f = fixture(), log = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const session = f.sessions.admit(owner, 'failed close');
      session.close = async () => { throw new Error('test cleanup failure'); };
      f.advance(61 * 60000);
      f.sessions.sweep();
      await f.sessions.close();
      expect(f.sessions.snapshot().active).toEqual([]);
      expect(f.sessions.snapshot().events[0].type).toBe('cleanup_failed');
      expect(log).toHaveBeenCalled();
    } finally { log.mockRestore(); }
  });

  it('handles and logs an audit failure while reporting a cleanup failure', async () => {
    const f = fixture(), log = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const session = f.sessions.admit(owner, 'failed close and audit');
      const error = new Error('test cleanup failure');
      session.close = async () => { throw error; };
      f.store.db.exec(`CREATE TRIGGER reject_cleanup_audit BEFORE INSERT ON mcp_session_events
        WHEN NEW.type='cleanup_failed'
        BEGIN SELECT RAISE(FAIL,'test audit storage failure'); END`);
      f.advance(61 * 60000);
      f.sessions.sweep();
      await new Promise<void>(resolve => setImmediate(resolve));
      await expect(f.sessions.close()).resolves.toBeUndefined();
      expect(f.sessions.snapshot().active).toEqual([]);
      expect(f.sessions.snapshot().events[0].type).toBe('idle_expired');
      expect(log).toHaveBeenNthCalledWith(1, '[mcp-sessions] Resource cleanup failed:', error);
      expect(log).toHaveBeenNthCalledWith(2, '[mcp-sessions] Unable to persist cleanup failure:',
        expect.objectContaining({ message: 'test audit storage failure' }));
    } finally { log.mockRestore(); }
  });
});
