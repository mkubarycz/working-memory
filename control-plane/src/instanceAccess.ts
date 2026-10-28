import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import type { InstanceIdentity } from './instanceIdentity.js';
import { defaultInstancePermissions, emptyInstancePermissions, instancePermissionsSchema, permissionRequestSchema,
  permits, selectedPermissions, type InstancePermissions, type PermissionSelection } from './instancePermissions.js';

export const credentialHash = (value: string): string => createHash('sha256').update(value).digest('hex');
const lifetime = 90 * 24 * 60 * 60 * 1000;
const requestLifetime = 10 * 60 * 1000;

export class AccessError extends Error {
  constructor(readonly status: number, message: string) { super(message); }
}

export interface InstancePrincipal {
  key: string;
  role: 'owner' | 'client';
  access: 'read' | 'write';
  clientId?: string;
  permissions: InstancePermissions;
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
  for (const table of ['instance_clients', 'instance_access_requests']) {
    if (!db.prepare(`PRAGMA table_info(${table})`).all().some(column => column.name === 'permissions')) {
      db.exec(`ALTER TABLE ${table} ADD COLUMN permissions TEXT`);
    }
    if (!db.prepare('PRAGMA table_info(instance_access_requests)').all().some(column => column.name === 'purpose')) {
      db.exec("ALTER TABLE instance_access_requests ADD COLUMN purpose TEXT NOT NULL DEFAULT 'access' CHECK(purpose IN ('access','permissions'))");
    }
  }
}

function permissions(row: Record<string, unknown>): InstancePermissions {
  return row.permissions === null || row.permissions === undefined
    ? defaultInstancePermissions(row.access === 'write' ? 'write' : 'read')
    : instancePermissionsSchema.parse(JSON.parse(String(row.permissions)));
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
    if (this.identity.authenticate(token)) return { key: credentialHash(token), role: 'owner', access: 'write', permissions: defaultInstancePermissions('write') };
    const client = this.db.prepare(`SELECT id,access,permissions FROM instance_clients
      WHERE credential_hash=? AND revoked_at IS NULL AND expires_at>?`).get(credentialHash(token), this.clock());
    return client ? { key: credentialHash(token), role: 'client', clientId: String(client.id),
      access: client.access === 'write' ? 'write' : 'read', permissions: permissions(client) } : null;
  }

  request(input: { label: string; access: 'read' | 'write'; refresh: boolean }, token: string, source: string) {
    this.limitRequests();
    const now = this.clock();
    const previous = input.refresh
      ? this.db.prepare('SELECT * FROM instance_clients WHERE credential_hash=? AND revoked_at IS NULL').get(credentialHash(token))
      : undefined;
    if (input.refresh && !previous) {
      throw new AccessError(401, 'Refresh requires the previous client credential in the Authorization header. Revoked or unknown credentials must request new access.');
    }
    const requestId = randomUUID(), requestSecret = randomBytes(32).toString('base64url');
    const access = previous ? String(previous.access) : input.access;
    const label = previous ? String(previous.label) : input.label;
    this.db.exec('BEGIN IMMEDIATE');
    try {
      if (previous) {
        this.db.prepare("UPDATE instance_access_requests SET state='denied' WHERE client_id=? AND state IN ('pending','approved')").run(previous.id);
      }
      this.db.prepare(`INSERT INTO instance_access_requests
        (id,secret_hash,label,client_id,access,source,state,created_at,expires_at,permissions) VALUES(?,?,?,?,?,?,'pending',?,?,?)`)
        .run(requestId, credentialHash(requestSecret), label, previous?.id ?? null, access, source, now, now + requestLifetime,
          JSON.stringify(previous ? permissions(previous) : defaultInstancePermissions(input.access)));
      this.db.exec('COMMIT');
    } catch (error) { this.db.exec('ROLLBACK'); throw error; }
    return { requestId, requestSecret, state: 'pending', expiresAt: now + requestLifetime,
      message: 'Ask the instance owner to approve this request in Working Memory > Settings > Access. Poll wm-identity-claim-access with this requestId and requestSecret. No token is issued before approval.' };
  }

  private limitRequests(): void {
    const now = this.clock();
    if (now - this.requestWindow >= 60000) { this.requestWindow = now; this.requestCount = 0; }
    if (++this.requestCount > 10) throw new AccessError(429, 'Too many access requests. Try again in a minute.');
    this.db.prepare('DELETE FROM instance_access_requests WHERE expires_at<=?').run(now);
    const count = this.db.prepare('SELECT count(*) AS count FROM instance_access_requests').get()!;
    if (Number(count.count) >= 100) throw new AccessError(429, 'Access request queue is full. Ask the owner to review requests in Settings > Access.');
  }

  requestPermissions(token: string, input: PermissionSelection[], source: string) {
    const principal = this.authenticate(token);
    if (principal?.role !== 'client' || !principal.clientId) throw new AccessError(401, 'An active client credential is required to request additional permissions.');
    const delta = emptyInstancePermissions();
    for (const { category, operation } of permissionRequestSchema.parse(input)) {
      if (!permits(principal.permissions, category, operation)) {
        if (operation === 'run') delta.tools.run = true;
        else delta[category][operation] = true;
      }
    }
    if (!selectedPermissions(delta).length) return { state: 'granted' as const };
    this.checkOAuthPermissions(principal.clientId, 'client', delta);
    const now = this.clock(), encoded = JSON.stringify(delta);
    const existing = this.db.prepare(`SELECT id,expires_at,state FROM instance_access_requests
      WHERE client_id=? AND purpose='permissions' AND state IN ('pending','denied') AND expires_at>? AND permissions=?
      ORDER BY created_at DESC LIMIT 1`)
      .get(principal.clientId, now, encoded);
    if (existing) return { state: existing.state === 'denied' ? 'denied' as const : 'pending' as const,
      requestId: String(existing.id), expiresAt: Number(existing.expires_at), permissions: delta };
    this.limitRequests();
    const client = this.db.prepare('SELECT label FROM instance_clients WHERE id=?').get(principal.clientId)!;
    const requestId = randomUUID();
    this.db.prepare(`INSERT INTO instance_access_requests
      (id,secret_hash,label,client_id,access,source,state,created_at,expires_at,permissions,purpose)
      VALUES(?,?,?,?,?,?,'pending',?,?,?,'permissions')`)
      .run(requestId, credentialHash(randomBytes(32).toString('base64url')), client.label, principal.clientId,
        principal.access, source, now, now + requestLifetime, encoded);
    return { state: 'pending' as const, requestId, expiresAt: now + requestLifetime, permissions: delta };
  }

  claim(id: string, secret: string) {
    const row = this.db.prepare('SELECT * FROM instance_access_requests WHERE id=?').get(id);
    if (!row || !timingSafeEqual(Buffer.from(String(row.secret_hash), 'hex'), Buffer.from(credentialHash(secret), 'hex'))) {
      throw new AccessError(404, 'Access request not found. Start a new request with wm-identity-request-access.');
    }
    return this.claimApproved(id);
  }

  // Internal OAuth exchange also uses this after proving the single-use code and PKCE.
  claimApproved(id: string) {
    const row = this.db.prepare('SELECT * FROM instance_access_requests WHERE id=?').get(id);
    if (!row) throw new AccessError(404, 'Access request not found. Request access again.');
    if (row.purpose === 'permissions') throw new AccessError(403, 'Permission requests update the existing identity on approval and cannot issue credentials.');
    if (Number(row.expires_at) <= this.clock()) throw new AccessError(410, 'Access request expired. Request access again and ask the owner to approve it.');
    if (row.state === 'pending') return { state: 'pending' as const, message: 'Waiting for approval in Working Memory > Settings > Access.' };
    if (row.state !== 'approved') throw new AccessError(403, 'Access request was denied or already claimed. Request new access if needed.');
    const token = randomBytes(32).toString('base64url'), now = this.clock(), expiresAt = now + lifetime;
    const clientId = row.client_id ? String(row.client_id) : randomUUID();
    this.db.exec('BEGIN IMMEDIATE');
    try {
      if (row.client_id) {
        const result = this.db.prepare(`UPDATE instance_clients SET credential_hash=?,expires_at=?,permissions=?
          WHERE id=? AND revoked_at IS NULL`).run(credentialHash(token), expiresAt, JSON.stringify(permissions(row)), clientId);
        if (!result.changes) throw new AccessError(403, 'This identity was revoked. Request new access instead of refreshing it.');
      } else {
        this.db.prepare(`INSERT INTO instance_clients
          (id,label,credential_hash,access,created_at,expires_at,permissions) VALUES(?,?,?,?,?,?,?)`)
          .run(clientId, row.label, credentialHash(token), row.access, now, expiresAt, JSON.stringify(permissions(row)));
      }
      this.db.prepare("UPDATE instance_access_requests SET state='consumed',client_id=? WHERE id=?").run(clientId, id);
      this.db.prepare("UPDATE instance_access_requests SET state='denied' WHERE client_id=? AND id<>? AND state IN ('pending','approved')").run(clientId, id);
      if (permissions(row).tools.run) {
        this.ensureToolCaller(clientId, String(row.label));
        if (row.client_id && this.db.prepare("SELECT name FROM sqlite_master WHERE name='host_task_apps'").get()) {
          this.revokeToolGrants(clientId);
          this.db.prepare('UPDATE host_task_apps SET revoked_at=NULL WHERE id=?').run(clientId);
        }
      }
      this.db.exec('COMMIT');
    } catch (error) { this.db.exec('ROLLBACK'); throw error; }
    return { state: 'issued' as const, clientId, token, expiresAt, access: row.access,
      message: 'Send this token as Authorization: Bearer on every data request. Keep it private. To refresh, connect to the identity MCP with this token and request refresh; owner approval is required again.' };
  }

  snapshot(ownerToken: string) {
    this.requireOwner(ownerToken);
    return {
      requests: this.db.prepare(`SELECT id,label,client_id AS clientId,access,permissions,purpose,source,state,
        created_at AS createdAt,expires_at AS expiresAt FROM instance_access_requests
        WHERE state IN ('pending','approved','denied') ORDER BY created_at DESC`).all().map(row => ({ ...row, permissions: permissions(row) })),
      clients: this.db.prepare(`SELECT id,label,access,permissions,created_at AS createdAt,expires_at AS expiresAt,
        revoked_at AS revokedAt FROM instance_clients ORDER BY created_at DESC`).all().map(row => ({ ...row, permissions: permissions(row) })),
    };
  }

  setPermissions(ownerToken: string, id: string, target: 'request' | 'client', input: unknown): void {
    this.requireOwner(ownerToken);
    const checked = instancePermissionsSchema.parse(input);
    if (target === 'request' && this.db.prepare('SELECT purpose FROM instance_access_requests WHERE id=?').get(id)?.purpose === 'permissions') {
      throw new AccessError(409, 'Approve or deny this permission request. Edit the client record to change other permissions.');
    }
    this.checkOAuthPermissions(id, target, checked);
    const table = target === 'request' ? 'instance_access_requests' : 'instance_clients';
    const guard = target === 'request' ? "state IN ('pending','approved') AND expires_at>?" : 'revoked_at IS NULL AND expires_at>?';
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const changed = this.db.prepare(`UPDATE ${table} SET permissions=? WHERE id=? AND ${guard}`)
        .run(JSON.stringify(checked), id, this.clock());
      if (!changed.changes) throw new AccessError(409, 'Access changed or expired. Reopen permissions and retry.');
      if (target === 'client') {
        this.db.prepare("UPDATE instance_access_requests SET state='denied' WHERE client_id=? AND state IN ('pending','approved')").run(id);
        if (!checked.tools.run) this.revokeToolGrants(id);
        else {
          const client = this.db.prepare('SELECT label FROM instance_clients WHERE id=?').get(id)!;
          this.ensureToolCaller(id, String(client.label));
        }
      }
      this.db.exec('COMMIT');
    } catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }

  private checkOAuthPermissions(id: string, target: 'request' | 'client', checked: InstancePermissions): void {
    const hasOAuth = !!this.db.prepare("SELECT name FROM sqlite_master WHERE name='instance_oauth_tokens'").get();
    const readOnlyOAuth = hasOAuth && (target === 'client'
      ? this.db.prepare(`SELECT c.id FROM instance_clients c JOIN instance_oauth_tokens t ON t.client_id=c.id
          WHERE c.id=? AND c.access='read'`).get(id)
      : this.db.prepare(`SELECT r.id FROM instance_access_requests r WHERE r.id=? AND r.access='read' AND
          (EXISTS(SELECT 1 FROM instance_oauth_flows f WHERE f.request_id=r.id)
          OR EXISTS(SELECT 1 FROM instance_oauth_tokens t WHERE t.client_id=r.client_id))`).get(id));
    if (readOnlyOAuth && (checked.tools.run || Object.values(checked).some(category => category.create || category.update || category.delete))) {
      throw new AccessError(409, 'This OAuth token requested read-only access. Reconnect with write access before granting changes or Run.');
    }
  }

  decide(ownerToken: string, id: string, approve: boolean): void {
    this.requireOwner(ownerToken);
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const request = this.db.prepare("SELECT * FROM instance_access_requests WHERE id=? AND state='pending' AND expires_at>?").get(id, this.clock());
      if (!request) throw new AccessError(409, 'This request expired or was already reviewed.');
      let state = approve ? 'approved' : 'denied';
      if (approve && request.purpose === 'permissions') {
        const client = this.db.prepare('SELECT * FROM instance_clients WHERE id=? AND revoked_at IS NULL AND expires_at>?').get(request.client_id, this.clock());
        if (!client) throw new AccessError(409, 'This client expired or was revoked. Request new access.');
        const granted = permissions(client), delta = permissions(request);
        this.checkOAuthPermissions(String(client.id), 'client', delta);
        for (const { category, operation } of selectedPermissions(delta)) {
          if (operation === 'run') granted.tools.run = true;
          else granted[category][operation] = true;
        }
        this.db.prepare('UPDATE instance_clients SET permissions=? WHERE id=?').run(JSON.stringify(granted), client.id);
        if (delta.tools.run) this.ensureToolCaller(String(client.id), String(client.label));
        this.db.prepare("UPDATE instance_access_requests SET state='denied' WHERE client_id=? AND purpose='access' AND state IN ('pending','approved')").run(client.id);
        state = 'consumed';
      }
      this.db.prepare('UPDATE instance_access_requests SET state=? WHERE id=?').run(state, id);
      this.db.exec('COMMIT');
    } catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }

  revoke(ownerToken: string, id: string): void {
    this.requireOwner(ownerToken);
    this.db.exec('BEGIN IMMEDIATE');
    try {
      if (!this.db.prepare('UPDATE instance_clients SET revoked_at=? WHERE id=? AND revoked_at IS NULL').run(this.clock(), id).changes) {
        throw new AccessError(404, 'Active client identity not found. Refresh the access list.');
      }
      this.db.prepare("UPDATE instance_access_requests SET state='denied' WHERE client_id=? AND state IN ('pending','approved')").run(id);
      this.revokeToolGrants(id);
      this.db.exec('COMMIT');
    } catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }

  private revokeToolGrants(id: string): void {
    if (!this.db.prepare("SELECT name FROM sqlite_master WHERE name='host_script_grants'").get()) return;
    this.db.prepare('UPDATE host_script_grants SET revoked_at=? WHERE app_id=? AND revoked_at IS NULL').run(this.clock(), id);
    this.db.prepare(`UPDATE host_script_jobs SET state='cancelled',error='Client execution access revoked',
      parameters_json='{}',result_json=NULL,lease_hash=NULL WHERE app_id=? AND state IN ('queued','running','succeeded','failed')`).run(id);
  }

  private ensureToolCaller(id: string, label: string): void {
    if (!this.db.prepare("SELECT name FROM sqlite_master WHERE name='host_task_apps'").get()) return;
    // A non-hex marker cannot authenticate as a host-task bearer credential.
    this.db.prepare(`INSERT INTO host_task_apps(id,credential_hash,instance_id,label,created_at,revoked_at)
      VALUES(?,?,?,?,?,NULL) ON CONFLICT(id) DO NOTHING`).run(id, `instance-client:${id}`, id, label, this.clock());
  }

  private requireOwner(token: string): void {
    if (!this.identity.authenticate(token)) throw new AccessError(401, 'Sign in as the instance owner to manage access.');
  }
}
