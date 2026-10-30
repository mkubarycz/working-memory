import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, readFile, readdir, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { extname, join } from 'node:path';
import { DesktopImageViewer } from '../src/main/imageViewer';
import { serveInstanceAttachment } from '../src/main/instanceAttachments';

const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=', 'base64');
const source = 'working-memory-attachment://instance-7717/attachments/60138e0f-1ca7-460d-a66b-2bc80fb82942';
const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });

async function fixture(fetchImage: (request: Request) => Promise<Response> = async () => new Response(png)) {
  const root = await mkdtemp(join(tmpdir(), 'working-memory-image-viewer-test-'));
  roots.push(root);
  const openPath = vi.fn(async (_path: string) => '');
  const fetcher = vi.fn(fetchImage);
  const viewer = new DesktopImageViewer(root, fetcher, openPath);
  return { root, viewer, openPath, fetchImage: fetcher };
}

describe('system image viewer', () => {
  it('writes a private raster image, opens the default viewer, and cleans temporary files on disposal', async () => {
    const { root, viewer, openPath, fetchImage } = await fixture();
    await viewer.open(source);
    expect(fetchImage).toHaveBeenCalledOnce();
    expect(fetchImage.mock.calls[0][0].url).toBe(source);
    const path = openPath.mock.calls[0][0];
    expect(extname(path)).toBe('.png');
    expect(await readFile(path)).toEqual(png);
    if (process.platform !== 'win32') {
      expect((await stat(path)).mode & 0o777).toBe(0o600);
    }
    await viewer.dispose();
    expect(await readdir(root)).toEqual([]);
  });

  it.each([
    ['image.jpg', Buffer.from([0xff, 0xd8, 0xff, 0xe0]), '.jpg'],
    ['image.gif', Buffer.from('GIF89a'), '.gif'],
    ['image.webp', Buffer.from('RIFF0000WEBP'), '.webp'],
    ['image.avif', Buffer.from('0000ftypavif'), '.avif'],
  ])('uses a raster extension derived from bytes rather than the URL: %s', async (_label, data, extension) => {
    const { viewer, openPath } = await fixture(vi.fn(async () => new Response(data)));
    await viewer.open('https://example.com/image?filename=malicious.exe');
    expect(extname(openPath.mock.calls[0][0])).toBe(extension);
    await viewer.dispose();
  });

  it('rejects arbitrary files, executable protocols, and credential-bearing URLs before fetching', async () => {
    const { viewer, fetchImage, openPath } = await fixture();
    for (const url of ['file:///private/image.png', 'javascript:alert(1)', 'https://user:password@example.com/image.png']) {
      await expect(viewer.open(url)).rejects.toThrow('Only instance attachments');
    }
    expect(fetchImage).not.toHaveBeenCalled();
    expect(openPath).not.toHaveBeenCalled();
  });

  it('does not open HTML, SVG, or executable content even when declared to be an image', async () => {
    for (const bytes of ['<html>not an image</html>', '<svg onload="alert(1)"/>', 'MZ executable']) {
      const { viewer, openPath } = await fixture(vi.fn(async () => new Response(bytes, {
        headers: { 'content-type': 'image/png' },
      })));
      await expect(viewer.open(source)).rejects.toThrow('Only PNG');
      expect(openPath).not.toHaveBeenCalled();
    }
  });

  it('surfaces download, empty-image, size-limit, and default-viewer errors', async () => {
    const failed = await fixture(vi.fn(async () => new Response('denied', { status: 401 })));
    await expect(failed.viewer.open(source)).rejects.toThrow('Unable to load image (401)');
    const empty = await fixture(vi.fn(async () => new Response('')));
    await expect(empty.viewer.open(source)).rejects.toThrow('image response was empty');
    const oversized = await fixture(vi.fn(async () => new Response(new Uint8Array(30 * 1024 * 1024 + 1))));
    await expect(oversized.viewer.open(source)).rejects.toThrow('at most 30 MB');
    expect(oversized.openPath).not.toHaveBeenCalled();
    const shellFailure = await fixture();
    shellFailure.openPath.mockResolvedValue('No application is associated with this file');
    await expect(shellFailure.viewer.open(source)).rejects.toThrow('No application is associated');
    await shellFailure.viewer.dispose();
  });

  it('uses the existing authenticated attachment proxy and refuses another environment', async () => {
    const client = { fetch: vi.fn(async (_input: string | URL | Request, _init?: RequestInit) => new Response(png)) };
    const environment = { id: 'test', port: 7717, mcpUrl: 'http://127.0.0.1:7717/mcp', displayName: 'Test', source: 'sandbox' as const };
    const { viewer, openPath } = await fixture(request => serveInstanceAttachment(request, environment, client));
    await viewer.open(source);
    expect(String(client.fetch.mock.calls[0][0])).toBe('http://127.0.0.1:7717/attachments/60138e0f-1ca7-460d-a66b-2bc80fb82942');
    await expect(viewer.open(source.replace('instance-7717', 'instance-7719'))).rejects.toThrow('(403)');
    expect(client.fetch).toHaveBeenCalledOnce();
    expect(openPath).toHaveBeenCalledOnce();
    await viewer.dispose();
  });
});
