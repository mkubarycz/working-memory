import type { ControlPlaneClient } from '../../../shared/controlPlaneClient';
import { embeddingDashboardSchema, relatedTopicsSchema, type RelatedTopics } from '../../../control-plane/src/embeddingContract';
import type { EmbeddingAction, EmbeddingDashboard } from '../shared/embeddings';
import type { EmbeddingServiceManager } from './embeddingServiceManager';

type Target = { endpoint: string; client: Pick<ControlPlaneClient, 'callTool'> };
export class LocalEmbeddings {
  constructor(private current: () => Target | null, private service: Pick<EmbeddingServiceManager, 'ensure' | 'readSettings' | 'setRetention'>) {}
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
    return { ...embeddingDashboardSchema.parse(await this.call(target, 'wm-embeddings-dashboard', {})),
      ...this.service.readSettings(), endpoint: target.endpoint };
  }
  async setRetention(minutes: number | null): Promise<EmbeddingDashboard> {
    await this.service.setRetention(minutes);
    return this.snapshot();
  }
  async action(action: EmbeddingAction): Promise<EmbeddingDashboard> {
    const target = this.target();
    let host;
    if (['enable', 'resume', 'retry'].includes(action)) {
      const url = new URL(target.endpoint);
      if (!['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)) {
        throw new Error('Bundled host inference supports local Docker environments only. Select a local environment.');
      }
      host = await this.service.ensure();
      if (this.current()?.endpoint !== target.endpoint) throw new Error('Selected environment changed before enabling indexing.');
    }
    return { ...embeddingDashboardSchema.parse(await this.call(target, 'wm-embeddings-configure', {
      action, ...(host ? { host } : {}),
    })), ...this.service.readSettings(), endpoint: target.endpoint };
  }
  async related(id: string): Promise<RelatedTopics> {
    return relatedTopicsSchema.parse(await this.call(this.target(), 'wm-related-topics', { id }));
  }
}
