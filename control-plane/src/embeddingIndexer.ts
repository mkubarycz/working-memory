import type { DatabaseSync } from 'node:sqlite';
import { createHash } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import {
  EMBEDDING_MODEL, EMBEDDING_DOWNLOAD_BYTES, embeddingConfigureSchema,
  embeddingHostSchema, embeddingHostStatusSchema, embeddingInferenceSchema,
  embeddingErrorMessage,
  semanticSearchSchema, EMBEDDING_KINDS, SEMANTIC_SEARCH_INFERENCE_TIMEOUT_MS,
  type EmbeddingDashboard,
} from './embeddingContract.js';
import { embeddingStats, nextEmbeddingWork, semanticSearch, submitEmbeddings } from './topicEmbeddings.js';

async function hostFailure(response: Response): Promise<string> {
  let detail: string;
  try {
    if (!response.body) throw new Error('Empty error response.');
    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let size = 0;
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.length;
        if (size > 8192) {
          await reader.cancel();
          throw new Error('Host error response exceeds the diagnostic limit.');
        }
        chunks.push(value);
      }
    } finally { reader.releaseLock(); }
    const value: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    if (!value || typeof value !== 'object' || !('error' in value)
      || typeof value.error !== 'string' || !value.error.trim()) throw new Error('No diagnostic error message was returned.');
    detail = embeddingErrorMessage(value.error);
  } catch (error) { detail = `Error details unavailable: ${embeddingErrorMessage(error)}`; }
  return `Host inference failed (HTTP ${response.status}): ${detail} Open Diagnostics > Embeddings and Retry.`;
}

export class EmbeddingIndexer {
  private configurationGeneration = 0;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private controller: AbortController | undefined;
  private running: Promise<void> | undefined;
  private stopped = true;
  private halted = false;
  private state: EmbeddingDashboard = {
    endpoint: null, enabled: false, paused: false, phase: 'disabled', model: EMBEDDING_MODEL,
    downloadBytes: 0, downloadTotal: EMBEDDING_DOWNLOAD_BYTES, backend: null, warning: null,
    error: null, rssBytes: null, lastInferenceMs: null, lastSuccessAtMs: null, stats: null,
  };
  constructor(private db: DatabaseSync, private searchEnabled: () => boolean) {
    db.exec(`CREATE TABLE IF NOT EXISTS instance_embedding_settings (
      singleton INTEGER PRIMARY KEY CHECK(singleton = 1), enabled INTEGER NOT NULL,
      paused INTEGER NOT NULL, host TEXT
    ) STRICT`);
  }
  private settings() {
    const row = this.db.prepare('SELECT enabled, paused, host FROM instance_embedding_settings WHERE singleton = 1').get();
    return { enabled: row?.enabled === 1, paused: row?.paused === 1,
      host: row?.host ? embeddingHostSchema.parse(JSON.parse(String(row.host))) : null };
  }
  private configurationKey(settings: ReturnType<EmbeddingIndexer['settings']>): string {
    return createHash('sha256').update(JSON.stringify({ generation: this.configurationGeneration, ...settings })).digest('hex');
  }
  isEnabled(): boolean {
    return this.settings().enabled;
  }
  readiness(canReadKind: (kind: string) => boolean = () => true) {
    const enabled = this.isEnabled();
    const stats = embeddingStats(this.db, canReadKind);
    return { enabled, ready: enabled && this.searchEnabled() && stats.pending === 0, stats };
  }
  private requireReady(canReadKind: (kind: string) => boolean) {
    if (!this.searchEnabled()) throw new Error('Search is turned off.');
    if (!EMBEDDING_KINDS.some(canReadKind)) throw new Error('Document read permission is unavailable or access was revoked.');
    const status = this.readiness(canReadKind);
    if (!status.enabled) throw new Error('Enable Embeddings in Settings > Features before searching.');
    if (!status.ready) throw new Error(`Indexing must finish before searching (${status.stats.pending} documents pending). Check Settings > Diagnostics > Embeddings.`);
    return status;
  }
  async search(raw: unknown, canReadKind: (kind: string) => boolean, signal?: AbortSignal) {
    const input = semanticSearchSchema.parse(raw);
    if (this.requireReady(canReadKind).stats.total === 0) return { count: 0, results: [], limited: false };
    const { host } = this.settings();
    if (!host) throw new Error('Host inference service is not configured. Open Embeddings diagnostics and Retry.');
    const deadline = AbortSignal.timeout(SEMANTIC_SEARCH_INFERENCE_TIMEOUT_MS);
    const requestSignal = AbortSignal.any([...(signal ? [signal] : []), deadline]);
    const request = () => fetch(`${host.endpoint}/embed`, {
      method: 'POST', redirect: 'error',
      headers: { Authorization: `Bearer ${host.token}`, 'Content-Type': 'application/json', 'X-WM-Embedding-Metrics': '1' },
      body: JSON.stringify({ model: EMBEDDING_MODEL, texts: input.queries }),
      signal: requestSignal,
    });
    let inference: ReturnType<typeof embeddingInferenceSchema.parse>;
    const hostStarted = performance.now();
    try {
      let response = await request();
      let backoffMs = 500;
      while (response.status === 409) {
        await response.body?.cancel();
        await delay(backoffMs, undefined, { signal: requestSignal });
        backoffMs = Math.min(backoffMs * 2, 2000);
        this.requireReady(canReadKind);
        response = await request();
      }
      if (!response.ok) throw new Error(`Search inference failed (HTTP ${response.status}). Check Embeddings diagnostics and retry.`);
      inference = embeddingInferenceSchema.parse(await response.json());
    } catch (error) {
      signal?.throwIfAborted();
      if (deadline.aborted) {
        throw new Error('Search timed out while starting the local embedding model or computing the query (60 seconds). Check Settings > Diagnostics > Embeddings and retry.');
      }
      throw error;
    }
    if (inference.vectors.length !== input.queries.length) throw new Error('Host inference returned the wrong number of search vectors.');
    const hostMs = performance.now() - hostStarted;
    this.requireReady(canReadKind);
    const ranking = performance.now();
    const result = semanticSearch(this.db, input, inference.vectors, canReadKind);
    return { ...result, timings: { ...(inference.startupMs === undefined ? {} : { startupMs: inference.startupMs }),
      inferenceMs: inference.durationMs, hostMs, rankingMs: performance.now() - ranking } };
  }
  start(): void {
    if (!this.stopped) return;
    this.stopped = false;
    this.schedule(0);
  }
  private schedule(delay: number): void {
    if (this.stopped) return;
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      this.timer = undefined;
      if (this.running) return;
      this.running = this.tick().finally(() => {
        this.running = undefined;
        this.schedule(this.state.stats?.pending && !this.state.error ? 250 : 5000);
      });
    }, delay);
    this.timer.unref();
  }
  async configure(raw: unknown): Promise<EmbeddingDashboard> {
    const input = embeddingConfigureSchema.parse(raw);
    const conditional = input.expectedConfiguration !== undefined;
    const previous = this.settings();
    if (conditional && (!previous.enabled || previous.paused || !this.searchEnabled()
      || input.expectedConfiguration !== this.configurationKey(previous))) return this.snapshot(true);
    if (['enable', 'resume', 'retry'].includes(input.action) && !this.searchEnabled()) {
      throw new Error('Enable Search in Settings > Features before indexing.');
    }
    const generation = ++this.configurationGeneration;
    const expectedHost = conditional
      ? this.db.prepare('SELECT host FROM instance_embedding_settings WHERE singleton=1').get()?.host : undefined;
    let host = input.host ?? previous.host;
    const enabled = input.action === 'disable' ? false : input.action === 'pause' ? previous.enabled : true;
    if (enabled && !host) throw new Error('Install the bundled host inference service from the Embeddings dashboard first.');
    if (input.host && ['enable', 'resume', 'retry'].includes(input.action)) {
      const failures: string[] = [];
      let selected = false;
      for (const endpoint of [...new Set([input.host.endpoint, ...(input.host.candidates ?? [])])]) {
        try {
          const response = await fetch(`${endpoint}/status`, {
            headers: { Authorization: `Bearer ${input.host.token}` }, redirect: 'error', signal: AbortSignal.timeout(2000),
          });
          if (!response.ok) throw new Error(`HTTP ${response.status}`);
          embeddingHostStatusSchema.parse(await response.json());
          host = { ...input.host, endpoint };
          selected = true;
          break;
        } catch (error) { failures.push(`${endpoint}: ${embeddingErrorMessage(error)}`); }
      }
      if (!selected) {
        if (conditional && (generation !== this.configurationGeneration || !this.searchEnabled()
          || JSON.stringify(previous) !== JSON.stringify(this.settings()))) return this.snapshot(true);
        throw new Error(`The container cannot reach the configured inference endpoint: ${failures.join('; ')}. Windows/Podman requires the private WSL listener and firewall access on that interface. Existing indexing settings were not changed.`);
      }
    }
    if (generation !== this.configurationGeneration) {
      if (conditional) return this.snapshot(true);
      throw new Error('Embedding configuration superseded by a newer action.');
    }
    if (['enable', 'resume', 'retry'].includes(input.action) && !this.searchEnabled()) {
      if (conditional) return this.snapshot(true);
      throw new Error('Enable Search in Settings > Features before indexing.');
    }
    if (conditional) {
      const result = this.db.prepare(`UPDATE instance_embedding_settings SET host=?
        WHERE singleton=1 AND enabled=1 AND paused=0 AND host=?`).run(JSON.stringify(host), expectedHost ?? null);
      if (Number(result.changes) === 0) return this.snapshot(true);
    } else {
      this.db.prepare(`INSERT INTO instance_embedding_settings VALUES(1, ?, ?, ?)
        ON CONFLICT(singleton) DO UPDATE SET enabled=excluded.enabled, paused=excluded.paused, host=excluded.host`)
        .run(enabled ? 1 : 0, input.action === 'pause' ? 1 : 0, host ? JSON.stringify(host) : null);
    }
    this.controller?.abort();
    this.halted = false;
    this.state.error = null;
    this.schedule(0);
    return this.snapshot(conditional);
  }
  async snapshot(withConfiguration = false): Promise<EmbeddingDashboard> {
    const settings = this.settings();
    const state = { ...this.state, enabled: settings.enabled, paused: settings.paused,
      ...(withConfiguration ? { configurationKey: this.configurationKey(settings) } : {}),
      endpoint: settings.host?.endpoint ?? null, stats: embeddingStats(this.db) };
    if (!settings.enabled) state.phase = 'disabled';
    else if (settings.paused) state.phase = 'paused';
    if (settings.enabled && settings.host) {
      try {
        const response = await fetch(`${settings.host.endpoint}/status`, {
          headers: { Authorization: `Bearer ${settings.host.token}` },
          signal: AbortSignal.timeout(2000), redirect: 'error',
        });
        if (!response.ok) throw new Error(`Host inference service returned HTTP ${response.status}.`);
        const status = embeddingHostStatusSchema.parse(await response.json());
        state.backend = status.backend;
        state.warning = status.warning;
        state.rssBytes = status.rssBytes;
        state.downloadBytes = status.downloadBytes;
        if (!settings.paused) {
          if (status.phase === 'error' || status.error) {
            state.phase = 'error';
            state.error = embeddingErrorMessage(status.error || 'Host service reports an error without details. Check the service error log and Retry.');
          } else if (!state.error) {
            state.phase = !this.searchEnabled() ? 'paused' : status.phase;
          }
        }
      } catch (error) {
        state.backend = null;
        state.rssBytes = null;
        state.error = `Host inference service unavailable: ${embeddingErrorMessage(error)} Open Diagnostics > Embeddings and Retry; check the background service and container connectivity.`;
        if (settings.enabled && !settings.paused) state.phase = 'error';
      }
    }
    if (settings.enabled && !this.searchEnabled()) state.phase = 'paused';
    return state;
  }
  private async tick(): Promise<void> {
    if (this.stopped || this.halted) return;
    const settings = this.settings();
    if (!settings.enabled || settings.paused || !settings.host || !this.searchEnabled()) return;
    const controller = new AbortController();
    this.controller = controller;
    try {
      const batch = nextEmbeddingWork(this.db);
      this.state.stats = batch.stats;
      if (!batch.work) { this.state.phase = 'idle'; this.state.error = null; return; }
      this.state.phase = 'indexing';
      const response = await fetch(`${settings.host.endpoint}/embed`, {
        method: 'POST', redirect: 'error',
        headers: { Authorization: `Bearer ${settings.host.token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: EMBEDDING_MODEL, texts: batch.work.passages }),
        signal: AbortSignal.any([controller.signal, AbortSignal.timeout(300000)]),
      });
      if (!response.ok) {
        this.halted = ![409, 503].includes(response.status);
        throw new Error(await hostFailure(response));
      }
      const parsed = embeddingInferenceSchema.safeParse(await response.json());
      if (!parsed.success) {
        this.halted = true;
        throw new Error('Host inference returned invalid vectors. Check the installed service version and Retry.');
      }
      const inference = parsed.data;
      controller.signal.throwIfAborted();
      if (this.stopped) return;
      const result = submitEmbeddings(this.db, { id: batch.work.id, sourceVersion: batch.work.sourceVersion,
        contentHash: batch.work.contentHash, model: EMBEDDING_MODEL, vectors: inference.vectors });
      this.state.lastInferenceMs = inference.durationMs;
      this.state.rssBytes = inference.rssBytes;
      if (result.accepted) this.state.lastSuccessAtMs = Date.now();
      this.state.error = null;
      this.state.phase = 'idle';
    } catch (error) {
      if (!controller.signal.aborted && !this.stopped) {
        const message = embeddingErrorMessage(error);
        if (this.state.error !== message) console.error('[embeddings]', message);
        this.state.error = message;
        this.state.phase = 'error';
      }
    } finally {
      if (this.controller === controller) this.controller = undefined;
    }
  }
  async stop(): Promise<void> {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    this.controller?.abort();
    await this.running;
  }
}
