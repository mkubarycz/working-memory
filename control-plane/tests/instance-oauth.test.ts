import { createHash, randomBytes } from 'node:crypto';
import { afterEach, beforeAll, expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { auth, type OAuthClientProvider } from '@modelcontextprotocol/sdk/client/auth.js';
import type { OAuthClientInformationMixed, OAuthTokens } from '@modelcontextprotocol/sdk/shared/auth.js';
import { startServer } from '../src/server';
import { openStore } from '../src/store';
import { InstanceIdentity } from '../src/instanceIdentity';
import { InstanceAccess } from '../src/instanceAccess';
import { loadKinds } from '../src/kinds/loader';
import { defaultInstancePermissions } from '../src/instancePermissions';

const cleanup: Array<() => Promise<void>> = [];
beforeAll(async () => { await loadKinds(); });
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });

async function fixture() {
  const store = openStore(':memory:');
  let now = Date.now();
  const identity = new InstanceIdentity(store.db, () => now);
  const owner = await identity.initialize('owner password for OAuth tests');
  const access = new InstanceAccess(store.db, identity, () => now);
  const server = await startServer({ port: 0, store, hostTaskClock: () => now });
  cleanup.push(async () => { await server.close(); store.close(); });
  const form = (path: string, params: Record<string, string>) => fetch(`${server.url}${path}`, {
    method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(params),
  });
  const register = async () => {
    const response = await fetch(`${server.url}/register`, { method: 'POST',
      headers: { 'content-type': 'application/json' }, body: JSON.stringify({
        client_name: 'VS Code test', token_endpoint_auth_method: 'none',
        redirect_uris: ['https://insiders.vscode.dev/redirect', 'https://vscode.dev/redirect',
          'http://127.0.0.1/', 'http://127.0.0.1:33418/'],
        grant_types: ['authorization_code', 'refresh_token'], response_types: ['code'],
      }),
    });
    expect(response.status).toBe(201);
    return response.json() as Promise<{ client_id: string }>;
  };
  const begin = async (scope = 'wm.read wm.write') => {
    const client = await register(), verifier = randomBytes(32).toString('base64url');
    const params = new URLSearchParams({
      client_id: client.client_id, redirect_uri: 'http://127.0.0.1:49999/',
      response_type: 'code', code_challenge: createHash('sha256').update(verifier).digest('base64url'),
      code_challenge_method: 'S256', state: 'a private client state', resource: `${server.url}/mcp`, scope,
    });
    const response = await fetch(`${server.url}/authorize?${params}`, { redirect: 'manual' });
    expect(response.status).toBe(303);
    const flow = response.headers.get('location')!;
    const request = access.snapshot(owner.token).requests.at(-1)!;
    const poll = () => fetch(`${server.url}${flow}?poll=1`);
    const approve = async () => {
      access.decide(owner.token, String(request.id), true);
      const result = await poll();
      expect(result.status).toBe(200);
      const callback = new URL((await result.json()).redirectUri);
      expect(callback.searchParams.get('state')).toBe('a private client state');
      return callback.searchParams.get('code')!;
    };
    const token = (code: string, changes: Record<string, string> = {}) => form('/token', {
      client_id: client.client_id, grant_type: 'authorization_code', code,
      code_verifier: verifier, redirect_uri: 'http://127.0.0.1:49999/', resource: `${server.url}/mcp`, ...changes,
    });
    return { client, flow, request, poll, approve, token };
  };
  return { store, identity, owner, access, server, form, register, begin, advance: (ms: number) => { now += ms; } };
}

it('advertises standard discovery and public PKCE registration without refresh-token bypasses', async () => {
  const f = await fixture();
  const denied = await fetch(`${f.server.url}/mcp`);
  expect(denied.status).toBe(401);
  expect(denied.headers.get('www-authenticate')).toContain(`resource_metadata="${f.server.url}/.well-known/oauth-protected-resource/mcp"`);
  const resource = await fetch(`${f.server.url}/.well-known/oauth-protected-resource/mcp`).then(response => response.json());
  expect(resource).toMatchObject({ resource: `${f.server.url}/mcp`, authorization_servers: [`${f.server.url}/`] });
  const metadata = await fetch(`${f.server.url}/.well-known/oauth-authorization-server`).then(response => response.json());
  expect(metadata).toMatchObject({ code_challenge_methods_supported: ['S256'], grant_types_supported: ['authorization_code'],
    token_endpoint_auth_methods_supported: ['none'], token_endpoint: `${f.server.url}/token` });
  const client = await f.register();
  expect(client).not.toHaveProperty('client_secret');
  const refresh = await f.form('/token', { client_id: client.client_id, grant_type: 'refresh_token', refresh_token: 'not-issued' });
  expect(refresh.status).toBe(400);
  expect(await refresh.json()).toMatchObject({ error: 'unsupported_grant_type' });
});

it('requires desktop owner approval, preserves OAuth state, issues scoped 90-day tokens once, and keeps secrets hashed', async () => {
  const f = await fixture(), flow = await f.begin();
  expect(await flow.poll().then(response => response.json())).toEqual({ state: 'pending' });
  expect(f.store.db.prepare('SELECT count(*) AS count FROM instance_clients').get()!.count).toBe(0);
  const page = await fetch(`${f.server.url}${flow.flow}`);
  expect(page.headers.get('content-security-policy')).toContain("frame-ancestors 'none'");
  expect(page.headers.get('referrer-policy')).toBe('no-referrer');
  const html = await page.text();
  expect(html).toContain(String(flow.request.id));
  expect(html).toContain('Settings &gt; Access');
  expect(html).not.toContain(f.owner.token);
  const code = await flow.approve();
  const response = await flow.token(code);
  expect(response.status).toBe(200);
  const token = await response.json();
  expect(token).toMatchObject({ token_type: 'Bearer', expires_in: 90 * 24 * 60 * 60, scope: 'wm.read wm.write' });
  expect(token).not.toHaveProperty('refresh_token');
  expect((await flow.token(code)).status).toBe(400);
  const tables = ['instance_oauth_flows', 'instance_oauth_clients', 'instance_access_requests', 'instance_clients'];
  const persisted = JSON.stringify(tables.map(table => f.store.db.prepare(`SELECT * FROM ${table}`).all()));
  expect(persisted).not.toContain(token.access_token);
  expect(persisted).not.toContain(code);
  expect(persisted).not.toContain(flow.flow.split('/').at(-1)!);
  expect((await fetch(`${f.server.url}/identity/v1/access`, {
    headers: { authorization: `Bearer ${token.access_token}` },
  })).status).toBe(401);
});

it('rejects wrong PKCE, client, redirect, resource and replay without consuming a valid grant', async () => {
  const f = await fixture(), flow = await f.begin(), code = await flow.approve();
  const other = await f.register();
  for (const changes of [
    { code_verifier: randomBytes(32).toString('base64url') },
    { client_id: other.client_id }, { redirect_uri: 'http://127.0.0.1:50000/' },
    { resource: 'http://127.0.0.1:9999/mcp' },
  ]) {
    expect((await flow.token(code, changes)).status).toBe(400);
  }
  expect((await flow.token(code)).status).toBe(200);
  expect((await flow.token(code)).status).toBe(400);
});

it('returns denial to the initiating client and expires pending approval and issued codes', async () => {
  const f = await fixture(), denied = await f.begin();
  f.access.decide(f.owner.token, String(denied.request.id), false);
  const callback = new URL((await denied.poll().then(response => response.json())).redirectUri);
  expect(callback.searchParams.get('error')).toBe('access_denied');
  expect(callback.searchParams.get('state')).toBe('a private client state');
  const expiredCode = await f.begin(), code = await expiredCode.approve();
  f.advance(60000);
  expect((await expiredCode.token(code)).status).toBe(400);
  const pending = await f.begin();
  f.advance(10 * 60 * 1000);
  expect((await pending.poll()).status).toBe(410);
});

it('uses the official MCP OAuth client for discovery, enrollment, token exchange and authenticated topic operations', async () => {
  const f = await fixture();
  f.store.createDocument({ kind: 'TopicType', spec: { label: 'Topic', icon: 'symbol-key' } });
  let clientInfo: OAuthClientInformationMixed | undefined, tokens: OAuthTokens | undefined;
  let verifier = '', redirect: URL | undefined;
  const provider: OAuthClientProvider = {
    redirectUrl: 'http://127.0.0.1:33418/',
    clientMetadata: { client_name: 'Copilot OAuth integration test', token_endpoint_auth_method: 'none',
      redirect_uris: ['http://127.0.0.1:33418/'], grant_types: ['authorization_code'], response_types: ['code'] },
    clientInformation: () => clientInfo, saveClientInformation: value => { clientInfo = value; },
    tokens: () => tokens, saveTokens: value => { tokens = value; },
    saveCodeVerifier: value => { verifier = value; }, codeVerifier: () => verifier,
    state: () => 'official-client-state', redirectToAuthorization: value => { redirect = value; },
  };
  const serverUrl = new URL('/mcp', f.server.url);
  expect(await auth(provider, { serverUrl })).toBe('REDIRECT');
  const browser = await fetch(redirect!, { redirect: 'manual' });
  expect(browser.status).toBe(303);
  const location = browser.headers.get('location')!;
  const request = f.access.snapshot(f.owner.token).requests[0];
  f.access.decide(f.owner.token, String(request.id), true);
  const response = await fetch(`${f.server.url}${location}?poll=1`).then(result => result.json());
  const callback = new URL(response.redirectUri);
  expect(callback.searchParams.get('state')).toBe('official-client-state');
  expect(await auth(provider, { serverUrl, authorizationCode: callback.searchParams.get('code')! })).toBe('AUTHORIZED');
  const client = new Client({ name: 'Copilot OAuth integration test', version: '1' });
  await client.connect(new StreamableHTTPClientTransport(serverUrl, { authProvider: provider }));
  cleanup.push(() => client.close());
  const created = await client.callTool({
    name: 'wm-document-create', arguments: { kind: 'Topic', spec: { title: 'OAuth test topic', body: 'Created only in an isolated test database.' } },
  });
  expect(created.isError, JSON.stringify(created)).not.toBe(true);
  const document = JSON.parse((created.content as Array<{ text: string }>)[0].text);
  const read = await client.callTool({ name: 'wm-document-read', arguments: { id: document.metadata.id } });
  expect(read.isError).not.toBe(true);
  expect(JSON.stringify(read)).toContain('OAuth test topic');
});

it('enforces read-only OAuth scopes and owner revocation, and expires access at exactly 90 days', async () => {
  const f = await fixture(), flow = await f.begin('wm.read');
  expect(() => f.access.setPermissions(f.owner.token, String(flow.request.id), 'request', defaultInstancePermissions('write')))
    .toThrow(/read-only/);
  const response = await flow.token(await flow.approve()), token = (await response.json()).access_token;
  const client = new Client({ name: 'Read-only OAuth test', version: '1' });
  await client.connect(new StreamableHTTPClientTransport(new URL('/mcp', f.server.url), {
    requestInit: { headers: { authorization: `Bearer ${token}` } },
  }));
  cleanup.push(() => client.close());
  expect((await client.callTool({ name: 'wm-document-read', arguments: {} })).isError).not.toBe(true);
  await expect(client.callTool({ name: 'wm-document-create', arguments: { kind: 'Config', spec: { key: 'forbidden' } } })).rejects.toThrow(/permission/i);
  const registered = f.store.db.prepare('SELECT id FROM instance_clients WHERE credential_hash=?')
    .get(createHash('sha256').update(token).digest('hex'))!;
  expect(() => f.access.setPermissions(f.owner.token, String(registered.id), 'client', defaultInstancePermissions('write')))
    .toThrow(/read-only/);
  expect(() => f.access.requestPermissions(token, [{ category: 'content', operation: 'create' }], 'test'))
    .toThrow(/read-only/);
  expect(f.access.snapshot(f.owner.token).requests.filter(request => request.purpose === 'permissions')).toEqual([]);
  const renewal = f.access.request({ label: 'Ignored', access: 'write', refresh: true }, token, 'test');
  expect(() => f.access.setPermissions(f.owner.token, renewal.requestId, 'request', defaultInstancePermissions('write')))
    .toThrow(/read-only/);
  f.access.revoke(f.owner.token, String(registered.id));
  expect(f.access.authenticate(token)).toBeNull();
  const next = await f.begin(), nextResponse = await next.token(await next.approve());
  const nextToken = (await nextResponse.json()).access_token;
  f.advance(90 * 24 * 60 * 60 * 1000 - 1);
  expect(f.access.authenticate(nextToken)).not.toBeNull();
  f.advance(1);
  expect(f.access.authenticate(nextToken)).toBeNull();
});
