import type { DatabaseSync } from 'node:sqlite';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { z } from 'zod';
import { IdentityError } from './instanceIdentity.js';

export interface InstanceFeatures {
  hostTasks: boolean;
  search: boolean;
  observability?: boolean;
}

const legacyFeatureUpdateSchema = z.object({ hostTasks: z.boolean().optional(), search: z.boolean().optional() })
  .strict().refine(flags => flags.hostTasks !== undefined || flags.search !== undefined);
export const instanceFeatureUpdateSchema = z.object({
  hostTasks: z.boolean().optional(), search: z.boolean().optional(), observability: z.boolean().optional(),
}).strict().refine(flags => Object.values(flags).some(value => value !== undefined));
export const instanceFeaturesSchema = z.object({ hostTasks: z.boolean(), search: z.boolean().default(false) }).strict();
export const instanceFeaturesV3Schema = instanceFeaturesSchema.extend({ observability: z.boolean().default(false) });
export type InstanceFeatureUpdate = z.infer<typeof instanceFeatureUpdateSchema>;

export class InstanceFeatureStore {
  private cachedObservability = false;
  get observabilityEnabled(): boolean { return this.cachedObservability; }

  constructor(private readonly db: DatabaseSync) {
    db.exec(`CREATE TABLE IF NOT EXISTS instance_features (
      feature TEXT PRIMARY KEY, enabled INTEGER NOT NULL CHECK (enabled IN (0, 1))
    )`);
    this.cachedObservability = this.db.prepare('SELECT enabled FROM instance_features WHERE feature=?').get('observability')?.enabled === 1;
  }

  read(): InstanceFeatures {
    const enabled = (feature: string) => this.db.prepare('SELECT enabled FROM instance_features WHERE feature=?').get(feature)?.enabled === 1;
    this.cachedObservability = enabled('observability');
    return { hostTasks: enabled('hostTasks'), search: enabled('search'),
      ...(this.cachedObservability ? { observability: true } : {}) };
  }

  write(input: unknown): InstanceFeatures {
    const flags = instanceFeatureUpdateSchema.parse(input);
    const current = this.read();
    this.db.prepare(`INSERT INTO instance_features(feature,enabled) VALUES('hostTasks',?),('search',?),('observability',?)
      ON CONFLICT(feature) DO UPDATE SET enabled=excluded.enabled`)
      .run(Number(flags.hostTasks ?? current.hostTasks), Number(flags.search ?? current.search),
        Number(flags.observability ?? current.observability ?? false));
    return this.read();
  }

  async handle(req: IncomingMessage, res: ServerResponse, url: URL, authorize: () => void,
    beforeWrite?: (flags: InstanceFeatureUpdate) => void): Promise<void> {
    const send = (status: number, value: unknown) => {
      res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' });
      res.end(JSON.stringify(value));
    };
    const response = (flags: InstanceFeatures) => url.pathname === '/features/v1'
      ? { hostTasks: flags.hostTasks } : url.pathname === '/features/v2'
        ? { hostTasks: flags.hostTasks, search: flags.search }
        : { ...flags, observability: flags.observability ?? false };
    try {
      if (req.headers.origin || url.search) throw new IdentityError(400, 'Origins and query parameters are not allowed.');
      if (req.method === 'GET') { authorize(); send(200, response(this.read())); return; }
      if (req.method !== 'POST') { send(405, { error: 'method_not_allowed' }); return; }
      authorize();
      if (req.headers['content-type']?.split(';')[0].trim() !== 'application/json') {
        throw new IdentityError(415, 'JSON is required.');
      }
      const chunks: Buffer[] = [];
      let size = 0;
      for await (const chunk of req) {
        const buffer = Buffer.from(chunk);
        size += buffer.length;
        if (size > 1024) throw new IdentityError(413, 'Feature settings request is too large.');
        chunks.push(buffer);
      }
      let input: unknown;
      try { input = JSON.parse(Buffer.concat(chunks).toString('utf8')); }
      catch { throw new IdentityError(400, 'Invalid JSON.'); }
      authorize();
      if (url.pathname === '/features/v1') input = z.object({ hostTasks: z.boolean() }).strict().parse(input);
      else if (url.pathname === '/features/v2') input = legacyFeatureUpdateSchema.parse(input);
      const flags = instanceFeatureUpdateSchema.parse(input);
      beforeWrite?.(flags);
      send(200, response(this.write(flags)));
    } catch (error) {
      if (error instanceof IdentityError) send(error.status, { error: error.message });
      else if (error instanceof z.ZodError) send(400, { error: 'invalid_feature_settings' });
      else throw error;
    }
  }
}
