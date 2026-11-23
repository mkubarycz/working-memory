import type { DatabaseSync } from 'node:sqlite';
import { z } from 'zod';
import type { MatchConfidence } from './embeddingContract.js';
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
  if (listKinds().length && Number(db.prepare("SELECT value FROM store_meta WHERE key = 'document_search_version'").get()?.value ?? 0) < 3) {
    ensureDocumentSearch(db);
  }
  refreshDocumentSearch(db);
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
  similarity?: number;
  resourceVersion?: number;
  literalMatch?: boolean;
  confidence?: MatchConfidence;
}

type DocumentSearchInput = z.input<typeof documentSearchSchema>;
type DocumentSearchResult = { count: number; results: DocumentSearchHit[] };

export function registerDocumentSearchFunctions(db: DatabaseSync): void {
  let lastPhrases = '';
  let patterns: ReturnType<typeof literalPatterns> = [];
  db.function('wm_literal_evidence', { deterministic: true }, (text, phrases, mode) => {
    const raw = String(phrases);
    if (raw !== lastPhrases) {
      patterns = literalPatterns(JSON.parse(raw) as string[]);
      lastPhrases = raw;
    }
    if (Number(mode) === 2) {
      const authored = String(text);
      let anchors: Set<string> | null = null;
      // ASCII atom/pair membership is exact; other text and phrases retain the Unicode matcher.
      if (/^[\x00-\x7F]*$/.test(authored)) {
        const atoms = [...authored.toLowerCase().matchAll(atomPattern)];
        anchors = new Set(atoms.map(atom => atom[0]));
        for (let i = 1; i < atoms.length; i++) {
          if (authored.slice(atoms[i - 1].index! + atoms[i - 1][0].length, atoms[i].index) === ' ') {
            anchors.add(`${atoms[i - 1][0]} ${atoms[i][0]}`);
          }
        }
      }
      return JSON.stringify(patterns.filter(pattern => anchors && pattern.asciiAnchor !== null
        ? anchors.has(pattern.asciiAnchor) : literalIndex(authored, pattern) >= 0).map(pattern => pattern.text));
    }
    if (Number(mode) !== 1) return patterns.some(pattern => literalIndex(String(text), pattern) >= 0) ? '1' : '';
    const evidence = literalEvidence(String(text), patterns);
    return evidence ? JSON.stringify(evidence) : '';
  });
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
      CREATE VIRTUAL TABLE IF NOT EXISTS temp.document_search_vocabulary USING fts5vocab(main, document_search, row);
      CREATE TABLE IF NOT EXISTS document_search_dirty (row_id INTEGER PRIMARY KEY);
      DROP TRIGGER IF EXISTS document_search_insert;
      DROP TRIGGER IF EXISTS document_search_update;
      DROP TRIGGER IF EXISTS document_search_delete;
      CREATE TRIGGER document_search_insert AFTER INSERT ON resources BEGIN
        INSERT OR REPLACE INTO document_search_dirty(row_id) VALUES (NEW.rowid);
      END;
      CREATE TRIGGER document_search_update AFTER UPDATE ON resources BEGIN
        INSERT OR REPLACE INTO document_search_dirty(row_id) SELECT OLD.rowid WHERE OLD.rowid <> NEW.rowid;
        INSERT OR REPLACE INTO document_search_dirty(row_id) VALUES (NEW.rowid);
      END;
      CREATE TRIGGER document_search_delete AFTER DELETE ON resources BEGIN
        INSERT OR REPLACE INTO document_search_dirty(row_id) VALUES (OLD.rowid);
      END;
      CREATE TEMP TRIGGER IF NOT EXISTS document_search_project AFTER INSERT ON main.document_search_dirty BEGIN
        DELETE FROM document_search WHERE rowid = NEW.row_id;
        INSERT INTO document_search(rowid, id, kind, title, body)
          SELECT rowid, id, kind,
            CAST(COALESCE(json_extract(spec, '$.title'), json_extract(spec, '$.name'), json_extract(spec, '$.label'), id) AS TEXT),
            wm_search_text(kind, id, spec)
          FROM resources WHERE rowid = NEW.row_id AND deleted_at IS NULL;
        DELETE FROM document_search_dirty WHERE row_id = NEW.row_id;
      END;
    `);
    const version = Number(db.prepare("SELECT value FROM store_meta WHERE key = 'document_search_version'").get()?.value ?? 0);
    const registered = listKinds().length > 0;
    if (!installed || registered && version < 3) {
      db.exec('DELETE FROM document_search');
      db.exec(`INSERT INTO document_search(rowid, id, kind, title, body)
        SELECT rowid, id, kind, CAST(COALESCE(json_extract(spec, '$.title'), json_extract(spec, '$.name'),
          json_extract(spec, '$.label'), id) AS TEXT), wm_search_text(kind, id, spec)
        FROM resources WHERE deleted_at IS NULL`);
      if (registered) {
        db.prepare("INSERT INTO store_meta(key, value) VALUES ('document_search_version', 3) ON CONFLICT(key) DO UPDATE SET value = 3").run();
      }
    }
    refreshDocumentSearch(db);
    db.exec('COMMIT');
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}

export function refreshDocumentSearch(db: DatabaseSync): void {
  if (!db.prepare('SELECT 1 FROM document_search_dirty LIMIT 1').get()) return;
  db.exec('SAVEPOINT document_search_refresh');
  try {
    db.exec(`DELETE FROM document_search WHERE rowid IN (SELECT row_id FROM document_search_dirty);
      INSERT INTO document_search(rowid, id, kind, title, body)
        SELECT rowid, id, kind,
          CAST(COALESCE(json_extract(spec, '$.title'), json_extract(spec, '$.name'), json_extract(spec, '$.label'), id) AS TEXT),
          wm_search_text(kind, id, spec)
        FROM resources WHERE rowid IN (SELECT row_id FROM document_search_dirty) AND deleted_at IS NULL;
      DELETE FROM document_search_dirty;
      RELEASE document_search_refresh;`);
  } catch (error) {
    db.exec('ROLLBACK TO document_search_refresh; RELEASE document_search_refresh;');
    throw error;
  }
}

export interface LexicalEvidence { excerpt: string; terms: string[] }
const atomPattern = /[\p{L}\p{N}\p{M}_]+(?:[-./:@+%?&#=]+[\p{L}\p{N}\p{M}_]+)*/gu;
const ftsPhrase = (text: string) => `"${text.replaceAll('"', '""')}"`;
export const HYBRID_CANDIDATE_LIMIT = 50;

function literalPatterns(phrases: string[]): Array<{
  text: string; asciiAnchor: string | null; expression: RegExp; chunks: Array<{ offset: number; length: number; expression: RegExp }> | null;
}> {
  return phrases.map(phrase => {
    // Bound regex size for long source atoms; verify the entire literal separately.
    const characters = Array.from(phrase);
    const prefix = characters.slice(0, 256).join('');
    const escape = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const chunks: Array<{ offset: number; length: number; expression: RegExp }> | null = prefix.length < phrase.length ? [] : null;
    let offset = 0;
    if (chunks) {
      for (let i = 0; i < characters.length; i += 256) {
        const text = characters.slice(i, i + 256).join('');
        chunks.push({ offset, length: text.length, expression: new RegExp(`^${escape(text)}$`, 'iu') });
        offset += text.length;
      }
    }
    const suffix = '(?![\\p{L}\\p{N}\\p{M}_])(?![-./:@+%?&#=]+[\\p{L}\\p{N}\\p{M}_])';
    const expression = new RegExp(`(?<![\\p{L}\\p{N}\\p{M}_])(?<![\\p{L}\\p{N}\\p{M}_][-./:@+%?&#=]+)${escape(prefix)}${chunks ? '' : suffix}`, chunks ? 'giu' : 'iu');
    const atoms = [...phrase.matchAll(atomPattern)];
    const asciiAnchor = /^[\x00-\x7F]*$/.test(phrase) && atoms.length >= 1 && atoms.length <= 2
      && atoms[0].index === 0 && atoms.at(-1)!.index! + atoms.at(-1)![0].length === phrase.length
      && (atoms.length === 1 || phrase.slice(atoms[0][0].length, atoms[1].index) === ' ')
      ? phrase.toLowerCase() : null;
    return { text: phrase, asciiAnchor, expression, chunks };
  });
}

const literalSuffix = /^(?:[\p{L}\p{N}\p{M}_]|[-./:@+%?&#=]+[\p{L}\p{N}\p{M}_])/u;
function literalIndex(text: string, pattern: ReturnType<typeof literalPatterns>[number]): number {
  pattern.expression.lastIndex = 0;
  for (let match = pattern.expression.exec(text); match; match = pattern.expression.exec(text)) {
    if (!pattern.chunks) return match.index;
    const start = match.index;
    const end = start + pattern.text.length;
    if (pattern.chunks.every(chunk => chunk.expression.test(text.slice(start + chunk.offset, start + chunk.offset + chunk.length)))
      && !literalSuffix.test(text.slice(end))) return match.index;
  }
  return -1;
}

function literalEvidence(text: string, patterns: ReturnType<typeof literalPatterns>): LexicalEvidence | undefined {
  const terms: string[] = [];
  let first = -1;
  for (const pattern of patterns) {
    const index = literalIndex(text, pattern);
    if (index >= 0) {
      terms.push(pattern.text);
      if (first < 0) first = index;
    }
  }
  if (first < 0) return;
  let start = Math.max(0, first - 160);
  if (start && /[\uDC00-\uDFFF]/.test(text[start])) start--;
  return { terms, excerpt: Array.from(text.slice(start)).slice(0, 600).join('') };
}

export function lexicalCandidates(
  db: DatabaseSync, eligible: ReadonlySet<string>,
  input: { sourceId: string } | { queries: string[]; literalQuery?: string },
): Map<string, LexicalEvidence> {
  const matches = new Map<string, LexicalEvidence>();
  if (!eligible.size) return matches;
  refreshDocumentSearch(db);
  const allowed = JSON.stringify([...eligible]);
  const phrases = new Map<string, { text: string; weight: number; explicit: boolean }>();
  const add = (text: string, weight: number, explicit = false) => {
    const key = text.toLowerCase();
    if (weight > 0 && (text.match(/[\p{L}\p{N}]+/gu) ?? []).length && weight > (phrases.get(key)?.weight ?? -Infinity)) {
      phrases.set(key, { text, weight, explicit });
    }
  };
  if ('sourceId' in input) {
    const source = db.prepare(`SELECT s.rowid, s.title,
      CASE WHEN r.kind = 'Topic' AND json_type(r.spec, '$.body') IS NOT 'text' THEN s.title ELSE s.body END AS body
      FROM document_search s JOIN resources r ON r.rowid = s.rowid WHERE r.id = ?`).get(input.sourceId);
    if (!source) throw new Error('The document search projection is unavailable. Retry after indexing.');
    const weights = new Map<string, { text: string; weight: number }>();
    const total = Number(db.prepare('SELECT count(*) AS count FROM document_search').get()?.count);
    const frequency = db.prepare(`SELECT min(doc) AS frequency FROM document_search_vocabulary
      WHERE term >= ? AND term < ? AND doc > 1`);
    const exactFrequency = db.prepare('SELECT doc FROM document_search_vocabulary WHERE term = ?');
    const prefixes = new Map<string, number | null>();
    const words = new Map<string, number | null>();
    const rarity = (part: string) => {
      // Stem-prefix frequency only proposes anchors; authored text establishes identity below.
      const normalized = part.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase();
      const prefix = Array.from(normalized).slice(0, 3).join('');
      const lookup = (key: string) => {
        if (!prefixes.has(key)) {
          const value = frequency.get(key, `${key}\uffff`)?.frequency;
          prefixes.set(key, value == null ? null : Number(value));
        }
        return prefixes.get(key);
      };
      if (!words.has(normalized)) {
        const value = exactFrequency.get(normalized)?.doc;
        words.set(normalized, value == null ? null : Number(value));
      }
      const exact = words.get(normalized);
      if (exact === 1) return -Infinity;
      const estimate = exact ?? lookup(prefix) ?? lookup(Array.from(prefix)[0]) ?? total;
      return Math.log((total + 1) / (estimate + 0.5));
    };
    for (const column of ['title', 'body'] as const) {
      const atoms = [...String(source[column]).matchAll(atomPattern)];
      for (const atom of atoms) {
        const key = atom[0].toLowerCase();
        const parts = (atom[0].match(/[\p{L}\p{N}\p{M}]+/gu) ?? []).map(rarity);
        const weight = (parts.includes(-Infinity) ? -Infinity : Math.max(0, ...parts)) * (column === 'title' ? 3 : 1);
        if (weight > (weights.get(key)?.weight ?? -Infinity)) weights.set(key, { text: atom[0], weight });
      }
    }
    for (const atom of weights.values()) add(atom.text, atom.weight);
    for (const column of ['title', 'body'] as const) {
      const text = String(source[column]);
      const atoms = [...text.matchAll(atomPattern)];
      for (let i = 1; i < atoms.length; i++) {
        const left = weights.get(atoms[i - 1][0].toLowerCase());
        const right = weights.get(atoms[i][0].toLowerCase());
        if (!left || !right) continue;
        if (!text.slice(atoms[i - 1].index! + atoms[i - 1][0].length, atoms[i].index).trim()) {
          add(`${left.text} ${right.text}`, Math.max(left.weight, right.weight) * 1.01);
        }
      }
    }
  } else {
    for (const text of [input.literalQuery ?? '', ...input.queries]) {
      add(text, 2, text === input.literalQuery);
      for (const atom of text.matchAll(atomPattern)) add(atom[0], 1);
    }
  }
  const authoredText = `document_search.title || char(10) ||
    CASE WHEN r.kind = 'Topic' AND json_type(r.spec, '$.body') IS NOT 'text' THEN '' ELSE document_search.body END`;
  const proposals = [...phrases.values()].sort((a, b) => b.weight - a.weight || a.text.localeCompare(b.text)).slice(0, 128);
  if (!proposals.length) return matches;
  const frequencies = new Map<string, number>();
  for (const row of db.prepare(`SELECT wm_literal_evidence(${authoredText}, ?, 2) AS matched_terms
    FROM document_search JOIN resources r ON r.rowid = document_search.rowid
    WHERE document_search MATCH ? AND document_search.id IN (SELECT value FROM json_each(?))`)
    .iterate(JSON.stringify(proposals.map(phrase => phrase.text)), proposals.map(phrase => ftsPhrase(phrase.text)).join(' OR '), allowed)) {
    for (const term of JSON.parse(String(row.matched_terms)) as string[]) {
      frequencies.set(term, (frequencies.get(term) ?? 0) + 1);
    }
  }
  const candidates = proposals
    .map(phrase => ({ ...phrase, frequency: frequencies.get(phrase.text) ?? 0 }))
    .filter(phrase => phrase.frequency > 0 && (phrase.explicit || eligible.size < 3 || phrase.frequency / eligible.size < 0.5))
    .sort((a, b) => a.frequency - b.frequency || b.weight - a.weight || a.text.localeCompare(b.text))
    .slice(0, 12).map(phrase => phrase.text);
  if (!candidates.length) return matches;
  const rawTerms = JSON.stringify(candidates);
  for (const row of db.prepare(`SELECT document_search.id, wm_literal_evidence(${authoredText}, ?, 1) AS evidence
    FROM document_search JOIN resources r ON r.rowid = document_search.rowid WHERE document_search MATCH ?
    AND document_search.id IN (SELECT value FROM json_each(?)) AND evidence != ''
    ORDER BY bm25(document_search, 0, 0, 6, 1), document_search.id LIMIT ?`)
    .iterate(rawTerms, candidates.map(ftsPhrase).join(' OR '), allowed, HYBRID_CANDIDATE_LIMIT)) {
    matches.set(String(row.id), JSON.parse(String(row.evidence)) as LexicalEvidence);
  }
  return matches;
}

export function hybridRanks(semantic: ReadonlyMap<string, number>, lexical: ReadonlyMap<string, LexicalEvidence>): Map<string, number> {
  const ranks = new Map<string, number>();
  const meaning = [...semantic].filter(([, score]) => score >= 0.35)
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).slice(0, HYBRID_CANDIDATE_LIMIT);
  meaning.forEach(([id], index) => ranks.set(id, 1 / (61 + index)));
  [...lexical.keys()].forEach((id, index) => ranks.set(id, (ranks.get(id) ?? 0) + 1.25 / (61 + index)));
  return ranks;
}

export function lexicalConfidence(evidence: LexicalEvidence): MatchConfidence {
  return { level: 'high', reason: `Verified lexical evidence: ${evidence.terms.slice(0, 3).map(term => JSON.stringify(term)).join(', ')}. This verifies the text match, not its intended meaning.` };
}

export function searchDocuments(
  db: DatabaseSync,
  input: DocumentSearchInput,
  canReadKind: (kind: string) => boolean = () => true,
): DocumentSearchResult {
  if (listKinds().length && Number(db.prepare("SELECT value FROM store_meta WHERE key = 'document_search_version'").get()?.value ?? 0) < 3) {
    ensureDocumentSearch(db);
  }
  refreshDocumentSearch(db);
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
      substr(snippet(document_search, 3, '', '', ' ... ', 48), 1, 1200) AS excerpt,
      -bm25(document_search, 0, 0, 6, 1) AS score
    FROM document_search WHERE document_search MATCH ?
      AND kind IN (${allowedKinds.map(() => '?').join(',')})
    ORDER BY bm25(document_search, 0, 0, 6, 1), id LIMIT ?`)
    .all(phrases.join(' OR '), ...allowedKinds, limit) as unknown as DocumentSearchHit[];
  return { count: results.length, results };
}
