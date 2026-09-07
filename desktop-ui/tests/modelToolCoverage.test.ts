import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { clearKinds } from '../../control-plane/src/kinds/registry';
import { loadKinds } from '../../control-plane/src/kinds/loader';
import { startServer, type RunningServer } from '../../control-plane/src/server';
import { desktopToolDescriptors } from '../src/main/modelTools';

describe('desktop tool coverage', () => {
  let server: RunningServer;
  let client: Client;

  beforeAll(async () => {
    clearKinds();
    await loadKinds();
    server = await startServer({ port: 0 });
    client = new Client({ name: 'wm-desktop-tool-coverage', version: '0.0.0' });
    await client.connect(new StreamableHTTPClientTransport(new URL(`${server.url}/mcp`)));
  });

  afterAll(async () => {
    await client?.close();
    await server?.close();
  });

  it('projects every registered tool in the supported high-level ws families', async () => {
    const canonical = (await client.listTools()).tools;
    const projected = desktopToolDescriptors(canonical).map((tool) => tool.name);
    const requestedFamilies = ['workstream', 'topic', 'topictype', 'alert', 'config', 'nanite', 'nanitetemplate', 'nanitejournal'];
    const expected = canonical
      .map((tool) => tool.name)
      .filter((name) => requestedFamilies.some((family) => name.startsWith(`ws-${family}-`)));

    expect(projected).toEqual(expected);
    expect(new Set(projected.map((name) => name.split('-').slice(0, 2).join('-')))).toEqual(new Set([
      'ws-workstream',
      'ws-topic',
      'ws-topictype',
      'ws-alert',
      'ws-config',
      'ws-nanite',
      'ws-nanitetemplate',
      'ws-nanitejournal',
    ]));
    expect(projected.some((name) => name.startsWith('wm-document-'))).toBe(false);
  });
});