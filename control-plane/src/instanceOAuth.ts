import { randomBytes, randomUUID } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { DatabaseSync } from 'node:sqlite';
import express, { type ErrorRequestHandler, type Response } from 'express';
import { z } from 'zod';
import type { OAuthServerProvider, AuthorizationParams } from '@modelcontextprotocol/sdk/server/auth/provider.js';
import type { OAuthRegisteredClientsStore } from '@modelcontextprotocol/sdk/server/auth/clients.js';
import { authorizationHandler } from '@modelcontextprotocol/sdk/server/auth/handlers/authorize.js';
import { tokenHandler } from '@modelcontextprotocol/sdk/server/auth/handlers/token.js';
import { clientRegistrationHandler } from '@modelcontextprotocol/sdk/server/auth/handlers/register.js';
import { revocationHandler } from '@modelcontextprotocol/sdk/server/auth/handlers/revoke.js';
import { createOAuthMetadata, mcpAuthMetadataRouter } from '@modelcontextprotocol/sdk/server/auth/router.js';
import {
  InvalidClientMetadataError, InvalidGrantError, InvalidRequestError, InvalidScopeError,
  InvalidTargetError, InvalidTokenError, UnsupportedGrantTypeError,
} from '@modelcontextprotocol/sdk/server/auth/errors.js';
import {
  OAuthClientInformationFullSchema, type OAuthClientInformationFull, type OAuthTokens,
  type OAuthTokenRevocationRequest,
} from '@modelcontextprotocol/sdk/shared/auth.js';
import { AccessError, InstanceAccess, credentialHash } from './instanceAccess.js';

const scopesSupported = ['wm.read', 'wm.write'];
const safeLabel = z.string().trim().min(1).max(100).regex(/^[^\p{Cc}\p{Cf}\p{Zl}\p{Zp}]+$/u);
const paramsSchema = z.object({
  redirectUri: z.string().url(), codeChallenge: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
  scopes: z.array(z.enum(['wm.read', 'wm.write'])), state: z.string().max(4096).optional(),
});
const loopback = new Set(['127.0.0.1', 'localhost', '[::1]']);

function nativeRedirect(value: string): boolean {
  const url = new URL(value);
  return url.protocol === 'http:' && loopback.has(url.hostname) && !url.username && !url.password && !url.hash;
}

function registrationRedirect(value: string): boolean {
  return nativeRedirect(value) || ['https://vscode.dev/redirect', 'https://insiders.vscode.dev/redirect'].includes(value);
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, character => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  })[character]!);
}

export function ensureInstanceOAuthSchema(db: DatabaseSync): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS instance_oauth_clients (
      id TEXT PRIMARY KEY, metadata TEXT NOT NULL, created_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS instance_oauth_flows (
      proof_hash TEXT PRIMARY KEY,
      request_id TEXT NOT NULL REFERENCES instance_access_requests(id) ON DELETE CASCADE,
      oauth_client_id TEXT NOT NULL REFERENCES instance_oauth_clients(id),
      params TEXT NOT NULL, code_hash TEXT UNIQUE, code_expires_at INTEGER,
      consumed_at INTEGER, expires_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS instance_oauth_tokens (
      client_id TEXT PRIMARY KEY REFERENCES instance_clients(id),
      oauth_client_id TEXT NOT NULL REFERENCES instance_oauth_clients(id)
    );
  `);
}

export class InstanceOAuth implements OAuthServerProvider {
  readonly clientsStore: OAuthRegisteredClientsStore;
  readonly app = express();
  readonly resource: URL;

  constructor(
    private readonly db: DatabaseSync,
    private readonly access: InstanceAccess,
    readonly origin: string,
    private readonly clock = Date.now,
  ) {
    ensureInstanceOAuthSchema(db);
    this.resource = new URL('/mcp', origin);
    this.clientsStore = {
      getClient: clientId => {
        const row = db.prepare('SELECT metadata FROM instance_oauth_clients WHERE id=?').get(clientId);
        return row ? OAuthClientInformationFullSchema.parse(JSON.parse(String(row.metadata))) : undefined;
      },
      registerClient: client => {
        if (client.token_endpoint_auth_method !== 'none'
          || !client.redirect_uris.length || client.redirect_uris.length > 10
          || client.redirect_uris.some(uri => uri.length > 2048 || !registrationRedirect(uri))
          || client.grant_types?.some(grant => !['authorization_code', 'refresh_token'].includes(grant))
          || client.response_types?.some(response => response !== 'code')) {
          throw new InvalidClientMetadataError('Use a public PKCE authorization-code client with native loopback redirect URIs.');
        }
        const label = safeLabel.safeParse(client.client_name ?? 'MCP client');
        if (!label.success) throw new InvalidClientMetadataError('Provide a client name up to 100 characters without control characters.');
        if (Number(db.prepare('SELECT count(*) AS count FROM instance_oauth_clients').get()!.count) >= 1000) {
          throw new InvalidClientMetadataError('Client registration limit reached. Ask the instance owner for help.');
        }
        const registered: OAuthClientInformationFull = {
          client_id: randomUUID(), client_id_issued_at: Math.floor(clock() / 1000),
          client_name: label.data, redirect_uris: client.redirect_uris,
          token_endpoint_auth_method: 'none', grant_types: ['authorization_code'], response_types: ['code'],
        };
        db.prepare('INSERT INTO instance_oauth_clients(id,metadata,created_at) VALUES(?,?,?)')
          .run(registered.client_id, JSON.stringify(registered), clock());
        return registered;
      },
    };
    this.app.disable('x-powered-by');
    this.app.use((_req, res, next) => { res.setHeader('cache-control', 'no-store'); next(); });
    const metadata = {
      ...createOAuthMetadata({ provider: this, issuerUrl: new URL(origin), scopesSupported }),
      grant_types_supported: ['authorization_code'], token_endpoint_auth_methods_supported: ['none'],
      revocation_endpoint_auth_methods_supported: ['none'],
    };
    this.app.use(mcpAuthMetadataRouter({
      oauthMetadata: metadata, resourceServerUrl: this.resource, scopesSupported, resourceName: 'Working Memory',
    }));
    this.app.get('/.well-known/oauth-protected-resource', (_req, res) => res.json({
      resource: this.resource.href, authorization_servers: [new URL(origin).href],
      scopes_supported: scopesSupported, resource_name: 'Working Memory',
    }));
    this.app.use('/authorize', authorizationHandler({ provider: this }));
    this.app.use('/token', tokenHandler({ provider: this }));
    this.app.use('/register', clientRegistrationHandler({ clientsStore: this.clientsStore }));
    this.app.use('/revoke', revocationHandler({ provider: this }));
    this.app.get('/oauth/approval/:proof', (req, res) => this.approval(req.params.proof, req.query.poll === '1', res));
    this.app.use((_req, res) => { res.status(404).json({ error: 'not_found' }); });
    const onError: ErrorRequestHandler = (error: unknown, _req, res, next) => {
      if (res.headersSent) { next(error); return; }
      const inputError = z.object({ status: z.union([z.literal(400), z.literal(413)]) }).safeParse(error);
      if (inputError.success) {
        res.status(inputError.data.status).json({ error: 'invalid_request', error_description: 'Provide a valid, bounded OAuth request.' });
        return;
      }
      console.error('[instance-oauth] Request failed.');
      res.status(500).json({ error: 'server_error', error_description: 'Sign-in failed. Check the control-plane service logs and reconnect the MCP client.' });
    };
    this.app.use(onError);
  }

  handles(path: string): boolean {
    return ['/.well-known/oauth-protected-resource', '/.well-known/oauth-protected-resource/mcp',
      '/.well-known/oauth-authorization-server', '/authorize', '/token', '/register', '/revoke'].includes(path)
      || path.startsWith('/oauth/approval/');
  }

  handle(req: IncomingMessage, res: ServerResponse): void { this.app(req, res); }

  private validateResource(resource?: URL): void {
    if (resource && resource.href !== this.resource.href) throw new InvalidTargetError('Use this instance MCP resource URL.');
  }

  async authorize(client: OAuthClientInformationFull, params: AuthorizationParams, res: Response): Promise<void> {
    this.validateResource(params.resource);
    if (!nativeRedirect(params.redirectUri)) {
      throw new InvalidRequestError('This local instance supports native desktop OAuth callbacks only. Connect using desktop VS Code.');
    }
    const scopes = params.scopes?.length ? params.scopes : scopesSupported;
    if (scopes.some(scope => !scopesSupported.includes(scope))) throw new InvalidScopeError('Request wm.read or wm.write access.');
    const parsed = paramsSchema.safeParse({ ...params, scopes });
    if (!parsed.success) throw new InvalidRequestError('Provide an S256 PKCE challenge and bounded authorization parameters.');
    let request;
    try {
      request = this.access.request({
        label: client.client_name ?? 'MCP client', access: scopes.includes('wm.write') ? 'write' : 'read', refresh: false,
      }, '', res.req.socket.remoteAddress ?? 'unknown');
    } catch (error) {
      if (!(error instanceof AccessError)) throw error;
      throw new InvalidRequestError(error.message);
    }
    const proof = randomBytes(32).toString('base64url');
    this.db.prepare(`INSERT INTO instance_oauth_flows
      (proof_hash,request_id,oauth_client_id,params,expires_at) VALUES(?,?,?,?,?)`)
      .run(credentialHash(proof), request.requestId, client.client_id, JSON.stringify(parsed.data), request.expiresAt);
    res.redirect(303, `/oauth/approval/${proof}`);
  }

  private approval(proof: string, poll: boolean, res: Response): void {
    res.setHeader('referrer-policy', 'no-referrer');
    res.setHeader('x-content-type-options', 'nosniff');
    const row = /^[A-Za-z0-9_-]{43}$/.test(proof) ? this.db.prepare(`SELECT f.*,r.state,r.label
      FROM instance_oauth_flows f JOIN instance_access_requests r ON r.id=f.request_id WHERE proof_hash=?`)
      .get(credentialHash(proof)) : undefined;
    if (!row || Number(row.expires_at) <= this.clock()) {
      res.status(410).json({ error: 'Approval expired. Reconnect the MCP client to request access again.' }); return;
    }
    if (!poll) {
      const nonce = randomBytes(18).toString('base64');
      res.setHeader('content-security-policy', `default-src 'none'; script-src 'nonce-${nonce}'; style-src 'nonce-${nonce}'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'`);
      res.type('html').send(`<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>Working Memory access approval</title>
<style nonce="${nonce}">body{font:16px system-ui;max-width:640px;margin:64px auto;padding:24px;line-height:1.6}code{overflow-wrap:anywhere}#status{font-weight:600}</style></head>
<body><h1>Approve access in Working Memory</h1><p><strong>${escapeHtml(String(row.label))}</strong> is requesting access to <code>${escapeHtml(this.origin)}</code>.</p>
<p>Switch to the signed-in Working Memory desktop app and open <strong>Settings &gt; Access</strong>. Review this request:</p>
<p><code>${escapeHtml(String(row.request_id))}</code></p><p>The client name is not verified. Only approve a request you started. Approval lasts 90 days; renewal needs your approval again. Your owner password is never shared with the client.</p>
<p id="status" role="status">Waiting for your approval...</p><script nonce="${nonce}">
const status=document.getElementById('status');async function poll(){try{const response=await fetch(location.pathname+'?poll=1',{cache:'no-store'});const value=await response.json();if(!response.ok||value.error){status.textContent=value.error||'Approval could not be checked. Reconnect the client to retry.';return;}if(value.redirectUri){location.replace(value.redirectUri);return;}setTimeout(poll,2000);}catch{status.textContent='Connection lost. Reconnect the MCP client to request access again.';}}poll();
</script></body></html>`);
      return;
    }
    const params = paramsSchema.parse(JSON.parse(String(row.params)));
    const redirect = new URL(params.redirectUri);
    if (params.state !== undefined) redirect.searchParams.set('state', params.state);
    if (row.state === 'denied') {
      redirect.searchParams.set('error', 'access_denied');
      res.json({ redirectUri: redirect.href }); return;
    }
    if (row.state === 'pending') { res.json({ state: 'pending' }); return; }
    if (row.code_hash || row.state !== 'approved') {
      res.status(409).json({ error: 'Approval was already returned to the client. Reconnect it if sign-in did not finish.' }); return;
    }
    const code = randomBytes(32).toString('base64url');
    this.db.prepare('UPDATE instance_oauth_flows SET code_hash=?,code_expires_at=? WHERE proof_hash=?')
      .run(credentialHash(code), Math.min(this.clock() + 60000, Number(row.expires_at)), credentialHash(proof));
    redirect.searchParams.set('code', code);
    res.json({ redirectUri: redirect.href });
  }

  private code(client: OAuthClientInformationFull, code: string) {
    const row = this.db.prepare(`SELECT * FROM instance_oauth_flows
      WHERE code_hash=? AND oauth_client_id=? AND consumed_at IS NULL AND code_expires_at>?`)
      .get(credentialHash(code), client.client_id, this.clock());
    if (!row) throw new InvalidGrantError('Authorization code is invalid, expired, already used, or belongs to another client.');
    return row;
  }

  async challengeForAuthorizationCode(client: OAuthClientInformationFull, code: string): Promise<string> {
    return paramsSchema.parse(JSON.parse(String(this.code(client, code).params))).codeChallenge;
  }

  async exchangeAuthorizationCode(client: OAuthClientInformationFull, code: string, _verifier?: string, redirectUri?: string, resource?: URL): Promise<OAuthTokens> {
    this.validateResource(resource);
    const row = this.code(client, code), params = paramsSchema.parse(JSON.parse(String(row.params)));
    if (redirectUri !== params.redirectUri) throw new InvalidGrantError('Redirect URI must match the authorization request exactly.');
    let issued;
    try { issued = this.access.claimApproved(String(row.request_id)); }
    catch (error) {
      if (!(error instanceof AccessError)) throw error;
      throw new InvalidGrantError(error.message);
    }
    if (issued.state !== 'issued') throw new InvalidGrantError('Owner approval is still required.');
    this.db.prepare('UPDATE instance_oauth_flows SET consumed_at=? WHERE proof_hash=?').run(this.clock(), row.proof_hash);
    this.db.prepare('INSERT INTO instance_oauth_tokens(client_id,oauth_client_id) VALUES(?,?)')
      .run(issued.clientId, client.client_id);
    return { access_token: issued.token, token_type: 'Bearer', expires_in: Math.floor((issued.expiresAt - this.clock()) / 1000),
      scope: params.scopes.join(' ') };
  }

  async exchangeRefreshToken(): Promise<OAuthTokens> {
    throw new UnsupportedGrantTypeError('Renewal requires a new authorization-code flow and owner approval every 90 days.');
  }

  async verifyAccessToken(token: string) {
    const principal = this.access.authenticate(token);
    const row = this.db.prepare(`SELECT c.expires_at,t.oauth_client_id FROM instance_clients c
      JOIN instance_oauth_tokens t ON t.client_id=c.id WHERE c.credential_hash=?`).get(credentialHash(token));
    if (!principal || !row || principal.role !== 'client') throw new InvalidTokenError('Client access expired or was revoked. Request owner approval again.');
    return { token, clientId: String(row.oauth_client_id), scopes: principal.access === 'write' ? scopesSupported : ['wm.read'],
      expiresAt: Math.floor(Number(row.expires_at) / 1000), resource: this.resource };
  }

  async revokeToken(client: OAuthClientInformationFull, request: OAuthTokenRevocationRequest): Promise<void> {
    this.db.prepare(`UPDATE instance_clients SET revoked_at=? WHERE credential_hash=?
      AND id IN (SELECT client_id FROM instance_oauth_tokens WHERE oauth_client_id=?) AND revoked_at IS NULL`)
      .run(this.clock(), credentialHash(request.token), client.client_id);
  }
}
