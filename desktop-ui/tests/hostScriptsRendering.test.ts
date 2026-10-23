import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createServer, type ViteDevServer } from 'vite';
import { svelte } from '@sveltejs/vite-plugin-svelte';

let server: ViteDevServer;
let renderHostTasks: () => string;
beforeAll(async () => {
  server = await createServer({
    configFile: false, root: new URL('..', import.meta.url).pathname,
    plugins: [svelte()], server: { middlewareMode: true }, appType: 'custom',
  });
  const { render } = await server.ssrLoadModule('svelte/server');
  const { default: HostScripts } = await server.ssrLoadModule('/src/renderer/HostScripts.svelte');
  renderHostTasks = () => render(HostScripts).body;
});
afterAll(async () => { await server?.close(); });

describe('generic host-task first screen', () => {
  it('leads with owner-controlled scripts rather than the blocked Thrive-specific form', () => {
    const html = renderHostTasks();
    expect(html).toContain('Approved host tasks');
    expect(html).toContain('Connect to your Working Memory instance');
    expect(html).toContain('Instance password');
    expect(html).toContain('Password hint:');
    expect(html).toContain('aria-describedby="instance-password-hint"');
    expect(html).not.toContain('Import broker admin token');
    expect(html).not.toContain('Read Thrive items created by');
    expect(html).not.toContain('Approve an expiring grant');
    expect(html).not.toMatch(/Thrive|Windows|My Node\.js scripts|<dialog/);
  });
  it('explains session-only authentication separately from script approval', () => {
    const html = renderHostTasks();
    expect(html).toContain('does not approve a script');
    expect(html).toContain('no Keychain or token-file import is required');
    expect(html).not.toContain('Start runner');
    expect(html).not.toContain('Add greeting demo');
  });
});
