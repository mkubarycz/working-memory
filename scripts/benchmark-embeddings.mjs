import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { copyFile, mkdtemp, readFile, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { performance } from 'node:perf_hooks';

export async function startBenchmarkEmbeddings(executable, modelDirectory, signal) {
  const { EMBEDDING_MODEL, embeddingReadySchema, embeddingInferenceSchema, embeddingHostRequestSchema } =
    await import('../out/control-plane/embeddingContract.js');
  const directory = await mkdtemp(join(tmpdir(), 'wm-benchmark-model-'));
  let child, server, timer, pending;
  const metrics = { outsideBackendLimit: true, model: EMBEDDING_MODEL, requests: 0, passages: 0,
    inferredPassages: 0, exactTextCacheHits: 0, inferenceMs: 0, peakSampledRssBytes: 0,
    sampleIntervalMs: 1000, cpuSeconds: 0, modelFiles: {}, stderr: '', indexingCacheLimit: 4096 };
  const cache = new Map();
  const sample = () => {
    const output = execFileSync('ps', ['-p', String(child.pid), '-o', 'time=', '-o', 'rss='],
      { encoding: 'utf8' }).trim().split(/\s+/);
    const parts = output[0].split(':').map(Number);
    metrics.cpuSeconds = parts.reduce((sum, value) => sum * 60 + value, 0);
    metrics.peakSampledRssBytes = Math.max(metrics.peakSampledRssBytes, Number(output[1]) * 1024);
  };
  function wait() {
    assert.ok(!pending, 'Embedding helper requests must be serial');
    signal.throwIfAborted();
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        pending = undefined;
        child.kill();
        reject(new Error('Benchmark embedding helper timed out'));
      }, 300000);
      pending = { resolve: value => { clearTimeout(timeout); pending = undefined; resolve(value); },
        reject: error => { clearTimeout(timeout); pending = undefined; reject(error); } };
    });
  }
  const close = async () => {
    clearInterval(timer);
    signal.removeEventListener('abort', aborted);
    try {
      if (server?.listening) {
        server.closeAllConnections();
        await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
        if (metrics.httpServer) metrics.httpServer.closedAt = new Date().toISOString();
      }
    } finally {
      try {
        if (child && child.exitCode === null && child.signalCode === null) {
          try { sample(); }
          catch (error) { metrics.samplingError = error.message; }
          const exited = new Promise(resolve => child.once('exit', resolve));
          child.stdin.end();
          child.kill();
          await exited;
        }
      } finally { await rm(directory, { recursive: true }); }
    }
  };
  const aborted = () => { pending?.reject(signal.reason); child?.kill(); };
  try {
    const expected = {
      'tokenizer.json': 'be50c3628f2bf5bb5e3a7f17b1f74611b2561a3a27eeab05e5aa30f411572037',
      'model.onnx': '6fd5d72fe4589f189f8ebc006442dbb529bb7ce38f8082112682524616046452',
    };
    for (const [name, hash] of Object.entries(expected)) {
      const source = join(modelDirectory, name);
      const sha256 = createHash('sha256').update(await readFile(source)).digest('hex');
      assert.equal(sha256, hash, `Use the existing verified ${EMBEDDING_MODEL} model`);
      await copyFile(source, join(directory, name));
      metrics.modelFiles[name] = sha256;
    }
    metrics.runtimeSha256 = createHash('sha256').update(await readFile(executable)).digest('hex');
    const startup = performance.now();
    const ready = wait();
    child = spawn(executable, [directory], { stdio: 'pipe' });
    signal.addEventListener('abort', aborted, { once: true });
    child.once('error', error => pending?.reject(error));
    child.once('exit', (code, signal) => {
      pending?.reject(new Error(`Benchmark embedding helper exited (${code ?? signal}): ${metrics.stderr}`));
    });
    child.stderr.on('data', data => { metrics.stderr = (metrics.stderr + data.toString()).slice(-4000); });
    const lines = createInterface({ input: child.stdout });
    lines.on('line', line => {
      try {
        const value = JSON.parse(line);
        if (value.error) pending?.reject(new Error(value.error));
        else pending?.resolve(value);
      } catch (error) { pending?.reject(error); }
    });
    const state = embeddingReadySchema.parse(await ready);
    Object.assign(metrics, state, { startupMs: performance.now() - startup });
    sample();
    timer = setInterval(() => {
      try { sample(); }
      catch (error) { metrics.samplingError = error.message; clearInterval(timer); }
    }, 1000);
    let sequence = 0, busy = false;
    async function embed(texts, useCache = true) {
      const input = embeddingHostRequestSchema.parse({ model: EMBEDDING_MODEL, texts });
      metrics.requests++;
      metrics.passages += texts.length;
      const missing = useCache ? [...new Set(input.texts.filter(text => !cache.has(text)))] : input.texts;
      let inferred;
      if (missing.length) {
        const response = wait();
        const id = ++sequence;
        child.stdin.write(`${JSON.stringify({ id, texts: missing })}\n`, error => { if (error) pending?.reject(error); });
        const result = embeddingInferenceSchema.parse(await response);
        assert.equal(result.id, id);
        assert.equal(result.vectors.length, missing.length);
        metrics.inferredPassages += missing.length;
        metrics.inferenceMs += result.durationMs;
        metrics.peakSampledRssBytes = Math.max(metrics.peakSampledRssBytes, result.rssBytes);
        inferred = result.vectors;
        if (useCache) missing.forEach((text, i) => cache.set(text, result.vectors[i]));
      }
      metrics.exactTextCacheHits += texts.length - missing.length;
      const vectors = useCache ? texts.map(text => cache.get(text)) : inferred;
      while (cache.size > 4096) cache.delete(cache.keys().next().value);
      return vectors;
    }
    const token = randomBytes(32).toString('hex');
    server = createServer((req, res) => {
      res.setHeader('Content-Type', 'application/json');
      const answer = (code, value) => { res.writeHead(code); res.end(JSON.stringify(value)); };
      if (req.headers.authorization !== `Bearer ${token}`) return answer(401, { error: 'Unauthorized' });
      if (req.method === 'GET' && req.url === '/status') return answer(200, {
        model: EMBEDDING_MODEL, version: 'isolated-benchmark', phase: 'idle', downloadBytes: 0,
        backend: state.backend, warning: state.warning, error: null, rssBytes: metrics.peakSampledRssBytes,
      });
      if (req.method !== 'POST' || req.url !== '/embed') return answer(404, { error: 'Unknown operation' });
      if (busy) return answer(409, { error: 'Inference is busy' });
      busy = true;
      void (async () => {
        const chunks = [];
        let length = 0;
        for await (const chunk of req) {
          length += chunk.length;
          assert.ok(length <= 500000, 'Embedding request exceeds the passage limit');
          chunks.push(chunk);
        }
        const input = embeddingHostRequestSchema.parse(JSON.parse(Buffer.concat(chunks).toString('utf8')));
        const started = performance.now();
        const vectors = await embed(input.texts, false);
        answer(200, { id: ++sequence, vectors, durationMs: performance.now() - started,
          rssBytes: metrics.peakSampledRssBytes, startupMs: 0 });
      })().catch(error => answer(500, { error: error.message })).finally(() => { busy = false; });
    });
    await new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', resolve);
    });
    metrics.httpServer = { startedAt: new Date().toISOString(), keepAliveTimeoutMs: server.keepAliveTimeout,
      keepAliveTimeoutBufferMs: server.keepAliveTimeoutBuffer, headersTimeoutMs: server.headersTimeout,
      requestTimeoutMs: server.requestTimeout, socketTimeoutMs: server.timeout };
    return { endpoint: `http://host.docker.internal:${server.address().port}`, token, metrics,
      async embed(texts) {
        assert.ok(!busy, 'Benchmark indexing and query inference must not overlap');
        busy = true;
        try { return await embed(texts); } finally { busy = false; }
      }, close, sample };
  } catch (error) {
    await close();
    throw error;
  }
}
