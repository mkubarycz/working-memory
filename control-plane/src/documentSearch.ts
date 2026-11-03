import type { DatabaseSync } from 'node:sqlite';
import { z } from 'zod';
import { getKind, listKinds } from './kinds/registry.js';

export const QUERY_KINDS = ['Topic', 'Workstream', 'AgentMessage', 'CommandJournal', 'ContainerClaim', 'TopicType', 'Agent'] as const;
export const documentQuerySchema = z.object({
  id: z.string().min(1).optional(),
  kind: z.enum(QUERY_KINDS).optional(),
  query: z.string().trim().min(1).max(500).optional(),
  workstream: z.string().min(1).optional(),
  parent: z.string().min(1).optional(),
  topicType: z.string().min(1).optional(),
  status: z.string().min(1).max(40).optional(),
  updatedAfter: z.number().nonnegative().optional().describe('Epoch seconds, not milliseconds.'),
  updatedBefore: z.number().nonnegative().optional(),
  order: z.enum(['updated', 'title']).default('updated'),
  limit: z.number().int().min(1).max(20).default(10),
  offset: z.number().int().nonnegative().default(0),
  expectedVersion: z.number().int().nonnegative().optional(),
  bodyOffset: z.number().int().nonnegative().default(0).describe('Offset in Unicode code points.'),
  bodyLimit: z.number().int().min(1).max(12000).default(2000).describe('Maximum Unicode code points returned.'),
}).strict().refine(input => !(input.workstream || input.parent || input.topicType) || !input.kind || input.kind === 'Topic',
  'Workstream and parent filters apply only to Topics.');

export interface QueryDocument {
  id: string;
  kind: string;
  title: string;
  body: string;
  bodyLength: number;
  bodyOffset: number;
  nextBodyOffset: number | null;
  status: string | null;
  workstreams: string[];
  parents: string[];
  createdAt: number;
  updatedAt: number;
  resourceVersion: number;
}

export function queryDocuments(
  db: DatabaseSync,
  input: z.input<typeof documentQuerySchema>,
  canReadKind: (kind: string) => boolean,
): { count: number; total: number; nextOffset: number | null; version: number; documents: QueryDocument[] } {
  const options = documentQuerySchema.parse(input);
  if (listKinds().length && Number(db.prepare("SELECT value FROM store_meta WHERE key = 'document_search_version'").get()?.value ?? 0) < 2) {
    ensureDocumentSearch(db);
  }
  const version = Number(db.prepare("SELECT value FROM store_meta WHERE key = 'resource_version'").get()?.value);
  if (options.expectedVersion !== undefined && options.expectedVersion !== version) {
    throw new Error('Documents changed while paging. Restart the query from offset 0.');
  }
  const kinds = QUERY_KINDS.filter(kind => canReadKind(kind)
    && (!options.kind || kind === options.kind)
    && (!(options.workstream || options.parent || options.topicType) || kind === 'Topic'));
  if (!kinds.length) return { count: 0, total: 0, nextOffset: null, version, documents: [] };
  const where = ['deleted_at IS NULL', `kind IN (${kinds.map(() => '?').join(',')})`];
  const args: Array<string | number> = [...kinds];
  const filter = (sql: string, value: string | number | undefined) => {
    if (value !== undefined) { where.push(sql); args.push(value); }
  };
  filter('id = ?', options.id);
  filter("EXISTS (SELECT 1 FROM json_each(resources.spec, '$.workstreams') WHERE value = ?)", options.workstream);
  filter("EXISTS (SELECT 1 FROM json_each(resources.spec, '$.parents') WHERE value = ?)", options.parent);
  filter("json_extract(spec, '$.topicType') = ?", options.topicType);
  filter("json_extract(spec, '$.status') = ?", options.status);
  filter('updated_at >= ?', options.updatedAfter);
  filter('updated_at <= ?', options.updatedBefore);
  filter("EXISTS (SELECT 1 FROM document_search AS indexed WHERE indexed.rowid = resources.rowid AND instr(lower(indexed.body || '\n' || indexed.title), lower(?)) > 0)", options.query);
  const predicate = where.join(' AND ');
  const total = Number(db.prepare(`SELECT count(*) AS total FROM resources WHERE ${predicate}`).get(...args)?.total);
  const rows = db.prepare(`SELECT id, kind, title,
      substr(evidence, ?, ?) AS body, length(evidence) AS body_length,
      lifecycle, workstreams, parents, created_at, updated_at, resource_version
    FROM (SELECT id, kind,
      CAST(COALESCE(json_extract(spec, '$.title'), json_extract(spec, '$.name'), json_extract(spec, '$.label'), id) AS TEXT) AS title,
      CASE WHEN kind = 'AgentMessage' THEN json_object(
        'category', json_extract(spec, '$.category'), 'severity', json_extract(spec, '$.severity'),
        'attention', json(COALESCE(spec -> '$.attention', 'null')), 'due_at', json_extract(spec, '$.due_at'),
        'recommended_action', json_extract(spec, '$.recommended_action'), 'decision', json_extract(spec, '$.decision'),
        'topics', json_extract(spec, '$.topics'), 'relations', json_extract(spec, '$.relations'),
        'agent_id', json_extract(spec, '$.agent_id'), 'agent_name', json_extract(spec, '$.agent_name')
      ) || char(10) ELSE '' END ||
      COALESCE((SELECT indexed.body FROM document_search AS indexed WHERE indexed.rowid = resources.rowid), '') AS evidence,
      json_extract(spec, '$.status') AS lifecycle,
      COALESCE(json_extract(spec, '$.workstreams'), '[]') AS workstreams,
      COALESCE(json_extract(spec, '$.parents'), '[]') AS parents,
      created_at, updated_at, resource_version
    FROM resources WHERE ${predicate})
    ORDER BY ${options.order === 'title' ? 'title COLLATE NOCASE, id' : 'updated_at DESC, id'}
    LIMIT ? OFFSET ?`).all(options.bodyOffset + 1, options.bodyLimit, ...args, options.limit, options.offset);
  const documents = rows.map(row => {
    const body = String(row.body);
    const next = options.bodyOffset + options.bodyLimit;
    return {
      id: String(row.id), kind: String(row.kind), title: String(row.title),
      body, bodyLength: Number(row.body_length), bodyOffset: options.bodyOffset,
      nextBodyOffset: next < Number(row.body_length) ? next : null,
      status: typeof row.lifecycle === 'string' ? row.lifecycle : null,
      workstreams: JSON.parse(String(row.workstreams)) as string[],
      parents: JSON.parse(String(row.parents)) as string[],
      createdAt: Number(row.created_at), updatedAt: Number(row.updated_at),
      resourceVersion: Number(row.resource_version),
    };
  });
  return { count: documents.length, total, version,
    nextOffset: options.offset + documents.length < total ? options.offset + documents.length : null, documents };
}

export const documentSearchSchema = z.object({
  queries: z.array(z.string().trim().min(1).max(500)).min(1).max(8)
    .describe('Short search phrases. An agent should expand intent into related terms/synonyms; results match any phrase.'),
  kinds: z.array(z.string().min(1).max(100)).min(1).max(30).optional(),
  limit: z.number().int().min(1).max(100).default(30),
}).strict();

// Mirrored in shared/documentSearch.ts: the control plane has its own build root.
export interface DocumentSearchHit {
  id: string;
  kind: string;
  title: string;
  excerpt: string;
  score: number;
}

type DocumentSearchInput = z.input<typeof documentSearchSchema>;
type DocumentSearchResult = { count: number; results: DocumentSearchHit[] };

export function registerDocumentSearchFunctions(db: DatabaseSync): void {
  db.function('wm_search_text', { deterministic: true }, (kind, id, rawSpec) => {
    const name = String(kind);
    const spec = JSON.parse(String(rawSpec)) as Record<string, unknown>;
    const projection = getKind(name)?.descriptor.fts;
    if (projection) return projection({ kind: name, metadata: { id }, spec, status: {} });
    // Unknown kinds expose prose fields only; never index arbitrary config values.
    return ['body', 'description', 'closure'].map(key => typeof spec[key] === 'string' ? spec[key] : '').join('\n');
  });
}

export function ensureDocumentSearch(db: DatabaseSync): void {
  db.exec('BEGIN IMMEDIATE');
  try {
    const installed = db.prepare("SELECT name FROM sqlite_master WHERE name = 'document_search'").get();
    db.exec(`
      CREATE VIRTUAL TABLE IF NOT EXISTS document_search USING fts5(
        id UNINDEXED, kind UNINDEXED, title, body,
        tokenize = 'porter unicode61 remove_diacritics 2'
      );
      CREATE TRIGGER IF NOT EXISTS document_search_insert AFTER INSERT ON resources
      WHEN NEW.deleted_at IS NULL BEGIN
        INSERT INTO document_search(rowid, id, kind, title, body) VALUES (
          NEW.rowid, NEW.id, NEW.kind,
          CAST(COALESCE(json_extract(NEW.spec, '$.title'), json_extract(NEW.spec, '$.name'), json_extract(NEW.spec, '$.label'), NEW.id) AS TEXT),
          wm_search_text(NEW.kind, NEW.id, NEW.spec)
        );
      END;
      CREATE TRIGGER IF NOT EXISTS document_search_update AFTER UPDATE ON resources BEGIN
        DELETE FROM document_search WHERE rowid = OLD.rowid;
        INSERT INTO document_search(rowid, id, kind, title, body)
          SELECT NEW.rowid, NEW.id, NEW.kind,
            CAST(COALESCE(json_extract(NEW.spec, '$.title'), json_extract(NEW.spec, '$.name'), json_extract(NEW.spec, '$.label'), NEW.id) AS TEXT),
            wm_search_text(NEW.kind, NEW.id, NEW.spec)
          WHERE NEW.deleted_at IS NULL;
      END;
      CREATE TRIGGER IF NOT EXISTS document_search_delete AFTER DELETE ON resources BEGIN
        DELETE FROM document_search WHERE rowid = OLD.rowid;
      END;
    `);
    const version = Number(db.prepare("SELECT value FROM store_meta WHERE key = 'document_search_version'").get()?.value ?? 0);
    const registered = listKinds().length > 0;
    if (!installed || registered && version < 2) {
      db.exec('DELETE FROM document_search');
      db.exec(`INSERT INTO document_search(rowid, id, kind, title, body)
        SELECT rowid, id, kind, CAST(COALESCE(json_extract(spec, '$.title'), json_extract(spec, '$.name'),
          json_extract(spec, '$.label'), id) AS TEXT), wm_search_text(kind, id, spec)
        FROM resources WHERE deleted_at IS NULL`);
      if (registered) {
        db.prepare("INSERT INTO store_meta(key, value) VALUES ('document_search_version', 2) ON CONFLICT(key) DO UPDATE SET value = 2").run();
      }
    }
    db.exec('COMMIT');
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}

export function searchDocuments(
  db: DatabaseSync,
  input: DocumentSearchInput,
  canReadKind: (kind: string) => boolean = () => true,
): DocumentSearchResult {
  if (listKinds().length && Number(db.prepare("SELECT value FROM store_meta WHERE key = 'document_search_version'").get()?.value ?? 0) < 2) {
    ensureDocumentSearch(db);
  }
  const { queries, kinds, limit } = documentSearchSchema.parse(input);
  const phrases = queries.map(query => {
    const tokens = query.match(/[\p{L}\p{N}]+/gu)?.slice(0, 40) ?? [];
    return tokens.length ? `(${tokens.map(token => `"${token}"`).join(' AND ')})` : '';
  }).filter(Boolean);
  if (!phrases.length) throw new Error('Enter at least one word or number to search.');
  const allowedKinds = (db.prepare('SELECT DISTINCT kind FROM resources').all() as Array<{ kind: string }>)
    .map(row => row.kind).filter(kind => canReadKind(kind) && (!kinds || kinds.includes(kind)));
  if (!allowedKinds.length) return { count: 0, results: [] };
  const results = db.prepare(`SELECT id, kind, title,
      snippet(document_search, 3, '', '', ' ... ', 48) AS excerpt,
      -bm25(document_search, 0, 0, 6, 1) AS score
    FROM document_search WHERE document_search MATCH ?
      AND kind IN (${allowedKinds.map(() => '?').join(',')})
    ORDER BY bm25(document_search, 0, 0, 6, 1), id LIMIT ?`)
    .all(phrases.join(' OR '), ...allowedKinds, limit) as unknown as DocumentSearchHit[];
  return { count: results.length, results };
}
