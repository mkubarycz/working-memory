import { randomBytes, randomUUID, createHash } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { z } from 'zod';
import {
  scriptDefinitionSchema, scriptDefinitionHash, scriptJobSchema, validateScriptArguments,
  type ScriptDefinition, type ScriptTask, type ScriptJob, type ScriptVersion,
} from './hostScriptPolicy.js';

export class HostScriptError extends Error {
  constructor(readonly status: number, message: string) { super(message); }
}
function fail(status: number, message: string): never { throw new HostScriptError(status, message); }
const uuid = z.string().uuid();
const hash = z.string().regex(/^[a-f0-9]{64}$/);
const request = z.object({
  taskId: uuid, definitionHash: hash,
  version: z.number().int().positive().optional(),
  parameters: z.record(z.string(), z.unknown()),
  idempotencyKey: z.string().min(1).max(128).regex(/^[a-zA-Z0-9._:-]+$/),
}).strict();
type Row = Record<string, string | number | null>;
const digest = (value: string) => createHash('sha256').update(value).digest('hex');

export function ensureHostScriptSchema(db: DatabaseSync): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS host_script_tasks (
      id TEXT PRIMARY KEY, definition_json TEXT NOT NULL, definition_hash TEXT NOT NULL,
      created_at INTEGER NOT NULL, revoked_at INTEGER
    );
    CREATE TABLE IF NOT EXISTS host_script_grants (
      id TEXT PRIMARY KEY, task_id TEXT NOT NULL REFERENCES host_script_tasks(id),
      app_id TEXT NOT NULL REFERENCES host_task_apps(id), definition_hash TEXT NOT NULL,
      expires_at INTEGER NOT NULL, revoked_at INTEGER
    );
    CREATE TABLE IF NOT EXISTS host_script_jobs (
      id TEXT PRIMARY KEY, task_id TEXT NOT NULL REFERENCES host_script_tasks(id),
      app_id TEXT REFERENCES host_task_apps(id), grant_id TEXT REFERENCES host_script_grants(id),
      parameters_json TEXT NOT NULL, definition_hash TEXT NOT NULL,
      idempotency_key TEXT, payload_hash TEXT, state TEXT NOT NULL,
      created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL,
      lease_hash TEXT, lease_until INTEGER, result_json TEXT, error TEXT, result_until INTEGER,
      UNIQUE(app_id, idempotency_key)
    );
    CREATE UNIQUE INDEX IF NOT EXISTS host_script_active_app
      ON host_script_jobs(app_id) WHERE app_id IS NOT NULL AND state IN ('queued','running');
  `);
  for (const [table, column] of [['host_script_tasks', 'published_version'], ['host_script_jobs', 'version']]) {
    if (!db.prepare(`PRAGMA table_info(${table})`).all().some(row => row.name === column)) {
      db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} INTEGER NOT NULL DEFAULT 1`);
    }
  }
  db.exec(`
    CREATE TABLE IF NOT EXISTS host_script_versions (
      task_id TEXT NOT NULL REFERENCES host_script_tasks(id),
      version INTEGER NOT NULL CHECK (version > 0),
      definition_json TEXT NOT NULL, definition_hash TEXT NOT NULL, created_at INTEGER NOT NULL,
      PRIMARY KEY (task_id, version)
    );
    INSERT OR IGNORE INTO host_script_versions (task_id,version,definition_json,definition_hash,created_at)
      SELECT id,published_version,definition_json,definition_hash,created_at FROM host_script_tasks;
  `);
}

export class HostScriptBroker {
  constructor(private readonly db: DatabaseSync, private readonly clock: () => number) {}
  private rows(sql: string, ...values: (string | number | null)[]): Row[] {
    return this.db.prepare(sql).all(...values) as Row[];
  }
  private row(sql: string, ...values: (string | number | null)[]): Row | undefined {
    return this.rows(sql, ...values)[0];
  }
  private write(sql: string, ...values: (string | number | null)[]): void {
    this.db.prepare(sql).run(...values);
  }
  private audit(action: string, id: string): void {
    this.write('INSERT INTO host_task_audit(at,action,subject_id) VALUES(?,?,?)', this.clock(), `script_${action}`, id);
  }
  private definition(row: Row): ScriptDefinition {
    const definition = scriptDefinitionSchema.parse(JSON.parse(String(row.definition_json)));
    if (scriptDefinitionHash(definition) !== row.definition_hash) fail(409, 'Registered script integrity check failed');
    return definition;
  }
  private task(row: Row, includeDraft = false): ScriptTask {
    const { source: _source, ...definition } = this.definition(row);
    const latest = includeDraft ? this.definition(this.row(
      'SELECT * FROM host_script_versions WHERE task_id=? ORDER BY version DESC LIMIT 1', row.id,
    )!) : undefined;
    return { ...definition, id: String(row.id), definitionHash: String(row.definition_hash),
      ...(latest ? { draftName: latest.name, draftDescription: latest.description } : {}),
      createdAt: Number(row.created_at), revokedAt: row.revoked_at === null ? null : Number(row.revoked_at),
      publishedVersion: Number(row.published_version),
      latestVersion: Number(this.row('SELECT MAX(version) AS version FROM host_script_versions WHERE task_id=?', row.id)!.version) };
  }
  private version(row: Row): ScriptVersion {
    return { version: Number(row.version), definition: this.definition(row),
      definitionHash: String(row.definition_hash), createdAt: Number(row.created_at) };
  }
  private versionRow(taskId: string, version: number): Row {
    return this.row('SELECT * FROM host_script_versions WHERE task_id=? AND version=?', taskId, version)
      ?? fail(404, 'Script version not found');
  }
  private saveVersion(taskId: string, definition: ScriptDefinition): ScriptVersion {
    const task = this.liveTask(taskId);
    if (definition.hostId !== this.definition(task).hostId) fail(400, 'A task version must stay on its registered host');
    const latest = this.row('SELECT * FROM host_script_versions WHERE task_id=? ORDER BY version DESC LIMIT 1', taskId)!;
    const definitionHash = scriptDefinitionHash(definition);
    if (latest.definition_hash === definitionHash) return this.version(latest);
    const version = Number(latest.version) + 1;
    this.write('INSERT INTO host_script_versions VALUES(?,?,?,?,?)',
      taskId, version, JSON.stringify(definition), definitionHash, this.clock());
    this.audit('draft_saved', taskId);
    return this.version(this.versionRow(taskId, version));
  }
  private job(row: Row, includeResult = false): ScriptJob {
    return { id: String(row.id), taskId: String(row.task_id), appId: row.app_id === null ? null : String(row.app_id),
      state: String(row.state), createdAt: Number(row.created_at), expiresAt: Number(row.expires_at),
      resultJson: includeResult && row.result_json !== null ? String(row.result_json) : null,
      error: row.error === null ? null : String(row.error), version: Number(row.version) };
  }
  private liveTask(id: string): Row {
    return this.row('SELECT * FROM host_script_tasks WHERE id=? AND revoked_at IS NULL', id) ??
      fail(404, 'Approved script not found or revoked');
  }
  private terminate(id: string, state: string, reason: string): void {
    this.write("UPDATE host_script_jobs SET state=?,error=?,result_json=NULL,parameters_json='{}',lease_hash=NULL WHERE id=?",
      state, reason, id);
    this.audit(state, id);
  }
  cleanup(): void {
    const now = this.clock();
    for (const job of this.rows("SELECT * FROM host_script_jobs WHERE state IN ('queued','running','succeeded','failed')")) {
      const task = this.row('SELECT * FROM host_script_tasks WHERE id=? AND revoked_at IS NULL', job.task_id);
      const version = this.row('SELECT definition_hash FROM host_script_versions WHERE task_id=? AND version=?', job.task_id, job.version);
      const app = job.app_id === null || !!this.row('SELECT id FROM host_task_apps WHERE id=? AND revoked_at IS NULL', job.app_id);
      const grant = job.app_id === null ? true : !!this.row(
        'SELECT id FROM host_script_grants WHERE id=? AND app_id=? AND task_id=? AND definition_hash=? AND revoked_at IS NULL AND expires_at>?',
        job.grant_id, job.app_id, job.task_id, job.definition_hash, now,
      );
      if (!task || !app || !grant || version?.definition_hash !== job.definition_hash
        || job.app_id !== null && task.definition_hash !== job.definition_hash) {
        this.terminate(String(job.id), 'cancelled', 'Script, caller, or grant revoked or expired');
      } else if (['queued', 'running'].includes(String(job.state)) && Number(job.expires_at) <= now
        || job.state === 'running' && Number(job.lease_until) <= now
        || ['succeeded', 'failed'].includes(String(job.state)) && Number(job.result_until) <= now) {
        this.terminate(String(job.id), 'expired', 'Execution or result retention expired');
      }
    }
  }
  route(method: string, path: string, body: unknown, appId: string | null): { status: number; body: unknown } {
    this.cleanup();
    const ok = (body: unknown, status = 200) => ({ status, body });
    const admin = path.startsWith('/admin/scripts');
    const detailPath = /^\/admin\/scripts\/([a-f0-9-]{36})$/.exec(path);
    if (method === 'GET' && detailPath) {
      const task = this.row('SELECT * FROM host_script_tasks WHERE id=?', detailPath[1]) ?? fail(404, 'Script not found');
      return ok({ task: this.task(task, true), versions: this.rows(
        'SELECT * FROM host_script_versions WHERE task_id=? ORDER BY version DESC', detailPath[1],
      ).map(row => this.version(row)) });
    }
    if (method === 'GET' && path === '/admin/scripts') {
      return ok({
        tasks: this.rows('SELECT * FROM host_script_tasks ORDER BY created_at DESC').map(row => this.task(row, true)),
        grants: this.rows('SELECT * FROM host_script_grants').map(row => ({
          id: row.id, taskId: row.task_id, appId: row.app_id, definitionHash: row.definition_hash,
          expiresAt: row.expires_at, revokedAt: row.revoked_at,
        })),
        apps: this.rows('SELECT id,label,revoked_at FROM host_task_apps').map(row => ({
          id: row.id, label: row.label, revokedAt: row.revoked_at,
        })),
        jobs: this.rows('SELECT * FROM host_script_jobs ORDER BY created_at DESC LIMIT 50').map(row => this.job(row)),
      });
    }
    if (method === 'GET' && path === '/scripts') {
      return ok(this.rows(`SELECT DISTINCT t.* FROM host_script_tasks t JOIN host_script_grants g ON g.task_id=t.id
        WHERE g.app_id=? AND g.revoked_at IS NULL AND g.expires_at>? AND t.revoked_at IS NULL
        AND g.definition_hash=t.definition_hash`, appId, this.clock()).map(row => this.task(row)));
    }
    const jobPath = /^\/(?:admin\/)?scripts\/jobs\/([a-f0-9-]{36})$/.exec(path);
    if (method === 'GET' && jobPath) {
      const row = admin ? this.row('SELECT * FROM host_script_jobs WHERE id=?', jobPath[1])
        : this.row('SELECT * FROM host_script_jobs WHERE id=? AND app_id=?', jobPath[1], appId);
      if (!row) fail(404, 'Job not found');
      return ok(this.job(row, true));
    }
    if (method !== 'POST') fail(404, 'Script route not found');
    if (path === '/admin/scripts') {
      const definition = scriptDefinitionSchema.parse(body);
      const id = randomUUID();
      this.write('INSERT INTO host_script_tasks (id,definition_json,definition_hash,created_at,revoked_at) VALUES(?,?,?,?,NULL)',
        id, JSON.stringify(definition), scriptDefinitionHash(definition), this.clock());
      this.write('INSERT INTO host_script_versions VALUES(?,?,?,?,?)',
        id, 1, JSON.stringify(definition), scriptDefinitionHash(definition), this.clock());
      this.audit('registered', id);
      return ok(this.task(this.liveTask(id)), 201);
    }
    const revoke = /^\/admin\/scripts\/([a-f0-9-]{36})\/revoke$/.exec(path);
    const draft = /^\/admin\/scripts\/([a-f0-9-]{36})\/versions$/.exec(path);
    if (draft) {
      const input = z.object({ definition: scriptDefinitionSchema, expectedLatestVersion: z.number().int().positive() }).strict().parse(body);
      const task = this.task(this.liveTask(draft[1]));
      if (task.latestVersion !== input.expectedLatestVersion) fail(409, 'Task drafts changed. Read the current task before editing again.');
      return ok(this.saveVersion(draft[1], input.definition), 201);
    }
    const update = /^\/admin\/scripts\/([a-f0-9-]{36})$/.exec(path);
    if (update) {
      return ok(this.saveVersion(update[1], scriptDefinitionSchema.parse(body)), 201);
    }
    const publish = /^\/admin\/scripts\/([a-f0-9-]{36})\/publish$/.exec(path);
    if (publish) {
      const input = z.object({ version: z.number().int().positive(), expectedPublishedHash: hash }).strict().parse(body);
      const task = this.liveTask(publish[1]);
      if (task.definition_hash !== input.expectedPublishedHash) fail(409, 'Published version changed. Review the current version before publishing.');
      const version = this.versionRow(publish[1], input.version);
      this.definition(version);
      if (Number(task.published_version) !== input.version) {
        this.write('UPDATE host_script_tasks SET definition_json=?,definition_hash=?,published_version=? WHERE id=?',
          version.definition_json, version.definition_hash, input.version, publish[1]);
        this.write('UPDATE host_script_grants SET revoked_at=? WHERE task_id=? AND revoked_at IS NULL', this.clock(), publish[1]);
        this.cleanup();
        this.audit('published', publish[1]);
      }
      return ok(this.task(this.liveTask(publish[1])));
    }
    if (revoke) {
      z.object({}).strict().parse(body);
      this.liveTask(revoke[1]);
      this.write('UPDATE host_script_tasks SET revoked_at=? WHERE id=?', this.clock(), revoke[1]);
      this.cleanup();
      this.audit('revoked', revoke[1]);
      return ok({ revoked: true });
    }
    if (path === '/admin/scripts/grants') {
      const input = z.object({ taskId: uuid, appId: uuid, definitionHash: hash, expiresAt: z.number().int() }).strict().parse(body);
      const task = this.liveTask(input.taskId);
      if (task.definition_hash !== input.definitionHash) fail(409, 'Script version changed');
      if (!this.row('SELECT id FROM host_task_apps WHERE id=? AND revoked_at IS NULL', input.appId)) fail(404, 'Caller not found');
      if (input.expiresAt <= this.clock() || input.expiresAt > this.clock() + 86400000) fail(400, 'Grant must expire within 24 hours');
      this.write('UPDATE host_script_grants SET revoked_at=? WHERE task_id=? AND app_id=? AND revoked_at IS NULL',
        this.clock(), input.taskId, input.appId);
      this.cleanup();
      const id = randomUUID();
      this.write('INSERT INTO host_script_grants VALUES(?,?,?,?,?,NULL)',
        id, input.taskId, input.appId, input.definitionHash, input.expiresAt);
      this.audit('grant_approved', id);
      return ok({ id }, 201);
    }
    const revokeGrant = /^\/admin\/scripts\/grants\/([a-f0-9-]{36})\/revoke$/.exec(path);
    if (revokeGrant) {
      z.object({}).strict().parse(body);
      if (!this.row('SELECT id FROM host_script_grants WHERE id=?', revokeGrant[1])) fail(404, 'Grant not found');
      this.write('UPDATE host_script_grants SET revoked_at=? WHERE id=?', this.clock(), revokeGrant[1]);
      this.cleanup();
      this.audit('grant_revoked', revokeGrant[1]);
      return ok({ revoked: true });
    }
    if (path === '/admin/scripts/test/claim') {
      const { hostId, ...input } = request.extend({ hostId: uuid }).parse(body);
      const task = this.liveTask(input.taskId);
      const version = this.versionRow(input.taskId, input.version ?? Number(task.published_version));
      if (this.definition(version).hostId !== hostId) fail(400, 'Choose a script on this host');
      const job = scriptJobSchema.parse(this.route('POST', '/admin/scripts/test', input, null).body);
      return this.route('POST', '/admin/scripts/claim', { hostId, jobId: job.id }, null);
    }
    if (path === '/scripts/requests' || path === '/admin/scripts/test') {
      const owner = path === '/admin/scripts/test';
      const input = request.parse(body);
      const task = this.liveTask(input.taskId);
      const versionNumber = owner ? input.version ?? Number(task.published_version) : Number(task.published_version);
      const version = this.versionRow(input.taskId, versionNumber);
      const definition = this.definition(version);
      if (input.definitionHash !== version.definition_hash
        || !owner && input.version !== undefined && input.version !== versionNumber) fail(409, 'Script version changed');
      let parameters;
      try { parameters = validateScriptArguments(definition.parameters, input.parameters); }
      catch (error) { fail(400, error instanceof Error ? error.message : 'Invalid parameters'); }
      const payloadHash = digest(JSON.stringify({ taskId: input.taskId, definitionHash: input.definitionHash, parameters }));
      const prior = owner ? undefined : this.row('SELECT * FROM host_script_jobs WHERE app_id=? AND idempotency_key=?', appId, input.idempotencyKey);
      if (prior) {
        if (prior.payload_hash !== payloadHash) fail(409, 'Idempotency key already used for different parameters');
        return ok(this.job(prior));
      }
      const grant = owner ? undefined : this.row(
        'SELECT * FROM host_script_grants WHERE app_id=? AND task_id=? AND definition_hash=? AND revoked_at IS NULL AND expires_at>?',
        appId, input.taskId, input.definitionHash, this.clock(),
      );
      if (!owner && !grant) fail(403, 'An explicit unexpired grant for this script version is required');
      if (this.row("SELECT id FROM host_script_jobs WHERE state IN ('queued','running') AND (app_id=? OR app_id IS NULL AND ? IS NULL)", appId, appId)) {
        fail(409, 'A script run for this caller is already active');
      }
      if (Number(this.row('SELECT COUNT(*) AS count FROM host_script_jobs WHERE app_id IS ? AND created_at>?', appId, this.clock() - 60000)?.count) >= 10) {
        fail(429, 'At most ten script runs per minute per caller');
      }
      const id = randomUUID(), expiresAt = Math.min(this.clock() + 300000, grant ? Number(grant.expires_at) : Infinity);
      this.write(`INSERT INTO host_script_jobs
        (id,task_id,app_id,grant_id,parameters_json,definition_hash,idempotency_key,payload_hash,state,created_at,expires_at,version)
        VALUES(?,?,?,?,?,?,?,?,'queued',?,?,?)`,
        id, input.taskId, owner ? null : appId, grant?.id ?? null, JSON.stringify(parameters), input.definitionHash,
        owner ? null : input.idempotencyKey, payloadHash, this.clock(), expiresAt, versionNumber);
      this.audit('requested', id);
      return ok(this.job(this.row('SELECT * FROM host_script_jobs WHERE id=?', id)!), 202);
    }
    if (path === '/admin/scripts/claim') {
      const { hostId, jobId } = z.object({ hostId: uuid, jobId: uuid.optional() }).strict().parse(body);
      const jobs = jobId
        ? this.rows("SELECT * FROM host_script_jobs WHERE id=? AND state='queued' AND app_id IS NULL", jobId)
        : this.rows("SELECT * FROM host_script_jobs WHERE state='queued' ORDER BY created_at");
      const job = jobs.find(row => this.definition(this.versionRow(String(row.task_id), Number(row.version))).hostId === hostId);
      if (!job) return ok(null);
      const definition = this.definition(this.versionRow(String(job.task_id), Number(job.version)));
      const leaseToken = randomBytes(32).toString('hex');
      const deadline = Math.min(this.clock() + definition.timeoutMs + 5000, Number(job.expires_at));
      this.write("UPDATE host_script_jobs SET state='running',lease_hash=?,lease_until=? WHERE id=?",
        digest(leaseToken), deadline, job.id);
      this.audit('started', String(job.id));
      return ok({ jobId: job.id, leaseToken, definition, definitionHash: job.definition_hash,
        parameters: JSON.parse(String(job.parameters_json)), deadline });
    }
    if (path === '/admin/scripts/complete') {
      const input = z.object({
        jobId: uuid, leaseToken: z.string().regex(/^[a-f0-9]{64}$/),
        resultJson: z.string().max(65536).optional(), error: z.string().min(1).max(1000).optional(),
      }).strict().refine(value => (value.resultJson === undefined) !== (value.error === undefined)).parse(body);
      const job = this.row("SELECT * FROM host_script_jobs WHERE id=? AND state='running'", input.jobId);
      if (!job || digest(input.leaseToken) !== job.lease_hash) fail(409, 'Run cancelled, expired, or lease invalid');
      if (input.resultJson !== undefined) {
        if (Buffer.byteLength(input.resultJson) > 65536) fail(400, 'Result exceeds 64 KiB');
        try { JSON.parse(input.resultJson); } catch { fail(400, 'Result must be JSON'); }
      }
      this.write("UPDATE host_script_jobs SET state=?,result_json=?,error=?,parameters_json='{}',lease_hash=NULL,result_until=? WHERE id=?",
        input.error ? 'failed' : 'succeeded', input.resultJson ?? null, input.error ?? null, this.clock() + 1800000, input.jobId);
      this.audit(input.error ? 'failed' : 'succeeded', input.jobId);
      return ok(this.job(this.row('SELECT * FROM host_script_jobs WHERE id=?', input.jobId)!, true));
    }
    fail(404, 'Script route not found');
  }
}
