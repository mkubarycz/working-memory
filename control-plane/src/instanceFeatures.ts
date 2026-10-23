import type { DatabaseSync } from 'node:sqlite';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { z } from 'zod';
import { IdentityError } from './instanceIdentity.js';

export interface InstanceFeatures {
  hostTasks: boolean;
}

export class InstanceFeatureStore {
  constructor(private readonly db: DatabaseSync) {
    db.exec(`CREATE TABLE IF NOT EXISTS instance_features (
      feature TEXT PRIMARY KEY, enabled INTEGER NOT NULL CHECK (enabled IN (0, 1))
    )`);
  }

  read(): InstanceFeatures {
    return { hostTasks: this.db.prepare('SELECT enabled FROM instance_features WHERE feature=?').get('hostTasks')?.enabled === 1 };
  }

  write(input: unknown): InstanceFeatures {
    const flags = z.object({ hostTasks: z.boolean() }).strict().parse(input);
    this.db.prepare(`INSERT INTO instance_features(feature,enabled) VALUES(?,?)
      ON CONFLICT(feature) DO UPDATE SET enabled=excluded.enabled`).run('hostTasks', Number(flags.hostTasks));
    return this.read();
  }

  async handle(req: IncomingMessage, res: ServerResponse, url: URL, authorize: () => void): Promise<void> {
    const send = (status: number, value: unknown) => {
      res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' });
      res.end(JSON.stringify(value));
    };
    try {
      if (req.headers.origin || url.search) throw new IdentityError(400, 'Origins and query parameters are not allowed.');
      if (req.method === 'GET') { send(200, this.read()); return; }
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
      send(200, this.write(input));
    } catch (error) {
      if (error instanceof IdentityError) send(error.status, { error: error.message });
      else if (error instanceof z.ZodError) send(400, { error: 'invalid_feature_settings' });
      else throw error;
    }
  }
}
