import { createServer } from 'node:http';
import { createHash, timingSafeEqual } from 'node:crypto';
import { appendFileSync, readFileSync, writeFileSync, renameSync } from 'node:fs';
import { join } from 'node:path';
import {
  EMBEDDING_MODEL, EMBEDDING_HOST_PORT, embeddingHostRequestSchema,
  embeddingHostSettingsSchema, type EmbeddingHostSettings, type embeddingHostStatusSchema,
} from '../../../control-plane/src/embeddingContract';
import { EmbeddingRuntime, installEmbeddingModel } from './embeddingRuntime';

type Status = ReturnType<typeof embeddingHostStatusSchema.parse>;
export function readEmbeddingHostSettings(home: string): EmbeddingHostSettings {
  let contents: string;
  try { contents = readFileSync(join(home, 'model-settings.json'), 'utf8'); }
  catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return { idleTimeoutMinutes: null };
    throw error;
  }
  return embeddingHostSettingsSchema.parse(JSON.parse(contents));
}
export async function startEmbeddingHostService(home: string, executable: string, version: string, port = EMBEDDING_HOST_PORT) {
  const token = readFileSync(join(home, 'host-token'), 'utf8').trim();
  if (!/^[a-f0-9]{64}$/.test(token)) throw new Error('Host inference credentials are invalid. Reinstall from Embeddings diagnostics.');
  const tokenHash = createHash('sha256').update(`Bearer ${token}`).digest();
  const runtime = new EmbeddingRuntime(executable, join(home, 'minilm-1110a243'));
  let settings = readEmbeddingHostSettings(home);
  let busy = false;
  let active: AbortController | undefined;
  let lastUse = Date.now();
  let closing = false;
  const state: Status = { model: EMBEDDING_MODEL, version, phase: 'idle', downloadBytes: 0,
    backend: null, warning: null, error: null, rssBytes: null };
  const log = (message: string) => appendFileSync(join(home, 'service.log'), `${new Date().toISOString()} ${message}\n`, { mode: 0o600 });
  const server = createServer((req, res) => {
    res.setHeader('Content-Type', 'application/json');
    res.setHeader('Cache-Control', 'no-store');
    const answer = (code: number, value: unknown) => { res.writeHead(code); res.end(JSON.stringify(value)); };
    const hash = createHash('sha256').update(req.headers.authorization ?? '').digest();
    if (!timingSafeEqual(hash, tokenHash)) { answer(401, { error: 'Unauthorized' }); return; }
    const metrics = req.headers['x-wm-embedding-metrics'] === '1';
    if (req.method === 'GET' && req.url === '/status') {
      answer(200, { ...state, ...(metrics ? settings : {}), backend: runtime.backend, warning: runtime.warning,
        rssBytes: runtime.rssBytes, error: runtime.failure ?? state.error,
        phase: runtime.failure ? 'error' : state.phase });
      return;
    }
    const configuring = req.method === 'PUT' && req.url === '/settings';
    if (!configuring && (req.method !== 'POST' || req.url !== '/embed')) { answer(404, { error: 'Unknown inference operation' }); return; }
    if (closing || (!configuring && busy)) { answer(409, { error: 'Inference service is busy; retry shortly.' }); return; }
    if (!req.headers['content-type']?.startsWith('application/json')) { answer(415, { error: 'Expected application/json' }); return; }
    if (!configuring) busy = true;
    const controller = new AbortController();
    if (!configuring) active = controller;
    res.once('close', () => { if (!res.writableEnded) controller.abort(); });
    void (async () => {
      const chunks: Buffer[] = [];
      let size = 0;
      for await (const chunk of req) {
        size += chunk.length;
        if (size > (configuring ? 4096 : 500000)) { answer(413, { error: 'Inference request exceeds the passage limit.' }); return; }
        chunks.push(Buffer.from(chunk));
      }
      let input;
      if (configuring) {
        let next: EmbeddingHostSettings;
        try { next = embeddingHostSettingsSchema.parse(JSON.parse(Buffer.concat(chunks).toString('utf8'))); }
        catch { answer(400, { error: 'Invalid model retention setting.' }); return; }
        const file = join(home, 'model-settings.json');
        writeFileSync(`${file}.tmp`, JSON.stringify(next), { mode: 0o600 });
        renameSync(`${file}.tmp`, file);
        settings = next;
        answer(200, settings);
        return;
      }
      try { input = embeddingHostRequestSchema.parse(JSON.parse(Buffer.concat(chunks).toString('utf8'))); }
      catch { answer(400, { error: 'Invalid model or passages.' }); return; }
      controller.signal.throwIfAborted();
      if (runtime.failure) runtime.stop();
      state.error = null;
      const startup = performance.now();
      const cold = !runtime.backend;
      if (!runtime.backend) {
        state.phase = 'downloading';
        await installEmbeddingModel(join(home, 'minilm-1110a243'), controller.signal, bytes => { state.downloadBytes = bytes; });
        state.phase = 'starting';
        await runtime.start(controller.signal);
      }
      state.phase = 'indexing';
      const startupMs = cold ? performance.now() - startup : 0;
      const result = await runtime.embed(input.texts, controller.signal);
      controller.signal.throwIfAborted();
      state.phase = 'idle';
      answer(200, { ...result, ...(metrics ? { startupMs } : {}) });
    })().catch(error => {
      if (!controller.signal.aborted) {
        const message = error instanceof Error ? error.message : 'Host inference failed.';
        if (!configuring) { state.error = message; state.phase = 'error'; }
        log(message);
        if (!res.headersSent && !res.destroyed) answer(500, { error: message });
      }
      if (!configuring) runtime.stop();
    }).finally(() => {
      if (!configuring) {
        busy = false;
        active = undefined;
        lastUse = Date.now();
        if (controller.signal.aborted) state.phase = 'idle';
      }
    });
  });
  server.requestTimeout = 30000;
  server.headersTimeout = 10000;
  await new Promise<void>((resolve, reject) => {
    const fail = (error: Error) => reject(error);
    server.once('error', fail);
    server.listen(port, '127.0.0.1', () => { server.removeListener('error', fail); resolve(); });
  });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Host inference service did not bind a TCP port.');
  const idle = setInterval(() => {
    if (!busy && settings.idleTimeoutMinutes !== null && Date.now() - lastUse >= settings.idleTimeoutMinutes * 60000) {
      if (runtime.failure) { state.error = runtime.failure; state.phase = 'error'; }
      runtime.stop();
      if (state.phase !== 'error') state.phase = 'idle';
    }
  }, 10000);
  idle.unref();
  log(`Host inference service ${version} started on loopback port ${EMBEDDING_HOST_PORT}.`);
  return {
    port: address.port,
    async close() {
      closing = true;
      clearInterval(idle);
      active?.abort();
      runtime.stop();
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    },
  };
}
