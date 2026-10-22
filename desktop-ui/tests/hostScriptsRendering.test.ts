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
  const { default: HostTasks } = await server.ssrLoadModule('/src/renderer/HostTasks.svelte');
  renderHostTasks = () => render(HostTasks, { props: { onClose: () => {} } }).body;
});
afterAll(async () => { await server?.close(); });

describe('generic host-task first screen', () => {
  it('leads with owner-controlled scripts rather than the blocked Thrive-specific form', () => {
    const html = renderHostTasks();
    expect(html).toContain('Approved host tasks');
    expect(html).toContain('My Node.js scripts');
    expect(html).toContain('Your script. Your parameter contract. Your approval.');
    expect(html).toContain('Connect / refresh');
    expect(html).toContain('Import broker admin token');
    expect(html).not.toContain('Read Thrive items created by');
    expect(html).not.toContain('Approve an expiring grant');
  });
  it('explains Keychain, the trust boundary, and why unconfigured scripts cannot execute', () => {
    const html = renderHostTasks();
    expect(html).toContain('not in a sandbox');
    expect(html).toContain('not a task approval');
    expect(html).toContain('WM_HOST_TASK_ADMIN_TOKEN_FILE');
    expect(html).toContain('Thrive / Windows (experimental)');
    expect(html).not.toContain('Start local runner');
  });
});
