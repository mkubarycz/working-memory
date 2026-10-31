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
  private readonly stopping = new AbortController();
  private readonly opening = new Set<Promise<void>>();
  private disposal: Promise<void> | undefined;

  constructor(
    private readonly temporaryRoot: string,
    private readonly fetchImage: (request: Request) => Promise<Response>,
    private readonly openPath: (path: string) => Promise<string>,
  ) {}

  open(source: string): Promise<void> {
    if (this.stopping.signal.aborted) return Promise.reject(new Error('The image viewer is shutting down.'));
    const pending = this.openImage(source);
    this.opening.add(pending);
    const finished = () => { this.opening.delete(pending); };
    void pending.then(finished, finished);
    return pending;
  }

  private async openImage(source: string): Promise<void> {
    const url = new URL(source);
    if (!['working-memory-attachment:', 'https:', 'http:'].includes(url.protocol)
      || url.username || url.password) {
      throw new Error('Only instance attachments and HTTP(S) images can be opened in the system viewer.');
    }
    const response = await this.fetchImage(new Request(url, {
      signal: AbortSignal.any([this.stopping.signal, AbortSignal.timeout(30_000)]),
    }));
    if (!response.ok) throw new Error(`Unable to load image (${response.status}).`);
    const reader = response.body?.getReader();
    if (!reader) throw new Error('The image response was empty.');
    const chunks: Buffer[] = [];
    let size = 0;
    try {
      this.stopping.signal.throwIfAborted();
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
    this.stopping.signal.throwIfAborted();
    this.directory ??= mkdtemp(join(this.temporaryRoot, 'working-memory-images-'));
    const directory = await this.directory;
    this.stopping.signal.throwIfAborted();
    const path = join(directory, `${randomUUID()}.${extension}`);
    await writeFile(path, data, { mode: 0o600, flag: 'wx' });
    this.stopping.signal.throwIfAborted();
    const error = await this.openPath(path);
    if (error) throw new Error(`Unable to open the system image viewer: ${error}`);
  }

  dispose(): Promise<void> {
    this.stopping.abort();
    this.disposal ??= this.cleanup();
    return this.disposal;
  }

  private async cleanup(): Promise<void> {
    await Promise.allSettled(this.opening);
    if (this.directory) await rm(await this.directory, { recursive: true, force: true });
  }
}
