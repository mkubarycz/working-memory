import type { DatabaseSync } from 'node:sqlite';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { z } from 'zod';
import { IdentityError } from './instanceIdentity.js';

export interface InstanceFeatures {
  hostTasks: boolean;
  search: boolean;
}

export const instanceFeatureUpdateSchema = z.object({ hostTasks: z.boolean().optional(), search: z.boolean().optional() })
  .strict().refine(flags => flags.hostTasks !== undefined || flags.search !== undefined);
export const instanceFeaturesSchema = z.object({ hostTasks: z.boolean(), search: z.boolean().default(false) }).strict();
export type InstanceFeatureUpdate = z.infer<typeof instanceFeatureUpdateSchema>;

export class InstanceFeatureStore {
  constructor(private readonly db: DatabaseSync) {
    db.exec(`CREATE TABLE IF NOT EXISTS instance_features (
      feature TEXT PRIMARY KEY, enabled INTEGER NOT NULL CHECK (enabled IN (0, 1))
    )`);
  }

  read(): InstanceFeatures {
    const enabled = (feature: string) => this.db.prepare('SELECT enabled FROM instance_features WHERE feature=?').get(feature)?.enabled === 1;
    return { hostTasks: enabled('hostTasks'), search: enabled('search') };
  }

  write(input: unknown): InstanceFeatures {
    const flags = instanceFeatureUpdateSchema.parse(input);
    const current = this.read();
    this.db.prepare(`INSERT INTO instance_features(feature,enabled) VALUES('hostTasks',?),('search',?)
      ON CONFLICT(feature) DO UPDATE SET enabled=excluded.enabled`)
      .run(Number(flags.hostTasks ?? current.hostTasks), Number(flags.search ?? current.search));
    return this.read();
  }

  async handle(req: IncomingMessage, res: ServerResponse, url: URL, authorize: () => void): Promise<void> {
    const send = (status: number, value: unknown) => {
      res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' });
      res.end(JSON.stringify(value));
    };
    const response = (flags: InstanceFeatures) => url.pathname === '/features/v1'
      ? { hostTasks: flags.hostTasks } : flags;
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
      send(200, response(this.write(input)));
    } catch (error) {
      if (error instanceof IdentityError) send(error.status, { error: error.message });
      else if (error instanceof z.ZodError) send(400, { error: 'invalid_feature_settings' });
      else throw error;
    }
  }
}
