import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import * as fs from 'node:fs';
import type { DatabaseSync } from 'node:sqlite';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { z } from 'zod';
import { HostScriptBroker, HostScriptError, ensureHostScriptSchema } from './hostScripts.js';
import { serveHostScriptMcp } from './hostScriptMcp.js';
import { IdentityError, InstanceIdentity, passwordHintSchema } from './instanceIdentity.js';
import { InstanceFeatureStore } from './instanceFeatures.js';
import type { InstancePrincipal } from './instanceAccess.js';
import { permits } from './instancePermissions.js';

// Standalone control-plane compilation cannot import root shared runtime files.
// Keep this boundary predicate parity-tested against shared/hostTasks.ts.
export function isHostTaskCredential(value: unknown): value is string {
  return typeof value === 'string' && /^[A-Za-z0-9_-]{32,256}$/.exec(value)?.[0] === value;
}

const scope = Object.freeze({
  organization: 'CXPPMO', project: 'Customers',
  identity: 'mkubarycz@microsoft.com', areaPath: 'Customers\\Comcast',
});
export const HOST_TASK_OPERATION = Object.freeze({
  capability: 'thrive.sync.read', version: 4, scope,
  actions: Object.freeze(['wit_query/wiql', 'wit_work_item/get', 'wit_work_item/get_type']),
  fields: Object.freeze(['System.Id', 'System.Title', 'System.State', 'System.WorkItemType', 'System.Rev', 'System.CreatedBy', 'System.AssignedTo', 'System.AreaPath', 'System.ChangedDate']),
  resultSchemaVersion: 1,
  outputFields: Object.freeze(['id', 'title', 'state', 'type', 'revision', 'classification', 'createdBy', 'assignedTo', 'areaPath', 'changedAt', 'url',
    'stateMetadata.type', 'stateMetadata.state', 'stateMetadata.category', 'stateMetadataHash', 'stateMetadataVersion']),
  query: "SELECT [System.Id] FROM WorkItems WHERE [System.TeamProject] = 'Customers' AND ([System.CreatedBy] = 'mkubarycz@microsoft.com' OR [System.AssignedTo] = 'mkubarycz@microsoft.com' OR [System.AreaPath] UNDER 'Customers\\Comcast') ORDER BY [System.Id]",
  budgets: Object.freeze({ records: 200, chunks: 4, recordsPerChunk: 50, bytes: 131072, durationMs: 60000, attempts: 3,
    queryCalls: 4, detailCalls: 200, typeCalls: 32 }),
});
export const hostTaskHash = (value: unknown): string =>
  createHash('sha256').update(JSON.stringify(value, (_key, item: unknown) =>
    item && typeof item === 'object' && !Array.isArray(item)
      ? Object.fromEntries(Object.entries(item).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0))
      : item)).digest('hex');
// Descriptor pin only, never executable-byte verification. Production remains blocked.
// A reviewed operation change must deliberately update both version and pinned digest.
export const HOST_TASK_POLICY_HASH = '55647153d96cfebbd301392a91d9cbb47635ab981dae25dfed26221737d33352';
/** Compatibility alias: this is never an implementation-byte hash. */
export const HOST_TASK_OPERATION_HASH = HOST_TASK_POLICY_HASH;
export const HOST_TASK_BLOCKED_REASON =
  'Execution blocked: verified Windows current-user effective identity, immutable implementation bytes/publisher, and Agency/Microsoft identity evidence are unavailable. A matching policy hash identifies only the reviewed read-only descriptor, never executable code. Provision an app and approve its fixed-scope grant; production execution remains unavailable.';
export const HOST_TASK_CLEANUP_INTERVAL_MS = 30000;

export interface HostTaskFixtureSnapshot {
  asOf: string;
  membershipIds: number[];
  detailIds: number[];
  recordHashes: Record<string, string>;
  memberStates: Array<{ id: number; type: string; state: string }>;
  stateMetadata: Array<{ type: string; state: string; category: string }>;
}
/**
 * Test double only, NOT a production code/Agency verifier. There is deliberately
 * no production implementation or HTTP/environment way to install this fixture.
 * Evidence is obtained independently of runner submissions and cached app IDs.
 */
export interface HostTaskExecutionFixture {
  readonly fixtureOnly: true;
  verifyIdentity(identity: { windowsSid: string; tenantId: string }): boolean;
  snapshotEvidence(input: {
    windowsSid: string; tenantId: string; requestHash: string;
    request: { mode: 'full' | 'incremental'; checkpoint?: string; knownIds: number[] };
  }): HostTaskFixtureSnapshot | null;
}
export interface HostTaskOptions {
  hostTaskAdminCredential?: string;
  hostTaskClock?: () => number;
  hostTaskExecutionFixture?: HostTaskExecutionFixture;
}

/** Only an explicitly configured, owner-only regular file can enable admin. */
export function loadHostTaskAdminCredential(
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
): string | undefined {
  const filename = env.WM_HOST_TASK_ADMIN_TOKEN_FILE;
  if (filename === undefined) return undefined;
  let fd: number | undefined;
  try {
    // Node's file mode API cannot verify a Windows ACL.
    if (platform === 'win32' || typeof process.getuid !== 'function' ||
        typeof fs.constants.O_NOFOLLOW !== 'number') throw new Error();
    fd = fs.openSync(filename, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
    const stat = fs.fstatSync(fd);
    if (!stat.isFile() || stat.size < 1 || stat.size > 4096 ||
        stat.uid !== process.getuid() || (stat.mode & 0o077) !== 0 ||
        (stat.mode & 0o400) === 0) throw new Error();
    const buffer = Buffer.alloc(4097);
    const length = fs.readSync(fd, buffer, 0, buffer.length, 0);
    const after = fs.fstatSync(fd);
    if (length !== stat.size || after.size !== stat.size || after.mtimeMs !== stat.mtimeMs ||
        after.ctimeMs !== stat.ctimeMs) throw new Error();
    const token = buffer.subarray(0, length).toString('utf8').trim();
    if (!isHostTaskCredential(token)) throw new Error();
    return token;
  } catch {
    // Do not include filenames, credentials or raw filesystem errors.
    throw new Error('Unsafe or unavailable host-task admin token file; protected administration remains disabled.');
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
}

// Kept identical to append-only schema/021_host_tasks.sql, like Store's resource schema.
export function ensureHostTaskSchema(db: DatabaseSync): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS host_task_apps (
      id TEXT PRIMARY KEY, credential_hash TEXT NOT NULL UNIQUE,
      instance_id TEXT NOT NULL UNIQUE, label TEXT NOT NULL, created_at INTEGER NOT NULL, revoked_at INTEGER
    );
    CREATE TABLE IF NOT EXISTS host_task_grants (
      id TEXT PRIMARY KEY, app_id TEXT NOT NULL REFERENCES host_task_apps(id),
      windows_sid TEXT NOT NULL, tenant_id TEXT NOT NULL,
      expires_at INTEGER NOT NULL, generation INTEGER NOT NULL, revoked_at INTEGER,
      operation_hash TEXT NOT NULL, operation_json TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS host_task_runners (
      id TEXT PRIMARY KEY, credential_hash TEXT NOT NULL UNIQUE,
      windows_sid TEXT NOT NULL, tenant_id TEXT NOT NULL, created_at INTEGER NOT NULL, revoked_at INTEGER
    );
    CREATE TABLE IF NOT EXISTS host_task_jobs (
      id TEXT PRIMARY KEY, app_id TEXT NOT NULL REFERENCES host_task_apps(id),
      grant_id TEXT REFERENCES host_task_grants(id), grant_generation INTEGER,
      grant_hash TEXT, request_json TEXT NOT NULL,
      idempotency_key TEXT NOT NULL, payload_hash TEXT NOT NULL, operation_hash TEXT NOT NULL,
      state TEXT NOT NULL, created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL,
      manual_refresh INTEGER NOT NULL, attempt INTEGER NOT NULL DEFAULT 0,
      runner_id TEXT REFERENCES host_task_runners(id), lease_hash TEXT, lease_until INTEGER,
      result_json TEXT, result_hash TEXT, result_until INTEGER, blocked_reason TEXT,
      UNIQUE(app_id, idempotency_key)
    );
    CREATE UNIQUE INDEX IF NOT EXISTS host_task_active_scope
      ON host_task_jobs(app_id) WHERE state IN ('queued', 'running');
    CREATE UNIQUE INDEX IF NOT EXISTS host_task_awaiting_app
      ON host_task_jobs(app_id) WHERE state='awaiting-approval';
    CREATE TABLE IF NOT EXISTS host_task_audit (
      id INTEGER PRIMARY KEY, at INTEGER NOT NULL, action TEXT NOT NULL, subject_id TEXT NOT NULL
    );
  `);
  ensureHostScriptSchema(db);
}

class BrokerError extends Error {
  constructor(readonly status: number, readonly code: string) { super(code); }
}
function fail(status: number, code: string): never { throw new BrokerError(status, code); }
const text = z.string().min(1).max(200).regex(/^[^\u0000-\u001f\u007f]*$/);
const identityLabel = text.regex(/^[^\p{Cf}\p{Cc}\p{Zl}\p{Zp}]*$/u);
const uuid = z.string().uuid();
const identitySchema = z.object({
  windowsSid: z.string().regex(/^S-1-(?:\d+-){1,13}\d+$/).max(184),
  tenantId: uuid,
}).strict();
const requestSchema = z.object({
  capability: z.literal('thrive.sync.read'),
  idempotencyKey: z.string().min(1).max(128).regex(/^[a-zA-Z0-9._:-]+$/),
  manualRefresh: z.boolean().default(false),
  mode: z.enum(['full', 'incremental']).default('full'),
  checkpoint: z.string().datetime({ precision: 3 }).optional(),
  knownIds: z.array(z.number().int().positive().max(2147483647)).max(200).default([]),
}).strict().superRefine((input, ctx) => {
  if (input.mode === 'incremental' && !input.checkpoint) ctx.addIssue({ code: 'custom', message: 'checkpoint_required' });
  if (input.mode === 'full' && input.checkpoint) ctx.addIssue({ code: 'custom', message: 'full_checkpoint_not_allowed' });
  if (new Set(input.knownIds).size !== input.knownIds.length) ctx.addIssue({ code: 'custom', message: 'duplicate_known_id' });
}).transform(input => ({ ...input, knownIds: [...input.knownIds].sort((a, b) => a - b) }));
const recordSchema = z.object({
  id: z.number().int().positive().max(2147483647),
  title: text,
  state: text.max(40),
  type: text.max(128),
  revision: z.number().int().positive().max(2147483647),
  classification: z.enum(['OPEN', 'CLOSED', 'UNCLASSIFIED']),
  assignedTo: z.string().email().max(254).nullable(),
  createdBy: z.string().email().max(254).nullable(),
  areaPath: text.max(256),
  changedAt: z.string().datetime(),
  url: z.string().max(256),
}).strict().refine(r =>
  (r.createdBy?.toLowerCase() === scope.identity || r.assignedTo?.toLowerCase() === scope.identity ||
    r.areaPath === scope.areaPath || r.areaPath.startsWith(`${scope.areaPath}\\`)) &&
  r.url === `https://dev.azure.com/CXPPMO/Customers/_workitems/edit/${r.id}`);
const stateMetadataSchema = z.array(z.object({
  type: text.max(128), state: text.max(40), category: text.max(128),
}).strict()).max(2000).superRefine((rows, ctx) => {
  if (new Set(rows.map(row => JSON.stringify([row.type, row.state]))).size !== rows.length) {
    ctx.addIssue({ code: 'custom', message: 'duplicate_state_metadata' });
  }
}).transform(rows => [...rows].sort((a, b) =>
  a.type < b.type ? -1 : a.type > b.type ? 1 : a.state < b.state ? -1 : a.state > b.state ? 1 : 0));
const resultSchema = z.object({
  schemaVersion: z.literal(1),
  jobId: uuid, attempt: z.number().int().positive(), leaseToken: z.string().length(64),
  appId: uuid, grantId: uuid, grantGeneration: z.number().int().positive(),
  operationHash: z.literal(HOST_TASK_OPERATION_HASH),
  policyHash: z.literal(HOST_TASK_POLICY_HASH),
  requestHash: z.string().regex(/^[0-9a-f]{64}$/),
  mode: z.enum(['full', 'incremental']),
  asOf: z.string().datetime({ precision: 3 }),
  membershipIds: z.array(z.number().int().positive().max(2147483647)).max(200),
  removedIds: z.array(z.number().int().positive().max(2147483647)).max(200),
  dataComplete: z.literal(true),
  classificationComplete: z.boolean(),
  stateMetadata: stateMetadataSchema,
  stateMetadataHash: z.string().regex(/^[0-9a-f]{64}$/),
  stateMetadataVersion: z.literal(1),
  recordCount: z.number().int().min(0).max(200),
  chunks: z.array(z.object({
    index: z.number().int().min(0).max(3),
    sha256: z.string().regex(/^[0-9a-f]{64}$/),
    records: z.array(recordSchema).min(1).max(50),
  }).strict()).max(4),
}).strict();
const fixtureSnapshotSchema = z.object({
  asOf: z.string().datetime({ precision: 3 }),
  membershipIds: z.array(z.number().int().positive().max(2147483647)).max(200),
  detailIds: z.array(z.number().int().positive().max(2147483647)).max(200),
  recordHashes: z.record(z.string().regex(/^[1-9]\d*$/), z.string().regex(/^[0-9a-f]{64}$/)),
  memberStates: z.array(z.object({
    id: z.number().int().positive().max(2147483647), type: text.max(128), state: text.max(40),
  }).strict()).max(200),
  stateMetadata: stateMetadataSchema,
}).strict();
type Row = Record<string, string | number | null>;
type Job = Row & { id: string; app_id: string; grant_id: string | null; state: string; attempt: number };

export class HostTaskBroker {
  readonly features: InstanceFeatureStore;
  readonly identity: InstanceIdentity;
  private readonly scripts: HostScriptBroker;
  private readonly clock: () => number;
  private readonly adminHash: string | undefined;
  constructor(private readonly db: DatabaseSync, private readonly options: HostTaskOptions = {}) {
    if (hostTaskHash(HOST_TASK_OPERATION) !== HOST_TASK_OPERATION_HASH) {
      throw new Error('Host-task operation does not match its reviewed digest.');
    }
    this.clock = options.hostTaskClock ?? Date.now;
    this.features = new InstanceFeatureStore(db);
    this.identity = new InstanceIdentity(db, this.clock);
    this.scripts = new HostScriptBroker(db, this.clock);
    const credential = options.hostTaskAdminCredential;
    if (credential !== undefined && !isHostTaskCredential(credential)) {
      throw new Error('Host-task admin credential must be a 32–256 character externally provisioned secret.');
    }
    this.adminHash = credential === undefined ? undefined : hostTaskHash(credential);
    this.cleanup();
  }
  private get(sql: string, ...params: (string | number)[]): Row | undefined {
    return this.db.prepare(sql).get(...params) as Row | undefined;
  }
  private all(sql: string, ...params: (string | number)[]): Row[] {
    return this.db.prepare(sql).all(...params) as Row[];
  }
  private run(sql: string, ...params: (string | number | null)[]): void {
    this.db.prepare(sql).run(...params);
  }
  private audit(action: string, id: string): void {
    this.run('INSERT INTO host_task_audit(at,action,subject_id) VALUES(?,?,?)', this.clock(), action, id);
  }
  private fixtureAllows(identity?: { windowsSid: string; tenantId: string }): boolean {
    const fixture = this.options.hostTaskExecutionFixture;
    if (fixture?.fixtureOnly !== true) return false;
    try { return identity ? fixture.verifyIdentity(identity) === true : true; }
    catch { return false; }
  }
  private blocked(): string | null { return this.fixtureAllows() ? null : HOST_TASK_BLOCKED_REASON; }
  private terminate(id: string, state: string): void {
    this.run(`UPDATE host_task_jobs SET state=?,result_json=NULL,result_hash=NULL,result_until=NULL,
      lease_hash=NULL,lease_until=NULL,blocked_reason=NULL WHERE id=?`, state, id);
    this.audit(state, id);
  }
  private grantHash(grant: Row): string {
    return hostTaskHash(this.grant(grant));
  }
  private sweep(): void {
    if (this.get("SELECT name FROM sqlite_master WHERE name='instance_clients'")) {
      this.run(`UPDATE host_task_apps SET revoked_at=? WHERE id IN
        (SELECT id FROM instance_clients WHERE revoked_at IS NOT NULL OR expires_at<=?) AND revoked_at IS NULL`, this.clock(), this.clock());
    }
    this.scripts.cleanup();
    const now = this.clock();
    for (const job of this.all("SELECT * FROM host_task_jobs WHERE state IN ('awaiting-approval','queued','running','succeeded')") as Job[]) {
      let request: unknown;
      try { request = requestSchema.parse(JSON.parse(String(job.request_json))); }
      catch { this.terminate(job.id, 'expired'); continue; }
      const app = this.get('SELECT revoked_at FROM host_task_apps WHERE id=?', job.app_id);
      if (!app || app.revoked_at !== null) {
        this.terminate(job.id, 'cancelled'); continue;
      }
      if (job.runner_id) {
        const runner = this.get('SELECT revoked_at FROM host_task_runners WHERE id=?', String(job.runner_id));
        if (!runner || runner.revoked_at !== null) {
          this.terminate(job.id, 'cancelled'); continue;
        }
      }
      if (hostTaskHash({ ...(request as object), operationHash: HOST_TASK_OPERATION_HASH }) !== job.payload_hash ||
          (request as z.infer<typeof requestSchema>).idempotencyKey !== job.idempotency_key ||
          Number((request as z.infer<typeof requestSchema>).manualRefresh) !== job.manual_refresh ||
          job.operation_hash !== HOST_TASK_OPERATION_HASH || Number(job.expires_at) <= now && job.state !== 'succeeded') {
        this.terminate(job.id, 'expired'); continue;
      }
      if (job.state === 'awaiting-approval') {
        const grant = this.get('SELECT * FROM host_task_grants WHERE app_id=? AND revoked_at IS NULL AND expires_at>? LIMIT 1', job.app_id, now);
        if (grant && !this.get("SELECT id FROM host_task_jobs WHERE app_id=? AND state IN ('queued','running')", job.app_id)) {
          this.run(`UPDATE host_task_jobs SET state='queued',grant_id=?,grant_generation=?,grant_hash=?,
            expires_at=?,blocked_reason=? WHERE id=?`, String(grant.id), Number(grant.generation),
            this.grantHash(grant), Math.min(Number(job.expires_at), Number(grant.expires_at)), this.blocked(), job.id);
          this.audit('job_approved', job.id);
        }
        continue;
      }
      const grant = job.grant_id ? this.get('SELECT * FROM host_task_grants WHERE id=?', job.grant_id) : undefined;
      if (!grant || grant.app_id !== job.app_id || grant.revoked_at !== null ||
          Number(grant.expires_at) <= now || grant.generation !== job.grant_generation ||
          this.grantHash(grant) !== job.grant_hash ||
          grant.operation_hash !== HOST_TASK_OPERATION_HASH ||
          hostTaskHash(JSON.parse(String(grant.operation_json))) !== HOST_TASK_OPERATION_HASH ||
          job.operation_hash !== HOST_TASK_OPERATION_HASH ||
          (job.state !== 'succeeded' && Number(job.expires_at) <= now)) {
        this.terminate(job.id, 'expired');
      } else if (job.state === 'succeeded' && Number(job.result_until) <= now) {
        this.terminate(job.id, 'expired');
      } else if (job.state === 'running' && Number(job.lease_until) <= now) {
        if (job.attempt >= HOST_TASK_OPERATION.budgets.attempts) this.terminate(job.id, 'expired');
        else this.run(`UPDATE host_task_jobs SET state='queued',runner_id=NULL,
          lease_hash=NULL,lease_until=NULL,blocked_reason=? WHERE id=?`, this.blocked(), job.id);
      }
    }
  }
  private app(row: Row): object {
    return { id: row.id, label: row.label, instanceId: row.instance_id, createdAt: row.created_at, revokedAt: row.revoked_at };
  }
  private grant(row: Row): object {
    return { id: row.id, appId: row.app_id, windowsSid: row.windows_sid, tenantId: row.tenant_id,
      expiresAt: row.expires_at, generation: row.generation, revokedAt: row.revoked_at,
      policyHash: row.operation_hash, operationHash: row.operation_hash, operation: JSON.parse(String(row.operation_json)) };
  }
  private job(row: Row): object {
    return { id: row.id, appId: row.app_id, grantId: row.grant_id, state: row.state,
      createdAt: row.created_at, expiresAt: row.expires_at, attempt: row.attempt,
      blockedReason: row.state === 'queued' ? this.blocked() : row.blocked_reason };
  }
  private runner(row: Row): object {
    return { id: row.id, windowsSid: row.windows_sid, tenantId: row.tenant_id, createdAt: row.created_at, revokedAt: row.revoked_at };
  }
  private auth(token: string, kind: 'apps' | 'runners'): Row {
    return this.get(`SELECT * FROM host_task_${kind} WHERE credential_hash=? AND revoked_at IS NULL`, hostTaskHash(token)) ??
      fail(401, 'invalid_credential');
  }
  isProtectedCredential(header: string | undefined): boolean {
    if (!header?.startsWith('Bearer ')) return false;
    const hash = hostTaskHash(header.slice(7));
    return this.identity.recognizes(header.slice(7)) || hash === this.adminHash ||
      !!this.get('SELECT id FROM host_task_apps WHERE credential_hash=?', hash) ||
      !!this.get('SELECT id FROM host_task_runners WHERE credential_hash=?', hash);
  }
  private admin(token: string): void {
    if (this.identity.authenticate(token)) return;
    if (this.identity.configured()) fail(401, 'owner_sign_in_required');
    this.bootstrapAdmin(token);
  }
  private bootstrapAdmin(token: string): void {
    if (!this.adminHash) fail(503, 'admin_disabled');
    const actual = Buffer.from(hostTaskHash(token));
    if (!timingSafeEqual(actual, Buffer.from(this.adminHash))) fail(401, 'invalid_credential');
  }
  private owned(id: string, appId: string): Job {
    return this.get('SELECT * FROM host_task_jobs WHERE id=? AND app_id=?', id, appId) as Job ??
      fail(404, 'job_not_found');
  }
  private lease(body: { jobId: string; attempt: number; leaseToken: string }, runner: Row): Job {
    const job = this.get('SELECT * FROM host_task_jobs WHERE id=?', body.jobId) as Job | undefined;
    if (!job || job.state !== 'running' || job.runner_id !== runner.id ||
        job.attempt !== body.attempt || job.lease_hash !== hostTaskHash(body.leaseToken) ||
        Number(job.lease_until) <= this.clock()) fail(409, 'stale_lease');
    const grant = this.get('SELECT * FROM host_task_grants WHERE id=?', job.grant_id!)!;
    if (grant.windows_sid !== runner.windows_sid || grant.tenant_id !== runner.tenant_id ||
        !this.fixtureAllows({ windowsSid: String(runner.windows_sid), tenantId: String(runner.tenant_id) })) {
      fail(403, 'identity_not_verified');
    }
    this.sweep();
    if (this.get('SELECT state FROM host_task_jobs WHERE id=?', job.id)?.state !== 'running') fail(409, 'stale_lease');
    return job;
  }
  private validateSnapshot(input: z.infer<typeof resultSchema>, job: Job, runner: Row): void {
    const request = requestSchema.parse(JSON.parse(String(job.request_json)));
    let raw: HostTaskFixtureSnapshot | null;
    try {
      raw = this.options.hostTaskExecutionFixture?.snapshotEvidence({
        windowsSid: String(runner.windows_sid), tenantId: String(runner.tenant_id),
        requestHash: String(job.payload_hash), request,
      }) ?? null;
    } catch { fail(503, 'snapshot_evidence_unavailable'); }
    const parsed = fixtureSnapshotSchema.safeParse(raw);
    if (!parsed.success) fail(503, 'snapshot_evidence_unavailable');
    const evidence = parsed.data;
    const sorted = (values: number[]) => [...values].sort((a, b) => a - b);
    const equal = (a: unknown, b: unknown) => hostTaskHash(a) === hostTaskHash(b);
    const membership = sorted(evidence.membershipIds), details = sorted(evidence.detailIds);
    const records = input.chunks.flatMap(chunk => chunk.records);
    if (new Set(membership).size !== membership.length || new Set(details).size !== details.length ||
        details.some(id => !membership.includes(id)) || Object.keys(evidence.recordHashes).length > 200 ||
        !equal(input.membershipIds, membership) || !equal(input.removedIds, request.knownIds.filter(id => !membership.includes(id))) ||
        !equal(sorted(evidence.memberStates.map(member => member.id)), membership) ||
        !equal(input.stateMetadata, evidence.stateMetadata) ||
        input.stateMetadataHash !== hostTaskHash(evidence.stateMetadata) ||
        !equal(sorted(records.map(r => r.id)), details) || input.mode !== request.mode ||
        input.asOf !== evidence.asOf || new Date(input.asOf).toISOString() !== input.asOf ||
        Date.parse(input.asOf) > this.clock() ||
        request.checkpoint && Date.parse(request.checkpoint) >= Date.parse(input.asOf) ||
        request.mode === 'full' && !equal(details, membership) ||
        request.mode === 'incremental' && membership.some(id => !details.includes(id) && !request.knownIds.includes(id))) {
      fail(409, 'snapshot_evidence_mismatch');
    }
    const metadata = new Map<string, string>();
    if (new Set(evidence.stateMetadata.map(row => row.type)).size > HOST_TASK_OPERATION.budgets.typeCalls) {
      fail(409, 'snapshot_metadata_invalid');
    }
    for (const row of evidence.stateMetadata) {
      const key = JSON.stringify([row.type, row.state]);
      if (metadata.has(key)) fail(409, 'snapshot_metadata_invalid');
      metadata.set(key, row.category);
    }
    const classificationFor = (type: string, state: string) => {
      const category = metadata.get(JSON.stringify([type, state]));
      return ['Proposed', 'InProgress', 'Resolved'].includes(category ?? '') ? 'OPEN' :
        ['Completed', 'Removed'].includes(category ?? '') ? 'CLOSED' : 'UNCLASSIFIED';
    };
    const complete = details.length === membership.length &&
      evidence.memberStates.every(member => classificationFor(member.type, member.state) !== 'UNCLASSIFIED');
    for (const record of records) {
      const member = evidence.memberStates.find(row => row.id === record.id);
      if (!member || record.type !== member.type || record.state !== member.state ||
          record.classification !== classificationFor(record.type, record.state) ||
          evidence.recordHashes[String(record.id)] !== hostTaskHash(record)) {
        fail(409, 'snapshot_record_mismatch');
      }
    }
    if (input.classificationComplete !== complete) fail(409, 'snapshot_classification_mismatch');
    // A fixture callback may simulate a concurrent revoke/expiry; fence it too.
    this.lease(input, runner);
  }
  /** Synchronous SQLite transaction covers every authorization-to-mutation race. */
  dispatchInstanceTask(principal: InstancePrincipal, method: string, path: string, body?: unknown): unknown {
    if (!this.features.read().hostTasks) fail(503, 'host_tasks_feature_disabled');
    const operation = path === '/run' ? 'run' : method === 'GET' ? 'read'
      : path === '/tasks' ? 'create' : path.endsWith('/revoke') ? 'delete' : 'update';
    if (principal.role !== 'owner' && !permits(principal.permissions, 'tools', operation)) fail(403, 'tools_permission_required');
    const clientId = principal.clientId;
    if (principal.role !== 'owner' && !clientId) fail(403, 'client_identity_required');
    this.cleanup();
    this.db.exec('BEGIN IMMEDIATE');
    try {
      if (clientId) {
        const client = this.get('SELECT label FROM instance_clients WHERE id=? AND revoked_at IS NULL AND expires_at>?', clientId, this.clock());
        if (!client) fail(401, 'client_access_expired');
        if (path === '/run' && !this.get('SELECT id FROM host_task_apps WHERE id=? AND revoked_at IS NULL', clientId)) {
          fail(403, 'This client needs Tools Run and a new owner-approved script grant.');
        }
      }
      let result;
      if (method === 'GET' && path === '/tasks') {
        const snapshot = this.scripts.route('GET', '/admin/scripts', undefined, null).body as { tasks: unknown[] };
        result = snapshot.tasks;
      } else if (path === '/run') {
        result = this.scripts.route('POST', clientId ? '/scripts/requests' : '/admin/scripts/test', body, clientId ?? null).body;
      } else if (/^\/jobs\/[a-f0-9-]{36}$/.test(path)) {
        result = this.scripts.route('GET', `${clientId ? '' : '/admin'}/scripts${path}`, undefined, clientId ?? null).body;
      } else if (method === 'POST' && (path === '/tasks' || /^\/tasks\/[a-f0-9-]{36}(?:\/revoke)?$/.test(path))) {
        result = this.scripts.route(method, path.replace('/tasks', '/admin/scripts'), body, null).body;
      } else fail(404, 'task_route_not_found');
      this.db.exec('COMMIT');
      return result;
    } catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }

  dispatch(method: string, path: string, token: string, body?: unknown): { status: number; body: unknown } {
    if (!this.features.read().hostTasks) fail(503, 'host_tasks_feature_disabled');
    if (path === '/admin' || path.startsWith('/admin/')) this.admin(token);
    else this.auth(token, path.startsWith('/runner/') ? 'runners' : 'apps');
    this.cleanup();
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const result = this.route(method, path, token, body);
      this.db.exec('COMMIT');
      return result;
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }
  /** Trusted in-process maintenance only, never an HTTP/MCP capability. */
  cleanup(): void {
    // Persist expiration independently of a rejected requested action.
    // NULL removes live result values, not historical SQLite WAL/backup bytes.
    this.db.exec('BEGIN IMMEDIATE');
    try {
      this.sweep();
      this.db.exec('COMMIT');
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }
  private route(method: string, path: string, token: string, body?: unknown): { status: number; body: unknown } {
    if (path === '/admin/scripts' || path.startsWith('/admin/scripts/')) {
      this.admin(token);
      return this.scripts.route(method, path, body, null);
    }
    if (path === '/scripts' || path.startsWith('/scripts/')) {
      const app = this.auth(token, 'apps');
      return this.scripts.route(method, path, body, String(app.id));
    }
    const ok = (body: unknown, status = 200) => ({ status, body });
    const empty = () => z.object({}).strict().parse(body);
    if (path === '/admin' || path.startsWith('/admin/')) {
      this.admin(token);
      this.sweep();
      if (method === 'GET' && path === '/admin') {
        return ok({
          operation: HOST_TASK_OPERATION,
          operationHash: HOST_TASK_OPERATION_HASH,
          policy: {
            policyHash: HOST_TASK_POLICY_HASH, operationHash: HOST_TASK_OPERATION_HASH,
            operationVersion: HOST_TASK_OPERATION.version, scope: HOST_TASK_OPERATION.scope,
            outputFields: HOST_TASK_OPERATION.outputFields, actions: HOST_TASK_OPERATION.actions,
            budgets: HOST_TASK_OPERATION.budgets, operation: HOST_TASK_OPERATION,
          },
          apps: this.all('SELECT * FROM host_task_apps').map(r => this.app(r)),
          grants: this.all('SELECT * FROM host_task_grants').map(r => this.grant(r)),
          jobs: this.all('SELECT * FROM host_task_jobs ORDER BY created_at DESC').map(r => this.job(r)),
          runners: this.all('SELECT * FROM host_task_runners').map(r => this.runner(r)),
          executionBlockedReason: this.blocked(),
        });
      }
      if (method !== 'POST') fail(404, 'route_not_found');
      if (path === '/admin/apps') {
        const input = z.object({ label: identityLabel, instanceId: identityLabel }).strict().parse(body);
        if (this.get('SELECT id FROM host_task_apps WHERE instance_id=?', input.instanceId)) fail(409, 'instance_already_provisioned');
        const appId = randomUUID(), credential = randomBytes(32).toString('hex');
        this.run('INSERT INTO host_task_apps VALUES(?,?,?,?,?,NULL)', appId, hostTaskHash(credential), input.instanceId, input.label, this.clock());
        this.audit('app_provisioned', appId);
        return ok({ appId, credential }, 201);
      }
      if (path === '/admin/grants') {
        const input = identitySchema.extend({
          appId: uuid, expiresAt: z.number().int(),
          policyHash: z.string().regex(/^[0-9a-f]{64}$/).optional(),
          operationHash: z.string().regex(/^[0-9a-f]{64}$/).optional(),
          operationVersion: z.number().int().positive(),
        }).strict().superRefine((input, ctx) => {
          if (!input.policyHash && !input.operationHash) ctx.addIssue({ code: 'custom', message: 'policy_hash_required' });
        }).parse(body);
        if ((input.policyHash ?? input.operationHash) !== HOST_TASK_POLICY_HASH ||
            input.operationHash !== undefined && input.operationHash !== HOST_TASK_POLICY_HASH ||
            input.operationVersion !== HOST_TASK_OPERATION.version) {
          fail(409, 'policy_changed');
        }
        if (!this.get('SELECT id FROM host_task_apps WHERE id=? AND revoked_at IS NULL', input.appId)) fail(404, 'app_not_found');
        if (input.expiresAt <= this.clock() || input.expiresAt > this.clock() + 86400000) fail(400, 'invalid_expiry');
        for (const old of this.all('SELECT id FROM host_task_grants WHERE app_id=? AND revoked_at IS NULL', input.appId)) {
          this.revoke(String(old.id));
        }
        const id = randomUUID();
        this.run('INSERT INTO host_task_grants VALUES(?,?,?,?,?,1,NULL,?,?)',
          id, input.appId, input.windowsSid, input.tenantId, input.expiresAt,
          HOST_TASK_OPERATION_HASH, JSON.stringify(HOST_TASK_OPERATION));
        this.audit('grant_approved', id);
        return ok(this.grant(this.get('SELECT * FROM host_task_grants WHERE id=?', id)!), 201);
      }
      const revokeApp = /^\/admin\/apps\/([0-9a-f-]{36})\/revoke$/.exec(path);
      if (revokeApp) {
        empty();
        const app = this.get('SELECT * FROM host_task_apps WHERE id=?', revokeApp[1]);
        if (!app) fail(404, 'app_not_found');
        this.run('UPDATE host_task_apps SET revoked_at=? WHERE id=? AND revoked_at IS NULL', this.clock(), revokeApp[1]);
        for (const grant of this.all('SELECT id FROM host_task_grants WHERE app_id=? AND revoked_at IS NULL', revokeApp[1])) {
          this.revoke(String(grant.id));
        }
        for (const job of this.all("SELECT id FROM host_task_jobs WHERE app_id=? AND state IN ('awaiting-approval','queued','running','succeeded')", revokeApp[1])) {
          this.terminate(String(job.id), 'cancelled');
        }
        this.audit('app_revoked', revokeApp[1]);
        return ok(this.app(this.get('SELECT * FROM host_task_apps WHERE id=?', revokeApp[1])!));
      }
      const revoke = /^\/admin\/grants\/([0-9a-f-]{36})\/revoke$/.exec(path);
      if (revoke) {
        empty();
        if (!this.get('SELECT id FROM host_task_grants WHERE id=?', revoke[1])) fail(404, 'grant_not_found');
        this.revoke(revoke[1]);
        return ok(this.grant(this.get('SELECT * FROM host_task_grants WHERE id=?', revoke[1])!));
      }
      const deny = /^\/admin\/jobs\/([0-9a-f-]{36})\/deny$/.exec(path);
      if (deny) {
        empty();
        if (!this.get('SELECT id FROM host_task_jobs WHERE id=?', deny[1])) fail(404, 'job_not_found');
        this.terminate(deny[1], 'denied');
        return ok({ denied: true });
      }
      const revokeRunner = /^\/admin\/runners\/([0-9a-f-]{36})\/revoke$/.exec(path);
      if (revokeRunner) {
        empty();
        if (!this.get('SELECT id FROM host_task_runners WHERE id=?', revokeRunner[1])) fail(404, 'runner_not_found');
        this.run('UPDATE host_task_runners SET revoked_at=? WHERE id=? AND revoked_at IS NULL', this.clock(), revokeRunner[1]);
        for (const job of this.all("SELECT id FROM host_task_jobs WHERE runner_id=? AND state IN ('running','succeeded')", revokeRunner[1])) {
          this.terminate(String(job.id), 'cancelled');
        }
        this.audit('runner_revoked', revokeRunner[1]);
        return ok(this.runner(this.get('SELECT * FROM host_task_runners WHERE id=?', revokeRunner[1])!));
      }
      if (path === '/admin/runners') {
        const input = identitySchema.parse(body);
        if (!this.fixtureAllows(input)) fail(503, 'execution_blocked');
        const runnerId = randomUUID(), credential = randomBytes(32).toString('hex');
        this.run('INSERT INTO host_task_runners VALUES(?,?,?,?,?,NULL)',
          runnerId, hostTaskHash(credential), input.windowsSid, input.tenantId, this.clock());
        this.audit('runner_registered', runnerId);
        return ok({ runnerId, credential }, 201);
      }
      fail(404, 'route_not_found');
    }
    if (path.startsWith('/runner/')) {
      const runner = this.auth(token, 'runners');
      this.sweep();
      if (method !== 'POST') fail(404, 'route_not_found');
      if (path === '/runner/claim') {
        empty();
        if (!this.fixtureAllows({ windowsSid: String(runner.windows_sid), tenantId: String(runner.tenant_id) })) fail(503, 'execution_blocked');
        this.sweep();
        const job = this.get(`SELECT j.* FROM host_task_jobs j JOIN host_task_grants g ON g.id=j.grant_id
          WHERE j.state='queued' AND g.revoked_at IS NULL AND g.windows_sid=? AND g.tenant_id=? ORDER BY j.created_at LIMIT 1`,
          String(runner.windows_sid), String(runner.tenant_id)) as Job | undefined;
        if (!job) return ok({ job: null });
        const leaseToken = randomBytes(32).toString('hex');
        const leaseUntil = Math.min(this.clock() + 60000, Number(job.expires_at),
          Number(this.get('SELECT expires_at FROM host_task_grants WHERE id=?', job.grant_id!)!.expires_at));
        this.run(`UPDATE host_task_jobs SET state='running',attempt=attempt+1,runner_id=?,
          lease_hash=?,lease_until=?,blocked_reason=NULL WHERE id=?`,
          String(runner.id), hostTaskHash(leaseToken), leaseUntil, job.id);
        this.audit('job_dispatched', job.id);
        return ok({ jobId: job.id, attempt: job.attempt + 1, leaseToken, leaseUntil,
          appId: job.app_id, grantId: job.grant_id, grantGeneration: job.grant_generation,
          operation: HOST_TASK_OPERATION, policyHash: HOST_TASK_POLICY_HASH, operationHash: HOST_TASK_OPERATION_HASH,
          request: JSON.parse(String(job.request_json)), requestHash: job.payload_hash });
      }
      if (path === '/runner/heartbeat') {
        const input = z.object({ jobId: uuid, attempt: z.number().int().positive(), leaseToken: z.string().length(64) }).strict().parse(body);
        const job = this.lease(input, runner);
        // Heartbeats attest liveness; the fixed execution budget is never extended.
        return ok({ leaseUntil: job.lease_until });
      }
      if (path === '/runner/results') {
        const input = resultSchema.parse(body);
        const job = this.lease(input, runner);
        if (input.requestHash !== job.payload_hash) fail(409, 'request_binding_mismatch');
        if (input.appId !== job.app_id || input.grantId !== job.grant_id ||
            input.grantGeneration !== job.grant_generation) fail(409, 'principal_binding_mismatch');
        const ids = new Set<number>();
        let count = 0;
        input.chunks.forEach((chunk, index) => {
          if (chunk.index !== index || chunk.sha256 !== hostTaskHash(chunk.records)) fail(400, 'invalid_manifest');
          for (const record of chunk.records) {
            if (ids.has(record.id)) fail(400, 'duplicate_record');
            ids.add(record.id);
            count++;
          }
        });
        if (count !== input.recordCount || Buffer.byteLength(JSON.stringify(input)) > 131072) fail(400, 'invalid_manifest');
        this.validateSnapshot(input, job, runner);
        const { leaseToken: _leaseToken, ...releasedResult } = input;
        const result = JSON.stringify(releasedResult);
        this.run(`UPDATE host_task_jobs SET state='succeeded',result_json=?,result_hash=?,result_until=?,
          lease_hash=NULL,lease_until=NULL WHERE id=?`, result, hostTaskHash(JSON.parse(result)), this.clock() + 1800000, job.id);
        this.audit('result_committed', job.id);
        return ok({ accepted: true });
      }
      if (path === '/runner/failure') {
        const input = z.object({
          jobId: uuid, attempt: z.number().int().positive(), leaseToken: z.string().length(64),
          requestHash: z.string().regex(/^[0-9a-f]{64}$/),
          code: z.enum(['needs-sign-in', 'upstream-unavailable', 'incomplete-result', 'budget-exceeded']),
        }).strict().parse(body);
        const job = this.lease(input, runner);
        if (input.requestHash !== job.payload_hash) fail(409, 'request_binding_mismatch');
        this.terminate(job.id, input.code === 'needs-sign-in' ? 'needs-sign-in' : 'failed');
        this.run('UPDATE host_task_jobs SET blocked_reason=? WHERE id=?', input.code, job.id);
        return ok({ accepted: true });
      }
      fail(404, 'route_not_found');
    }
    const app = this.auth(token, 'apps');
    this.sweep();
    if (method === 'POST' && path === '/requests') {
      const input = requestSchema.parse(body);
      if (input.checkpoint && (new Date(input.checkpoint).toISOString() !== input.checkpoint ||
          Date.parse(input.checkpoint) > this.clock())) fail(400, 'invalid_checkpoint');
      const payloadHash = hostTaskHash({ ...input, operationHash: HOST_TASK_OPERATION_HASH });
      const existing = this.get('SELECT * FROM host_task_jobs WHERE app_id=? AND idempotency_key=?',
        String(app.id), input.idempotencyKey);
      if (existing) {
        if (existing.payload_hash !== payloadHash || existing.operation_hash !== HOST_TASK_OPERATION_HASH) fail(409, 'idempotency_conflict');
        return ok(this.job(existing), 202);
      }
      const grant = this.get('SELECT * FROM host_task_grants WHERE app_id=? AND revoked_at IS NULL AND expires_at>? ORDER BY expires_at DESC LIMIT 1',
        String(app.id), this.clock());
      if (grant && this.get("SELECT id FROM host_task_jobs WHERE app_id=? AND state IN ('queued','running')", String(app.id))) fail(409, 'scope_busy');
      if (!grant && this.get("SELECT id FROM host_task_jobs WHERE app_id=? AND state='awaiting-approval'", String(app.id))) fail(409, 'approval_pending');
      const latest = this.get('SELECT created_at FROM host_task_jobs WHERE app_id=? ORDER BY created_at DESC LIMIT 1', String(app.id));
      if (latest && this.clock() - Number(latest.created_at) < (input.manualRefresh ? 60000 : 300000)) fail(429, 'refresh_rate_limited');
      if (input.manualRefresh && Number(this.get('SELECT COUNT(*) AS count FROM host_task_jobs WHERE app_id=? AND manual_refresh=1 AND created_at>?',
        String(app.id), this.clock() - 3600000)!.count) >= 2) fail(429, 'manual_refresh_limit');
      const id = randomUUID();
      this.run(`INSERT INTO host_task_jobs(id,app_id,grant_id,grant_generation,grant_hash,request_json,idempotency_key,payload_hash,
        operation_hash,state,created_at,expires_at,manual_refresh,blocked_reason)
        VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)`, id, String(app.id), grant ? String(grant.id) : null,
        grant ? Number(grant.generation) : null, grant ? this.grantHash(grant) : null, JSON.stringify(input),
        input.idempotencyKey, payloadHash, HOST_TASK_OPERATION_HASH, grant ? 'queued' : 'awaiting-approval', this.clock(),
        Math.min(this.clock() + 900000, grant ? Number(grant.expires_at) : Infinity),
        input.manualRefresh ? 1 : 0, grant ? this.blocked() : 'Explicit app-specific approval is required in the trusted desktop.');
      this.audit('job_requested', id);
      return ok(this.job(this.get('SELECT * FROM host_task_jobs WHERE id=?', id)!), 202);
    }
    const match = /^\/jobs\/([0-9a-f-]{36})(?:\/(results|ack|cancel))?$/.exec(path);
    if (!match) fail(404, 'route_not_found');
    const job = this.owned(match[1], String(app.id));
    if (method === 'GET' && !match[2]) return ok(this.job(job));
    if (method === 'GET' && match[2] === 'results') {
      if (job.state !== 'succeeded' || !job.result_json) fail(409, 'result_not_available');
      const grant = this.get('SELECT * FROM host_task_grants WHERE id=?', job.grant_id!)!;
      if (!this.fixtureAllows({ windowsSid: String(grant.windows_sid), tenantId: String(grant.tenant_id) })) fail(503, 'execution_blocked');
      this.sweep();
      if (this.owned(job.id, String(app.id)).state !== 'succeeded') fail(409, 'result_not_available');
      const result = resultSchema.omit({ leaseToken: true }).parse(JSON.parse(String(job.result_json)));
      if (hostTaskHash(result) !== job.result_hash || result.jobId !== job.id || result.operationHash !== job.operation_hash ||
          result.appId !== job.app_id || result.grantId !== job.grant_id ||
          result.grantGeneration !== job.grant_generation || result.attempt !== job.attempt ||
          result.requestHash !== job.payload_hash ||
          result.recordCount !== result.chunks.reduce((n, c) => n + c.records.length, 0) ||
          new Set(result.chunks.flatMap(c => c.records.map(r => r.id))).size !== result.recordCount ||
          Buffer.byteLength(String(job.result_json)) > 131072 ||
          result.chunks.some((c, i) => c.index !== i || c.sha256 !== hostTaskHash(c.records))) fail(409, 'result_integrity_failed');
      return ok(result);
    }
    if (method === 'POST' && (match[2] === 'ack' || match[2] === 'cancel')) {
      empty();
      if (match[2] === 'ack') {
        if (job.state !== 'succeeded' && job.state !== 'acknowledged') fail(409, 'result_not_available');
        this.terminate(job.id, 'acknowledged');
      } else {
        if (!['awaiting-approval', 'queued', 'running', 'succeeded', 'cancelled'].includes(job.state)) fail(409, 'job_terminal');
        this.terminate(job.id, 'cancelled');
      }
      return ok(this.job(this.get('SELECT * FROM host_task_jobs WHERE id=?', job.id)!));
    }
    fail(404, 'route_not_found');
  }
  private revoke(id: string): void {
    this.run('UPDATE host_task_grants SET revoked_at=?,generation=generation+1 WHERE id=? AND revoked_at IS NULL', this.clock(), id);
    for (const job of this.all("SELECT id FROM host_task_jobs WHERE grant_id=? AND state IN ('queued','running','succeeded')", id)) {
      this.terminate(String(job.id), 'cancelled');
    }
    this.audit('grant_revoked', id);
  }
  async handleFeatures(req: IncomingMessage, res: ServerResponse, url: URL): Promise<void> {
    await this.features.handle(req, res, url, () => {
      const token = req.headers.authorization?.startsWith('Bearer ') ? req.headers.authorization.slice(7) : '';
      if (!this.identity.authenticate(token)) throw new IdentityError(401, 'Sign in as the instance owner to access feature settings.');
    });
  }

  async handle(req: IncomingMessage, res: ServerResponse, url: URL): Promise<void> {
    const send = (status: number, body: unknown) => {
      res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' });
      res.end(JSON.stringify(body));
    };
    try {
      if (url.search) fail(400, 'query_not_allowed');
      const auth = req.headers.authorization;
      const token = typeof auth === 'string' && auth.startsWith('Bearer ') &&
        isHostTaskCredential(auth.slice(7)) ? auth.slice(7) : '';
      const path = url.pathname.slice('/host-tasks/v1'.length);
      if (path === '/admin/identity/setup') {
        if (req.method !== 'POST' || req.headers.origin || url.search) fail(400, 'invalid_setup_request');
        this.bootstrapAdmin(token);
        if (this.identity.configured()) fail(409, 'owner_already_configured');
        if (req.headers['content-type']?.split(';')[0].trim() !== 'application/json') fail(415, 'json_required');
        const chunks: Buffer[] = [];
        let bytes = 0;
        for await (const chunk of req) {
          const buffer = Buffer.from(chunk);
          bytes += buffer.length;
          if (bytes > 16384) fail(413, 'body_too_large');
          chunks.push(buffer);
        }
        let value: unknown;
        try { value = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { fail(400, 'invalid_json'); }
        const input = z.object({ password: z.string().min(12).max(1024), passwordHint: passwordHintSchema.default('') }).strict().parse(value);
        send(200, await this.identity.initialize(input.password, input.passwordHint));
        return;
      }
      if (!this.features.read().hostTasks) {
        send(503, { error: 'feature_disabled', feature: 'hostTasks',
          message: 'Host tasks is turned off. Enable it in Settings > Features.' });
        return;
      }
      if (path === '/admin' || path.startsWith('/admin/')) this.admin(token);
      else this.auth(token, path.startsWith('/runner/') ? 'runners' : 'apps');
      if (path === '/scripts/mcp') {
        if (req.method !== 'POST') { send(405, { error: 'Stateless host-script MCP accepts POST only' }); return; }
        await serveHostScriptMcp(req, res, (method, route, input) => this.dispatch(method, route, token, input));
        return;
      }
      let body: unknown;
      if (req.method === 'POST') {
        if (req.headers['content-type']?.split(';')[0].trim() !== 'application/json') fail(415, 'json_required');
        const chunks: Buffer[] = [];
        let bytes = 0;
        for await (const chunk of req) {
          bytes += Buffer.byteLength(chunk);
          if (bytes > 131072) fail(413, 'body_too_large');
          chunks.push(Buffer.from(chunk));
        }
        try { body = JSON.parse(Buffer.concat(chunks).toString('utf8')); }
        catch { fail(400, 'invalid_json'); }
      } else if (req.headers['content-length'] && req.headers['content-length'] !== '0' || req.headers['transfer-encoding']) {
        fail(400, 'body_not_allowed');
      }
      const result = this.dispatch(req.method ?? '', path, token, body);
      send(result.status, result.body);
    } catch (error) {
      if (error instanceof IdentityError) send(error.status, { error: error.message });
      else if (error instanceof HostScriptError) send(error.status, { error: error.message });
      else if (error instanceof BrokerError) send(error.status, { error: error.code });
      else if (error instanceof z.ZodError) send(400, { error: 'invalid_request' });
      else send(500, { error: 'broker_unavailable' });
    }
  }
}
