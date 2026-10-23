import { afterAll, beforeAll, expect, it } from 'vitest';
import { createServer, type ViteDevServer } from 'vite';
import { svelte } from '@sveltejs/vite-plugin-svelte';
import type { InstanceConnectionState } from '../src/shared/instanceIdentity';

let server: ViteDevServer;
let renderConnection: (connection: InstanceConnectionState) => string;
let renderFeatures: () => string;
let renderAccess: () => string;
beforeAll(async () => {
  server = await createServer({
    configFile: false, root: new URL('..', import.meta.url).pathname,
    plugins: [svelte()], server: { middlewareMode: true }, appType: 'custom',
  });
  const { render } = await server.ssrLoadModule('svelte/server');
  const { default: Connection } = await server.ssrLoadModule('/src/renderer/InstanceConnection.svelte');
  const { default: Features } = await server.ssrLoadModule('/src/renderer/documents/FeaturesView.svelte');
  const { default: Access } = await server.ssrLoadModule('/src/renderer/documents/AccessView.svelte');
  renderConnection = connection => render(Connection, { props: {
    connection, environments: [], selectedMcpUrl: 'http://127.0.0.1:7717/mcp',
    onSwitch: async () => {}, onConnected: async () => {}, onRetry: async () => {}, onManage: () => {},
  } }).body;
  renderFeatures = () => render(Features, { props: { onChanged: () => {} } }).body;
  renderAccess = () => render(Access).body;
});
afterAll(async () => { await server?.close(); });
const state: InstanceConnectionState = {
  environment: 'http://127.0.0.1:7717', passwordConfigured: false, passwordHint: '',
  setupAvailable: true, authenticated: false,
};

it('guides the first desktop connection through password setup without pretending data access is authenticated', () => {
  const html = renderConnection(state);
  expect(html).toContain('Set up your Working Memory password');
  expect(html).toContain('No owner password has been set');
  expect(html).toContain('Confirm password');
  expect(html).toContain('Password hint (optional)');
  expect(html).toContain('Set password and connect');
  expect(html).toContain('Manage instances');
});

it('shows the password hint as literal text on later connections with a clear retry path', () => {
  const html = renderConnection({ ...state, passwordConfigured: true, passwordHint: '<b>Reminder</b>' });
  expect(html).toContain('&lt;b>Reminder&lt;/b>');
  expect(html).not.toContain('<b>Reminder</b>');
  expect(html).toContain('aria-describedby="connection-password-hint"');
  expect(html).toContain('Retry connection');
  expect(html).not.toContain('Confirm password');
});

it('renders Features as a name-description-toggle grid without password or connection forms', () => {
  const html = renderFeatures();
  expect(html).toContain('<table ');
  expect(html).toContain('Feature name');
  expect(html).toContain('Short description');
  expect(html).toContain('Enabled');
  expect(html).toContain('role="switch"');
  expect(html).toContain('aria-label="Host tasks"');
  expect(html).not.toMatch(/type="password"|<form|Password hint|Sign in|Connection ·/);
});

it('keeps the public password hint editable in Access without enabling Host tasks or requesting the password again', () => {
  const html = renderAccess();
  expect(html).toContain('Edit password hint');
  expect(html).toContain('Password hint (optional)');
  expect(html).toContain('Save password hint');
  expect(html).toContain('visible before sign-in');
  expect(html).not.toMatch(/type="password"|Enable.*Host tasks/);
});
