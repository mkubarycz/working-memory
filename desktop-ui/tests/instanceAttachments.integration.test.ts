import { afterEach, expect, it, vi } from 'vitest';
import { openStore } from '../../control-plane/src/store';
import { startServer } from '../../control-plane/src/server';
import { InstanceIdentity } from '../../control-plane/src/instanceIdentity';
import { ControlPlaneClient } from '../../shared/controlPlaneClient';
import { serveInstanceAttachment } from '../src/main/instanceAttachments';
import { instanceAttachmentBaseUrl } from '../src/shared/instanceAttachments';

const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); vi.restoreAllMocks(); });

it('proxies private images through the current instance without putting tokens in renderer URLs', async () => {
  const store = openStore(':memory:');
  const identity = new InstanceIdentity(store.db), owner = await identity.initialize('test image owner password');
  const server = await startServer({ port: 0, store });
  cleanup.push(async () => { await server.close(); store.close(); });
  const client = new ControlPlaneClient({ resolveUrl: () => `${server.url}/mcp`, getToken: () => owner.token });
  cleanup.push(() => client.dispose());
  const image = Buffer.from('private image bytes');
  const uploaded = await client.fetch(`${server.url}/attachments`, {
    method: 'POST', headers: { 'content-type': 'image/png', 'x-file-name': 'private.png' }, body: image,
  });
  const attachment = await uploaded.json() as { id: string };
  const environment = { id: 'test', port: server.port, displayName: 'Test', mcpUrl: `${server.url}/mcp`, source: 'sandbox' as const };
  const request = new Request(`${instanceAttachmentBaseUrl(server.port)}/attachments/${attachment.id}`);
  expect(request.url).not.toContain(owner.token);
  expect((await fetch(`${server.url}/attachments/${attachment.id}`)).status).toBe(401);
  const response = await serveInstanceAttachment(request, environment, client);
  expect(response.status).toBe(200);
  expect(response.headers.get('cache-control')).toBe('no-store');
  expect(Buffer.from(await response.arrayBuffer())).toEqual(image);
  expect((await serveInstanceAttachment(request, { ...environment, port: server.port + 1 }, client)).status).toBe(403);
  for (const base of [`working-memory-attachment://${server.port}`,
    'working-memory-attachment://0.0.30.37', `${instanceAttachmentBaseUrl(server.port)}:1234`]) {
    expect((await serveInstanceAttachment(new Request(`${base}/attachments/${attachment.id}`), environment, client)).status).toBe(403);
  }
  vi.spyOn(console, 'error').mockImplementation(() => {});
  identity.revoke(owner.token);
  expect((await serveInstanceAttachment(request, environment, client)).status).toBe(401);
});
