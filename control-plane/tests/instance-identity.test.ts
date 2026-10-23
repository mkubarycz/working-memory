import { randomBytes } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { openStore, type Store } from '../src/store';
import { InstanceIdentity } from '../src/instanceIdentity';
import { InstanceFeatureStore } from '../src/instanceFeatures';
import { startServer, type RunningServer } from '../src/server';

const stores: Store[] = [], servers: RunningServer[] = [];
const directories: string[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map(server => server.close()));
  stores.splice(0).forEach(store => store.close());
  await Promise.all(directories.splice(0).map(directory => rm(directory, { recursive: true, force: true })));
});
function fixture() {
  const store = openStore(':memory:');
  stores.push(store);
  let now = Date.now();
  const identity = new InstanceIdentity(store.db, () => now);
  return { store, identity, advance: (milliseconds: number) => { now += milliseconds; } };
}
const password = 'a reviewed instance password';

describe('instance owner identity', () => {
  it('stores optional free-text hints, bounds their size, and only permits an active owner to edit them', async () => {
    const { identity, store, advance } = fixture();
    const hint = 'First pet & street\n<b>just text</b>';
    const session = await identity.initialize(password, hint);
    expect(identity.passwordHint()).toBe(hint);
    const ownerBefore = store.db.prepare('SELECT password_salt,password_verifier FROM instance_owner').get();
    identity.setPasswordHint(session.token, 'A revised reminder');
    expect(identity.passwordHint()).toBe('A revised reminder');
    expect(store.db.prepare('SELECT password_salt,password_verifier FROM instance_owner').get()).toEqual(ownerBefore);
    expect(() => identity.setPasswordHint('not an owner', 'tampered')).toThrow('Sign in');
    identity.setPasswordHint(session.token, 'x'.repeat(1000));
    expect(identity.passwordHint()).toHaveLength(1000);
    expect(() => identity.setPasswordHint(session.token, 'x'.repeat(1001))).toThrow();
    identity.setPasswordHint(session.token, '');
    expect(identity.passwordHint()).toBe('');
    advance(12 * 60 * 60 * 1000);
    expect(() => identity.setPasswordHint(session.token, 'expired edit')).toThrow('Sign in');
  });

  it('upgrades the original identity schema without changing an existing password verifier', async () => {
    const original = fixture();
    await original.identity.initialize(password);
    const owner = original.store.db.prepare('SELECT * FROM instance_owner').get();
    if (!owner) throw new Error('Missing test owner');
    const store = openStore(':memory:');
    stores.push(store);
    store.db.exec(await readFile(new URL('../../schema/023_instance_identity.sql', import.meta.url), 'utf8'));
    store.db.prepare(`INSERT INTO instance_owner
      (singleton,instance_id,password_salt,password_verifier,created_at) VALUES(1,?,?,?,?)`)
      .run(owner.instance_id, owner.password_salt, owner.password_verifier, owner.created_at);
    const upgraded = new InstanceIdentity(store.db);
    expect(upgraded.passwordHint()).toBe('');
    expect((await upgraded.login({ password })).role).toBe('owner');
    expect(new InstanceIdentity(store.db).passwordHint()).toBe('');
  });

  it('stores salted password verifiers and hashed, expiring owner credentials outside documents', async () => {
    const { store, identity } = fixture();
    const first = await identity.initialize(password);
    const second = await identity.login({ password });
    expect(second.token).not.toBe(first.token);
    expect(first.role).toBe('owner');
    expect(identity.authenticate(first.token)).toBe(true);
    const rows = JSON.stringify({
      owner: store.db.prepare('SELECT * FROM instance_owner').get(),
      sessions: store.db.prepare('SELECT * FROM instance_owner_sessions').all(),
    });
    expect(rows).not.toContain(password);
    expect(rows).not.toContain(first.token);
    expect(rows).not.toContain(second.token);
    expect(store.getDocument({ id: first.identityId })).toBeNull();
    await expect(identity.initialize('another owner password')).rejects.toThrow('already has');
  });

  it('does not allow another instance, an expired token, or a revoked token to authenticate', async () => {
    const { identity, advance } = fixture(), other = fixture().identity;
    const session = await identity.initialize(password);
    expect(other.authenticate(session.token)).toBe(false);
    identity.revoke(session.token);
    expect(identity.authenticate(session.token)).toBe(false);
    expect(identity.recognizes(session.token)).toBe(true);
    const fresh = await identity.login({ password });
    advance(12 * 60 * 60 * 1000);
    expect(identity.authenticate(fresh.token)).toBe(false);
    await expect(identity.login({ password: 'wrong' })).rejects.toThrow('Incorrect');
  });

  it('bounds password work, rejects unknown input, and rate-limits repeated attempts', async () => {
    const { identity, advance } = fixture();
    await expect(identity.initialize('short')).rejects.toThrow();
    await identity.initialize(password);
    await expect(identity.login({ password, role: 'owner' })).rejects.toThrow();
    for (let i = 0; i < 5; i++) await expect(identity.login({ password: 'incorrect' })).rejects.toThrow('Incorrect');
    await expect(identity.login({ password })).rejects.toThrow('Too many');
    advance(60001);
    expect(identity.authenticate((await identity.login({ password })).token)).toBe(true);
  });

  it('allows only one initializer to claim an instance', async () => {
    const { identity } = fixture();
    const results = await Promise.allSettled([identity.initialize(password), identity.initialize('a different owner password')]);
    expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(1);
  });
});

it('requires trusted bootstrap, exchanges passwords for owner sessions, and cannot reuse bootstrap afterward', async () => {
  const bootstrap = randomBytes(32).toString('hex');
  const server = await startServer({ port: 0, hostTaskAdminCredential: bootstrap });
  servers.push(server);
  const request = (path: string, input?: object, token?: string, origin?: string) => fetch(server.url + path, {
    method: input ? 'POST' : 'GET',
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(origin ? { Origin: origin } : {}) },
    ...(input ? { body: JSON.stringify(input) } : {}),
  });
  const setup = '/host-tasks/v1/admin/identity/setup';
  expect((await request('/identity/v1/status')).status).toBe(200);
  expect((await request(setup, { password })).status).toBe(401);
  expect((await request(setup, { password }, bootstrap, 'http://localhost')).status).toBe(400);
  const hint = 'A free-text reminder';
  const initial = await request(setup, { password, passwordHint: hint }, bootstrap);
  expect(initial.status).toBe(200);
  const owner = await initial.json() as { token: string };
  expect((await request('/features/v1', { hostTasks: true }, owner.token)).status).toBe(200);
  expect(await (await request('/identity/v1/status')).json()).toMatchObject({ passwordHint: hint });
  expect((await request('/identity/v1/hint', { passwordHint: 'unauthorized' })).status).toBe(401);
  expect((await request('/identity/v1/hint', { passwordHint: 'updated hint' }, owner.token)).status).toBe(200);
  expect(await (await request('/identity/v1/status')).json()).toMatchObject({ passwordHint: 'updated hint' });
  expect((await request('/identity/v1/hint', { passwordHint: 'x'.repeat(1001) }, owner.token)).status).toBe(400);
  expect((await request('/host-tasks/v1/admin/scripts', undefined, bootstrap)).status).toBe(401);
  expect((await request('/host-tasks/v1/admin/scripts', undefined, owner.token)).status).toBe(200);
  expect((await request(setup, { password }, bootstrap)).status).toBe(409);
  expect((await request('/identity/v1/login', { password: 'wrong' })).status).toBe(401);
  const login = await request('/identity/v1/login', { password });
  expect(login.status).toBe(200);
  const next = await login.json() as { token: string };
  expect(next.token).not.toBe(owner.token);
  expect((await request('/identity/v1/logout', {}, owner.token)).status).toBe(200);
  expect((await request('/identity/v1/hint', { passwordHint: 'revoked edit' }, owner.token)).status).toBe(401);
  expect((await request('/host-tasks/v1/admin/scripts', undefined, owner.token)).status).toBe(401);
  expect((await request('/attachments/00000000-0000-4000-8000-000000000000', undefined, owner.token)).status).toBe(401);
  expect((await request('/host-tasks/v1/admin/scripts', undefined, next.token)).status).toBe(200);
});

it('retains owner verification and sessions across server restart without the old bootstrap credential', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'wm-identity-'));
  directories.push(directory);
  const filename = join(directory, 'journal.sqlite');
  const firstStore = openStore(filename);
  stores.push(firstStore);
  const session = await new InstanceIdentity(firstStore.db).initialize(password, 'Persistent hint');
  new InstanceFeatureStore(firstStore.db).write({ hostTasks: true });
  const firstServer = await startServer({ port: 0, store: firstStore, hostTaskAdminCredential: randomBytes(32).toString('hex') });
  await firstServer.close();
  firstStore.close();
  stores.splice(stores.indexOf(firstStore), 1);
  const store = openStore(filename);
  stores.push(store);
  const server = await startServer({ port: 0, store });
  servers.push(server);
  const request = () => fetch(`${server.url}/host-tasks/v1/admin/scripts`, {
    headers: { Authorization: `Bearer ${session.token}` },
  });
  expect((await request()).status).toBe(200);
  expect(await (await fetch(`${server.url}/identity/v1/status`)).json()).toMatchObject({ passwordHint: 'Persistent hint' });
  const login = await fetch(`${server.url}/identity/v1/login`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ password }),
  });
  expect(login.status).toBe(200);
});
