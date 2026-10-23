import { createHash, randomBytes, randomUUID, scrypt, timingSafeEqual } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { z } from 'zod';

export class IdentityError extends Error {
  constructor(readonly status: number, message: string) { super(message); }
}

const passwordSchema = z.string().min(12).max(1024);
export const passwordHintSchema = z.string().max(1000);
const loginSchema = z.object({ password: z.string().min(1).max(1024) }).strict();
const digest = (token: string) => createHash('sha256').update(token).digest('hex');
const sessionLifetime = 12 * 60 * 60 * 1000;
const derive = (password: string, salt: string): Promise<Buffer> => new Promise((resolve, reject) => {
  scrypt(password, salt, 32, { N: 32768, r: 8, p: 1, maxmem: 64 * 1024 * 1024 },
    (error, key) => error ? reject(error) : resolve(key));
});

export function ensureInstanceIdentitySchema(db: DatabaseSync): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS instance_owner (
      singleton INTEGER PRIMARY KEY CHECK(singleton=1), instance_id TEXT NOT NULL UNIQUE,
      password_salt TEXT NOT NULL, password_verifier TEXT NOT NULL, created_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS instance_owner_sessions (
      id TEXT PRIMARY KEY, token_hash TEXT NOT NULL UNIQUE, created_at INTEGER NOT NULL,
      expires_at INTEGER NOT NULL, revoked_at INTEGER
    );
  `);
  if (!db.prepare('PRAGMA table_info(instance_owner)').all().some(column => column.name === 'password_hint')) {
    db.exec("ALTER TABLE instance_owner ADD COLUMN password_hint TEXT NOT NULL DEFAULT ''");
  }
}

export class InstanceIdentity {
  private attempts = 0;
  private windowStarted = 0;
  private inFlight = false;
  constructor(private readonly db: DatabaseSync, private readonly clock = Date.now) {
    ensureInstanceIdentitySchema(db);
  }

  configured(): boolean {
    return !!this.db.prepare('SELECT singleton FROM instance_owner WHERE singleton=1').get();
  }

  passwordHint(): string {
    const owner = this.db.prepare('SELECT password_hint FROM instance_owner WHERE singleton=1').get();
    return String(owner?.password_hint ?? '');
  }

  setPasswordHint(token: string, hint: unknown): void {
    if (!this.authenticate(token)) throw new IdentityError(401, 'Sign in to this instance to change its password hint.');
    const result = this.db.prepare('UPDATE instance_owner SET password_hint=? WHERE singleton=1').run(passwordHintSchema.parse(hint));
    if (!result.changes) throw new IdentityError(409, 'Set an owner password before changing its hint.');
  }

  private issue(): { token: string; expiresAt: number; identityId: string; role: 'owner' } {
    const token = randomBytes(32).toString('base64url');
    const identityId = randomUUID(), now = this.clock(), expiresAt = now + sessionLifetime;
    this.db.prepare('INSERT INTO instance_owner_sessions(id,token_hash,created_at,expires_at) VALUES(?,?,?,?)')
      .run(identityId, digest(token), now, expiresAt);
    return { token, expiresAt, identityId, role: 'owner' };
  }

  async initialize(password: unknown, passwordHint: unknown = ''): Promise<ReturnType<InstanceIdentity['issue']>> {
    const checked = passwordSchema.parse(password);
    const hint = passwordHintSchema.parse(passwordHint);
    if (this.configured()) throw new IdentityError(409, 'The instance already has an owner password. Sign in instead.');
    const salt = randomBytes(32).toString('hex');
    const verifier = await derive(checked, salt);
    const result = this.db.prepare(`INSERT INTO instance_owner
      (singleton,instance_id,password_salt,password_verifier,created_at,password_hint) VALUES(1,?,?,?,?,?)
      ON CONFLICT(singleton) DO NOTHING`).run(randomUUID(), salt, verifier.toString('hex'), this.clock(), hint);
    if (!result.changes) throw new IdentityError(409, 'The instance already has an owner password. Sign in instead.');
    return this.issue();
  }

  async login(input: unknown): Promise<ReturnType<InstanceIdentity['issue']>> {
    const { password } = loginSchema.parse(input);
    const now = this.clock();
    if (now - this.windowStarted >= 60000) { this.windowStarted = now; this.attempts = 0; }
    if (this.inFlight || this.attempts >= 5) throw new IdentityError(429, 'Too many sign-in attempts. Try again in a minute.');
    this.attempts++;
    this.inFlight = true;
    try {
      const owner = this.db.prepare('SELECT password_salt,password_verifier FROM instance_owner WHERE singleton=1').get();
      if (!owner) throw new IdentityError(409, 'Set an owner password locally before signing in.');
      const actual = await derive(password, String(owner.password_salt));
      if (!timingSafeEqual(actual, Buffer.from(String(owner.password_verifier), 'hex'))) {
        throw new IdentityError(401, 'Incorrect instance password.');
      }
      return this.issue();
    } finally { this.inFlight = false; }
  }

  authenticate(token: string): boolean {
    return !!this.db.prepare(`SELECT id FROM instance_owner_sessions
      WHERE token_hash=? AND revoked_at IS NULL AND expires_at>?`).get(digest(token), this.clock());
  }

  recognizes(token: string): boolean {
    return !!this.db.prepare('SELECT id FROM instance_owner_sessions WHERE token_hash=?').get(digest(token));
  }

  revoke(token: string): void {
    if (!this.authenticate(token)) throw new IdentityError(401, 'Sign in to this instance again.');
    this.db.prepare('UPDATE instance_owner_sessions SET revoked_at=? WHERE token_hash=?').run(this.clock(), digest(token));
  }

  async handle(req: IncomingMessage, res: ServerResponse, url: URL): Promise<void> {
    const send = (status: number, body: unknown) => {
      res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' });
      res.end(JSON.stringify(body));
    };
    try {
      if (url.search || req.headers.origin) throw new IdentityError(400, 'Use the trusted desktop connection, not a browser page.');
      if (req.method === 'GET' && url.pathname === '/identity/v1/status') {
        send(200, { passwordConfigured: this.configured(), passwordHint: this.passwordHint(), scope: 'host-tasks-preview' });
        return;
      }
      if (req.method === 'POST' && url.pathname === '/identity/v1/logout') {
        this.revoke(req.headers.authorization?.replace(/^Bearer /, '') ?? '');
        send(200, { ok: true });
        return;
      }
      const updatingHint = url.pathname === '/identity/v1/hint';
      if (req.method !== 'POST' || (!updatingHint && url.pathname !== '/identity/v1/login')) throw new IdentityError(404, 'Identity endpoint not found.');
      const token = req.headers.authorization?.replace(/^Bearer /, '') ?? '';
      if (updatingHint && !this.authenticate(token)) throw new IdentityError(401, 'Sign in to this instance to change its password hint.');
      if (req.headers['content-type']?.split(';')[0].trim() !== 'application/json') throw new IdentityError(415, 'JSON required.');
      const chunks: Buffer[] = [];
      let bytes = 0;
      for await (const chunk of req) {
        const buffer = Buffer.from(chunk);
        bytes += buffer.length;
        if (bytes > 8192) throw new IdentityError(413, 'Sign-in request too large.');
        chunks.push(buffer);
      }
      let input: unknown;
      try { input = JSON.parse(Buffer.concat(chunks).toString('utf8')); }
      catch { throw new IdentityError(400, 'Invalid sign-in request.'); }
      if (updatingHint) {
        const value = z.object({ passwordHint: passwordHintSchema }).strict().parse(input);
        this.setPasswordHint(token, value.passwordHint);
        send(200, { ok: true });
      } else send(200, await this.login(input));
    } catch (error) {
      if (error instanceof IdentityError) send(error.status, { error: error.message });
      else if (error instanceof z.ZodError) send(400, { error: 'Provide a valid password or a password hint up to 1000 characters.' });
      else {
        console.error('[identity] Sign-in service failed.');
        send(500, { error: 'Instance sign-in is unavailable.' });
      }
    }
  }
}
