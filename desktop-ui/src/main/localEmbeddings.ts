import type { ControlPlaneClient } from '../../../shared/controlPlaneClient';
import { embeddingDashboardSchema, relatedTopicsSchema, isPrivateEmbeddingAddress, embeddingErrorMessage, type RelatedTopics } from '../../../control-plane/src/embeddingContract';
import type { EmbeddingAction, EmbeddingDashboard } from '../shared/embeddings';
import type { EmbeddingServiceManager } from './embeddingServiceManager';

type Target = { endpoint: string; client: Pick<ControlPlaneClient, 'callTool'> };
const isLocalEndpoint = (endpoint: string) => ['127.0.0.1', 'localhost', '[::1]'].includes(new URL(endpoint).hostname);
export class LocalEmbeddings {
  private generation = 0;
  constructor(private current: () => Target | null, private service: Pick<EmbeddingServiceManager, 'ensure' | 'restore' | 'readSettings' | 'setRetention' | 'usesWslNetworking'>) {}
  async restore(ready: Promise<void>): Promise<void> {
    await ready;
    await this.service.restore();
    if (this.service.usesWslNetworking() && this.current()) await this.snapshot();
  }
  private target(): Target {
    const target = this.current();
    if (!target) throw new Error('Select a Working Memory environment first.');
    return target;
  }
  private async call(target: Target, name: string, args: Record<string, unknown>): Promise<unknown> {
    const outcome = await target.client.callTool(name, args);
    if (!outcome.ok) throw new Error(outcome.error || 'Embedding request failed.');
    if (this.current()?.endpoint !== target.endpoint) throw new Error('Selected environment changed.');
    return outcome.result;
  }
  async snapshot(): Promise<EmbeddingDashboard> {
    const target = this.target();
    const generation = this.generation;
    const conditionalRepair = isLocalEndpoint(target.endpoint) && this.service.usesWslNetworking();
    let dashboard = embeddingDashboardSchema.parse(await this.call(target, 'wm-embeddings-dashboard',
      conditionalRepair ? { withConfiguration: true } : {}));
    if (dashboard.enabled && !dashboard.paused && dashboard.phase === 'error' && conditionalRepair
      && dashboard.error?.startsWith('Host inference service unavailable:')) {
      try {
        if (!dashboard.configurationKey) throw new Error('Update the selected backend to support conditional WSL route repair.');
        const host = await this.service.ensure();
        if (this.current()?.endpoint !== target.endpoint) throw new Error('Selected environment changed during WSL endpoint discovery.');
        const bound = dashboard.endpoint && isPrivateEmbeddingAddress(new URL(dashboard.endpoint).hostname)
          ? (host.candidates ?? [host.endpoint]).includes(dashboard.endpoint) : host.endpoint === dashboard.endpoint;
        if (generation === this.generation && !bound) {
          dashboard = embeddingDashboardSchema.parse(await this.call(target, 'wm-embeddings-configure', {
            action: 'retry', host, expectedConfiguration: dashboard.configurationKey,
          }));
        }
      } catch (error) {
        if (this.current()?.endpoint !== target.endpoint) throw new Error('Selected environment changed during WSL route repair.');
        const message = embeddingErrorMessage(error);
        console.error('[embeddings] Automatic WSL route repair failed:', message);
        dashboard = { ...dashboard, error: `Automatic WSL route repair failed: ${message}` };
      }
    }
    return { ...dashboard, ...this.service.readSettings(), endpoint: target.endpoint };
  }
  async setRetention(minutes: number | null): Promise<EmbeddingDashboard> {
    await this.service.setRetention(minutes);
    return this.snapshot();
  }
  async action(action: EmbeddingAction): Promise<EmbeddingDashboard> {
    const generation = ++this.generation;
    const target = this.target();
    let host;
    if (['enable', 'resume', 'retry'].includes(action)) {
      if (!isLocalEndpoint(target.endpoint)) {
        throw new Error('Bundled host inference supports local container environments only. Select a local environment.');
      }
      host = await this.service.ensure();
      if (this.current()?.endpoint !== target.endpoint) throw new Error('Selected environment changed before enabling indexing.');
      if (generation !== this.generation) throw new Error('Embedding action superseded by a newer action.');
    }
    return { ...embeddingDashboardSchema.parse(await this.call(target, 'wm-embeddings-configure', {
      action, ...(host ? { host } : {}),
    })), ...this.service.readSettings(), endpoint: target.endpoint };
  }
  async related(id: string): Promise<RelatedTopics> {
    return relatedTopicsSchema.parse(await this.call(this.target(), 'wm-related-topics', { id }));
  }
}
