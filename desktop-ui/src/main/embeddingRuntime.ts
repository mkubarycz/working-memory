import { createHash } from 'node:crypto';
import { createReadStream, existsSync } from 'node:fs';
import { mkdir, rename, unlink, open } from 'node:fs/promises';
import { join } from 'node:path';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { embeddingInferenceSchema, embeddingReadySchema } from '../../../control-plane/src/embeddingContract';

const REVISION = '1110a243fdf4706b3f48f1d95db1a4f5529b4d41';
export const EMBEDDING_FILES = [
  { name: 'tokenizer.json', remote: 'tokenizer.json', size: 466247, sha256: 'be50c3628f2bf5bb5e3a7f17b1f74611b2561a3a27eeab05e5aa30f411572037' },
  { name: 'model.onnx', remote: 'onnx/model.onnx', size: 90405214, sha256: '6fd5d72fe4589f189f8ebc006442dbb529bb7ce38f8082112682524616046452' },
] as const;
export const EMBEDDING_DOWNLOAD_BYTES = EMBEDDING_FILES.reduce((sum, file) => sum + file.size, 0);

async function verified(path: string, expected: string): Promise<boolean> {
  if (!existsSync(path)) return false;
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest('hex') === expected;
}

export async function installEmbeddingModel(directory: string, signal: AbortSignal, progress: (bytes: number) => void): Promise<void> {
  await mkdir(directory, { recursive: true });
  let completed = 0;
  for (const file of EMBEDDING_FILES) {
    signal.throwIfAborted();
    const destination = join(directory, file.name);
    if (await verified(destination, file.sha256)) {
      completed += file.size;
      progress(completed);
      continue;
    }
    const partial = `${destination}.part`;
    const handle = await open(partial, 'w', 0o600);
    let received = 0;
    const hash = createHash('sha256');
    try {
      const response = await fetch(`https://huggingface.co/sentence-transformers/all-MiniLM-L6-v2/resolve/${REVISION}/${file.remote}`,
        { signal: AbortSignal.any([signal, AbortSignal.timeout(300000)]), credentials: 'omit' });
      if (!response.ok || !response.body) throw new Error(`Model download failed (HTTP ${response.status}). Retry when connected.`);
      for await (const chunk of response.body) {
        signal.throwIfAborted();
        received += chunk.byteLength;
        if (received > file.size) throw new Error('Model download exceeded its verified size.');
        hash.update(chunk);
        await handle.writeFile(chunk);
        progress(completed + received);
      }
      if (received !== file.size || hash.digest('hex') !== file.sha256) throw new Error('Model verification failed. Retry the download.');
      await handle.close();
      await rename(partial, destination);
    } catch (error) {
      await handle.close();
      await unlink(partial);
      throw error;
    }
    completed += file.size;
  }
}

export type EmbeddingInference = ReturnType<typeof embeddingInferenceSchema.parse>;

export class EmbeddingRuntime {
  private child: ChildProcessWithoutNullStreams | null = null;
  private pending: { resolve: (value: unknown) => void; reject: (error: Error) => void } | null = null;
  private sequence = 0;
  backend: string | null = null;
  warning: string | null = null;
  rssBytes: number | null = null;
  failure: string | null = null;
  constructor(private executable: string, private directory: string) {}

  private receive(value: unknown): void {
    const pending = this.pending;
    if (!pending) return;
    this.pending = null;
    if (value && typeof value === 'object' && 'error' in value && typeof value.error === 'string') {
      pending.reject(new Error(value.error));
    } else pending.resolve(value);
  }

  private wait(signal: AbortSignal): Promise<unknown> {
    if (this.pending) throw new Error('Embedding runtime is already processing a request.');
    signal.throwIfAborted();
    return new Promise((resolve, reject) => {
      const finish = () => { clearTimeout(timer); signal.removeEventListener('abort', aborted); };
      const fail = (error: Error) => { finish(); reject(error); };
      const aborted = () => this.stop();
      const timer = setTimeout(() => this.stop(), 300000);
      signal.addEventListener('abort', aborted, { once: true });
      this.pending = { resolve: value => { finish(); resolve(value); }, reject: fail };
    });
  }

  async start(signal: AbortSignal): Promise<void> {
    if (this.child) return;
    if (!existsSync(this.executable)) throw new Error('The bundled embedding helper is missing. Reinstall Working Memory.');
    const ready = this.wait(signal);
    const child = spawn(this.executable, [this.directory], { stdio: 'pipe', windowsHide: true });
    this.child = child;
    let buffer = '';
    let stderr = '';
    child.stderr.on('data', (data: Buffer) => { stderr = (stderr + data.toString()).slice(-4000); });
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (data: string) => {
      buffer += data;
      if (buffer.length > 2_000_000) { this.stop(); return; }
      let newline: number;
      while ((newline = buffer.indexOf('\n')) !== -1) {
        const line = buffer.slice(0, newline);
        buffer = buffer.slice(newline + 1);
        try { this.receive(JSON.parse(line)); }
        catch { this.receive({ error: 'Embedding helper returned an invalid response.' }); this.stop(); }
      }
    });
    child.once('error', error => { this.receive({ error: `Embedding helper could not launch: ${error.message}` }); this.stop(); });
    child.once('exit', code => {
      if (this.child === child) {
        this.child = null;
        this.backend = null;
        this.rssBytes = null;
        this.failure = `Embedding helper stopped (exit ${code}). ${stderr}`;
        this.receive({ error: this.failure });
      }
    });
    try {
      const state = embeddingReadySchema.parse(await ready);
      this.backend = state.backend;
      this.warning = state.warning;
      this.rssBytes = state.rssBytes;
    } catch (error) { this.stop(); throw error; }
  }

  async embed(texts: string[], signal: AbortSignal): Promise<EmbeddingInference> {
    await this.start(signal);
    const result = this.wait(signal);
    const id = ++this.sequence;
    this.child!.stdin.write(`${JSON.stringify({ id, texts })}\n`, error => {
      if (error) { this.receive({ error: `Embedding helper write failed: ${error.message}` }); this.stop(); }
    });
    const parsed = embeddingInferenceSchema.parse(await result);
    if (parsed.id !== id || parsed.vectors.length !== texts.length) throw new Error('Embedding helper response did not match the request.');
    this.rssBytes = parsed.rssBytes;
    return parsed;
  }

  stop(): void {
    const child = this.child;
    this.child = null;
    this.backend = null;
    this.rssBytes = null;
    this.failure = null;
    this.receive({ error: 'Embedding runtime stopped or timed out. Retry from Settings > Diagnostics > Embeddings.' });
    child?.stdin.end();
    child?.kill();
  }
}
