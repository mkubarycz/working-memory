import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import type { InstanceIdentity } from './instanceIdentity.js';

export const credentialHash = (value: string): string => createHash('sha256').update(value).digest('hex');
const lifetime = 12 * 60 * 60 * 1000;
const requestLifetime = 10 * 60 * 1000;

export class AccessError extends Error {
  constructor(readonly status: number, message: string) { super(message); }
}

export interface InstancePrincipal {
  key: string;
  role: 'owner' | 'client';
  access: 'read' | 'write';
}

export function ensureInstanceAccessSchema(db: DatabaseSync): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS instance_clients (
      id TEXT PRIMARY KEY, label TEXT NOT NULL, credential_hash TEXT NOT NULL UNIQUE,
      access TEXT NOT NULL CHECK(access IN ('read','write')),
      created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL, revoked_at INTEGER
    );
    CREATE TABLE IF NOT EXISTS instance_access_requests (
      id TEXT PRIMARY KEY, secret_hash TEXT NOT NULL, label TEXT NOT NULL,
      client_id TEXT REFERENCES instance_clients(id),
      access TEXT NOT NULL CHECK(access IN ('read','write')),
      source TEXT NOT NULL,
      state TEXT NOT NULL CHECK(state IN ('pending','approved','denied','consumed')),
      created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL
    );
  `);
}

export class InstanceAccess {
  private requestWindow = 0;
  private requestCount = 0;

  constructor(
    private readonly db: DatabaseSync,
    private readonly identity: InstanceIdentity,
    private readonly clock = Date.now,
  ) { ensureInstanceAccessSchema(db); }

  authenticate(token: string): InstancePrincipal | null {
    if (!token) return null;
    if (this.identity.authenticate(token)) return { key: credentialHash(token), role: 'owner', access: 'write' };
    const client = this.db.prepare(`SELECT access FROM instance_clients
      WHERE credential_hash=? AND revoked_at IS NULL AND expires_at>?`).get(credentialHash(token), this.clock());
    return client ? { key: credentialHash(token), role: 'client', access: client.access === 'write' ? 'write' : 'read' } : null;
  }

  request(input: { label: string; access: 'read' | 'write'; refresh: boolean }, token: string, source: string) {
    const now = this.clock();
    if (now - this.requestWindow >= 60000) { this.requestWindow = now; this.requestCount = 0; }
    if (++this.requestCount > 10) throw new AccessError(429, 'Too many access requests. Try again in a minute.');
    this.db.prepare('DELETE FROM instance_access_requests WHERE expires_at<=?').run(now);
    const count = this.db.prepare('SELECT count(*) AS count FROM instance_access_requests').get()!;
    if (Number(count.count) >= 100) throw new AccessError(429, 'Access request queue is full. Ask the owner to review requests in Settings > Access.');
    const previous = input.refresh
      ? this.db.prepare('SELECT * FROM instance_clients WHERE credential_hash=? AND revoked_at IS NULL').get(credentialHash(token))
      : undefined;
    if (input.refresh && !previous) {
      throw new AccessError(401, 'Refresh requires the previous client credential in the Authorization header. Revoked or unknown credentials must request new access.');
    }
    const requestId = randomUUID(), requestSecret = randomBytes(32).toString('base64url');
    const access = previous ? String(previous.access) : input.access;
    const label = previous ? String(previous.label) : input.label;
    this.db.prepare(`INSERT INTO instance_access_requests
      (id,secret_hash,label,client_id,access,source,state,created_at,expires_at) VALUES(?,?,?,?,?,?,'pending',?,?)`)
      .run(requestId, credentialHash(requestSecret), label, previous?.id ?? null, access, source, now, now + requestLifetime);
    return { requestId, requestSecret, state: 'pending', expiresAt: now + requestLifetime,
      message: 'Ask the instance owner to approve this request in Working Memory > Settings > Access. Poll wm-identity-claim-access with this requestId and requestSecret. No token is issued before approval.' };
  }

  claim(id: string, secret: string) {
    const row = this.db.prepare('SELECT * FROM instance_access_requests WHERE id=?').get(id);
    if (!row || !timingSafeEqual(Buffer.from(String(row.secret_hash), 'hex'), Buffer.from(credentialHash(secret), 'hex'))) {
      throw new AccessError(404, 'Access request not found. Start a new request with wm-identity-request-access.');
    }
    if (Number(row.expires_at) <= this.clock()) throw new AccessError(410, 'Access request expired. Request access again and ask the owner to approve it.');
    if (row.state === 'pending') return { state: 'pending', message: 'Waiting for approval in Working Memory > Settings > Access.' };
    if (row.state !== 'approved') throw new AccessError(403, 'Access request was denied or already claimed. Request new access if needed.');
    const token = randomBytes(32).toString('base64url'), now = this.clock(), expiresAt = now + lifetime;
    const clientId = row.client_id ? String(row.client_id) : randomUUID();
    this.db.exec('BEGIN IMMEDIATE');
    try {
      if (row.client_id) {
        const result = this.db.prepare(`UPDATE instance_clients SET credential_hash=?,expires_at=?
          WHERE id=? AND revoked_at IS NULL`).run(credentialHash(token), expiresAt, clientId);
        if (!result.changes) throw new AccessError(403, 'This identity was revoked. Request new access instead of refreshing it.');
      } else {
        this.db.prepare(`INSERT INTO instance_clients
          (id,label,credential_hash,access,created_at,expires_at) VALUES(?,?,?,?,?,?)`)
          .run(clientId, row.label, credentialHash(token), row.access, now, expiresAt);
      }
      this.db.prepare("UPDATE instance_access_requests SET state='consumed' WHERE id=?").run(id);
      this.db.exec('COMMIT');
    } catch (error) { this.db.exec('ROLLBACK'); throw error; }
    return { state: 'issued', clientId, token, expiresAt, access: row.access,
      message: 'Send this token as Authorization: Bearer on every data request. Keep it private. To refresh, connect to the identity MCP with this token and request refresh; owner approval is required again.' };
  }

  snapshot(ownerToken: string) {
    this.requireOwner(ownerToken);
    return {
      requests: this.db.prepare(`SELECT id,label,client_id AS clientId,access,source,state,
        created_at AS createdAt,expires_at AS expiresAt FROM instance_access_requests
        WHERE expires_at>? AND state IN ('pending','approved') ORDER BY created_at`).all(this.clock()),
      clients: this.db.prepare(`SELECT id,label,access,created_at AS createdAt,expires_at AS expiresAt,
        revoked_at AS revokedAt FROM instance_clients ORDER BY created_at DESC`).all(),
    };
  }

  decide(ownerToken: string, id: string, approve: boolean): void {
    this.requireOwner(ownerToken);
    const result = this.db.prepare(`UPDATE instance_access_requests SET state=?
      WHERE id=? AND state='pending' AND expires_at>?`).run(approve ? 'approved' : 'denied', id, this.clock());
    if (!result.changes) throw new AccessError(409, 'This request expired or was already reviewed. Refresh the access list.');
  }

  revoke(ownerToken: string, id: string): void {
    this.requireOwner(ownerToken);
    if (!this.db.prepare('UPDATE instance_clients SET revoked_at=? WHERE id=? AND revoked_at IS NULL').run(this.clock(), id).changes) {
      throw new AccessError(404, 'Active client identity not found. Refresh the access list.');
    }
    this.db.prepare("UPDATE instance_access_requests SET state='denied' WHERE client_id=? AND state IN ('pending','approved')").run(id);
  }

  private requireOwner(token: string): void {
    if (!this.identity.authenticate(token)) throw new AccessError(401, 'Sign in as the instance owner to manage access.');
  }
}
