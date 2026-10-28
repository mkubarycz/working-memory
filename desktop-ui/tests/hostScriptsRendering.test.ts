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
  it('loads connection state before presenting owner-controlled scripts', () => {
    const html = renderHostTasks();
    expect(html).toContain('Approved host tasks');
    expect(html).toContain('Loading task…');
    expect(html).not.toContain('Instance password');
    expect(html).not.toContain('Import broker admin token');
    expect(html).not.toContain('Read Thrive items created by');
    expect(html).not.toContain('Approve an expiring grant');
    expect(html).not.toMatch(/Thrive|Windows|My Node\.js scripts|<dialog/);
  });
  it('does not expose script actions while authentication is loading', () => {
    const html = renderHostTasks();
    expect(html).not.toContain('aria-label="Task title"');
    expect(html).not.toContain('>Test</button>');
    expect(html).not.toContain('Start runner');
    expect(html).not.toContain('Add greeting demo');
  });
});
