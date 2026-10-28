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

it('offers native remembered sign-in without blocking session-only use when secure storage is unavailable', () => {
  const enabled = renderConnection({ ...state, passwordConfigured: true,
    rememberPasswordAvailable: true, rememberPasswordShared: true });
  expect(enabled).toContain('Remember on this device');
  expect(enabled).toContain('native secure storage');
  expect(enabled).toContain('Installed and development builds share remembered sign-in');
  expect(enabled).not.toContain('Sign out to forget it');
  const profileOnly = renderConnection({ ...state, rememberPasswordAvailable: true, rememberPasswordShared: false });
  expect(profileOnly).toContain('Other UI profiles need their own sign-in');
  const unavailable = renderConnection({ ...state, rememberPasswordAvailable: false,
    rememberPasswordError: 'Cannot unlock remembered sign-in.' });
  expect(unavailable).toContain('Native secure storage is unavailable');
  expect(unavailable).toContain('Cannot unlock remembered sign-in.');
  expect(unavailable).toMatch(/type="checkbox"[^>]*disabled/);
});

it('renders Features as a name-description-toggle grid without password or connection forms', () => {
  const html = renderFeatures();
  expect(html).toContain('<table ');
  expect(html).toContain('Feature name');
  expect(html).toContain('Short description');
  expect(html).toContain('Enabled');
  expect(html).toContain('role="switch"');
  expect(html).toMatch(/class="feature-switch[^"]*"/);
  expect(html).toContain('aria-label="Host tasks"');
  expect(html).not.toMatch(/type="password"|<form|Password hint|Sign in|Connection ·|Refresh features/);
});

it('renders one concise Access grid without password forms, refresh, save or sign-out actions', () => {
  const html = renderAccess();
  expect(html.match(/<table(?:\s|>)/g)).toHaveLength(1);
  for (const column of ['Client', 'Access', 'Status']) expect(html).toMatch(new RegExp(`<th[^>]*>${column}</th>`));
  expect(html).not.toMatch(/type="password"|Password hint|Refresh access requests|Sign out|>Save</);
  expect(html).toContain('90 days');
  expect(html).toContain('names are not verified');
});
