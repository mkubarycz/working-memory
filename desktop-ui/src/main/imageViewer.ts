import { randomUUID } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

const MAX_IMAGE_BYTES = 30 * 1024 * 1024;

function imageExtension(data: Buffer): string {
  if (data.subarray(0, 8).equals(Buffer.from('89504e470d0a1a0a', 'hex'))) return 'png';
  if (data[0] === 0xff && data[1] === 0xd8 && data[2] === 0xff) return 'jpg';
  if (/^GIF8[79]a$/.test(data.toString('ascii', 0, 6))) return 'gif';
  if (data.toString('ascii', 0, 4) === 'RIFF' && data.toString('ascii', 8, 12) === 'WEBP') return 'webp';
  if (data.toString('ascii', 4, 8) === 'ftyp' && /^(avif|avis)$/.test(data.toString('ascii', 8, 12))) return 'avif';
  throw new Error('Only PNG, JPEG, GIF, WebP, and AVIF images can be opened in the system viewer.');
}

export class DesktopImageViewer {
  private directory: Promise<string> | undefined;

  constructor(
    private readonly temporaryRoot: string,
    private readonly fetchImage: (request: Request) => Promise<Response>,
    private readonly openPath: (path: string) => Promise<string>,
  ) {}

  async open(source: string): Promise<void> {
    const url = new URL(source);
    if (!['working-memory-attachment:', 'https:', 'http:'].includes(url.protocol)
      || url.username || url.password) {
      throw new Error('Only instance attachments and HTTP(S) images can be opened in the system viewer.');
    }
    const response = await this.fetchImage(new Request(url, { signal: AbortSignal.timeout(30_000) }));
    if (!response.ok) throw new Error(`Unable to load image (${response.status}).`);
    const reader = response.body?.getReader();
    if (!reader) throw new Error('The image response was empty.');
    const chunks: Buffer[] = [];
    let size = 0;
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.byteLength;
        if (size > MAX_IMAGE_BYTES) throw new Error('Images opened in the system viewer must be at most 30 MB.');
        chunks.push(Buffer.from(value));
      }
    } finally {
      await reader.cancel();
    }
    const data = Buffer.concat(chunks);
    if (data.length === 0) throw new Error('The image response was empty.');
    const extension = imageExtension(data);
    this.directory ??= mkdtemp(join(this.temporaryRoot, 'working-memory-images-'));
    const path = join(await this.directory, `${randomUUID()}.${extension}`);
    await writeFile(path, data, { mode: 0o600, flag: 'wx' });
    const error = await this.openPath(path);
    if (error) throw new Error(`Unable to open the system image viewer: ${error}`);
  }

  async dispose(): Promise<void> {
    if (this.directory) await rm(await this.directory, { recursive: true, force: true });
  }
}
