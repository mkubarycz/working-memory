import { createHash } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import {
  EMBEDDING_DIMENSIONS, EMBEDDING_MODEL, EMBEDDING_TEXT_LIMIT, EMBEDDING_KINDS, semanticSearchSchema, matchConfidence,
  embeddingSubmitSchema, relatedTopicsInputSchema,
  type EmbeddingStats, type EmbeddingWork, type RelatedTopics,
} from './embeddingContract.js';
import { refreshDocumentSearch, type DocumentSearchHit } from './documentSearch.js';

const indexedKinds = EMBEDDING_KINDS.map(kind => `'${kind}'`).join(',');
const projectedBody = "CASE WHEN r.kind = 'Topic' THEN substr(s.body, length(s.title) + 2) ELSE s.body END";

export function ensureTopicEmbeddingSchema(db: DatabaseSync): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS topic_embedding_index (
      topic_id TEXT PRIMARY KEY REFERENCES resources(id) ON DELETE CASCADE,
      model_id TEXT NOT NULL, source_version INTEGER NOT NULL, content_hash TEXT NOT NULL,
      centroid BLOB NOT NULL, indexed_at INTEGER NOT NULL,
      limited INTEGER NOT NULL CHECK (limited IN (0, 1))
    );
    CREATE TABLE IF NOT EXISTS topic_embedding_passages (
      topic_id TEXT NOT NULL REFERENCES topic_embedding_index(topic_id) ON DELETE CASCADE,
      position INTEGER NOT NULL, excerpt TEXT NOT NULL, vector BLOB NOT NULL,
      PRIMARY KEY (topic_id, position)
    );
    CREATE TRIGGER IF NOT EXISTS topic_embedding_index_delete AFTER DELETE ON topic_embedding_index BEGIN
      DELETE FROM topic_embedding_passages WHERE topic_id = OLD.topic_id;
    END;
    CREATE TRIGGER IF NOT EXISTS topic_embedding_resource_delete AFTER DELETE ON resources BEGIN
      DELETE FROM topic_embedding_index WHERE topic_id = OLD.id;
    END;
    CREATE TRIGGER IF NOT EXISTS topic_embedding_resource_soft_delete AFTER UPDATE OF deleted_at ON resources
      WHEN NEW.deleted_at IS NOT NULL BEGIN
      DELETE FROM topic_embedding_index WHERE topic_id = NEW.id;
    END;
  `);
}

function source(db: DatabaseSync, id: string) {
  refreshDocumentSearch(db);
  const row = db.prepare(`SELECT r.id, r.kind, r.resource_version, s.title,
    substr(${projectedBody}, 1, ?) AS body,
    length(${projectedBody}) AS body_length,
    COALESCE(json_extract(r.spec, '$.parents'), '[]') AS parents
    FROM resources r JOIN document_search s ON s.rowid = r.rowid
    WHERE r.id = ? AND r.kind IN (${indexedKinds}) AND r.deleted_at IS NULL`)
    .get(EMBEDDING_TEXT_LIMIT, id);
  if (!row) throw new Error('That document is no longer available.');
  return row;
}

export function embeddingPassages(title: string, body: string): string[] {
  const passages: string[] = [];
  const text = Array.from(body.trim() || title);
  for (let offset = 0; offset < text.length; offset += 500) {
    passages.push(`${title.slice(0, 120)}\n${text.slice(offset, offset + 600).join('')}`);
  }
  return passages;
}

function hash(title: string, body: string): string {
  return createHash('sha256').update(`${title}\n${body}`).digest('hex');
}

export function embeddingStats(db: DatabaseSync, canReadKind: (kind: string) => boolean = () => true): EmbeddingStats {
  const kinds = EMBEDDING_KINDS.filter(canReadKind);
  const filter = kinds.map(() => '?').join(',') || 'NULL';
  const row = db.prepare(`SELECT count(*) AS total,
    count(i.topic_id) FILTER (WHERE i.model_id = ? AND i.source_version = r.resource_version) AS indexed,
    count(i.topic_id) FILTER (WHERE i.model_id = ? AND i.source_version = r.resource_version AND i.limited = 1) AS limited,
    max(i.indexed_at) AS last_indexed_at
    FROM resources r LEFT JOIN topic_embedding_index i ON i.topic_id = r.id
    WHERE r.kind IN (${filter}) AND r.deleted_at IS NULL`).get(EMBEDDING_MODEL, EMBEDDING_MODEL, ...kinds);
  const bytes = db.prepare(`SELECT COALESCE(sum(length(p.vector)), 0) AS bytes
    FROM topic_embedding_passages p JOIN resources r ON r.id = p.topic_id
    WHERE r.deleted_at IS NULL AND r.kind IN (${filter})`).get(...kinds);
  const total = Number(row?.total), indexed = Number(row?.indexed);
  return { total, indexed, pending: total - indexed, limited: Number(row?.limited),
    vectorBytes: Number(bytes?.bytes), lastIndexedAt: row?.last_indexed_at == null ? null : Number(row.last_indexed_at) };
}

export function nextEmbeddingWork(db: DatabaseSync): { stats: EmbeddingStats; work: EmbeddingWork | null } {
  db.exec(`DELETE FROM topic_embedding_index WHERE topic_id IN
    (SELECT id FROM resources WHERE deleted_at IS NOT NULL)`);
  // Metadata-only edits can reuse vectors, but only after checking the exact indexed content.
  for (let attempt = 0; attempt < 20; attempt++) {
    const row = db.prepare(`SELECT r.id, i.content_hash, i.model_id FROM resources r
      LEFT JOIN topic_embedding_index i ON i.topic_id = r.id
      WHERE r.kind IN (${indexedKinds}) AND r.deleted_at IS NULL
      AND (i.topic_id IS NULL OR i.model_id != ? OR i.source_version != r.resource_version)
      ORDER BY r.updated_at DESC, r.id LIMIT 1`).get(EMBEDDING_MODEL);
    if (!row) return { stats: embeddingStats(db), work: null };
    const current = source(db, String(row.id));
    const title = String(current.title), body = String(current.body);
    const contentHash = hash(title, body);
    if (row.model_id === EMBEDDING_MODEL && row.content_hash === contentHash) {
      db.prepare(`UPDATE topic_embedding_index SET source_version = ?, model_id = ?, limited = ? WHERE topic_id = ?`)
        .run(Number(current.resource_version), EMBEDDING_MODEL, Number(current.body_length) > EMBEDDING_TEXT_LIMIT ? 1 : 0, String(row.id));
      continue;
    }
    return { stats: embeddingStats(db), work: {
      id: String(row.id), sourceVersion: Number(current.resource_version), contentHash,
      limited: Number(current.body_length) > EMBEDDING_TEXT_LIMIT, passages: embeddingPassages(title, body),
    } };
  }
  return { stats: embeddingStats(db), work: null };
}

function normalized(values: number[]): number[] {
  const norm = Math.sqrt(values.reduce((sum, value) => sum + value * value, 0));
  if (!Number.isFinite(norm) || norm < 1e-8) throw new Error('Embedding centroid has no usable direction.');
  return values.map(value => value / norm);
}

function bytes(vector: number[]): Buffer {
  const buffer = Buffer.alloc(vector.length * 4);
  vector.forEach((value, index) => buffer.writeFloatLE(value, index * 4));
  return buffer;
}

function vector(value: unknown): number[] {
  if (!(value instanceof Uint8Array) || value.byteLength !== EMBEDDING_DIMENSIONS * 4) {
    throw new Error('Stored embedding is invalid. Rebuild the embedding index.');
  }
  const buffer = Buffer.from(value);
  return Array.from({ length: EMBEDDING_DIMENSIONS }, (_, index) => buffer.readFloatLE(index * 4));
}

export function submitEmbeddings(db: DatabaseSync, raw: unknown): { accepted: boolean } {
  const input = embeddingSubmitSchema.parse(raw);
  if (!db.prepare(`SELECT 1 FROM resources WHERE id = ? AND kind IN (${indexedKinds}) AND deleted_at IS NULL`).get(input.id)) {
    return { accepted: false };
  }
  const current = source(db, input.id);
  if (Number(current.resource_version) !== input.sourceVersion) return { accepted: false };
  const title = String(current.title), body = String(current.body);
  if (hash(title, body) !== input.contentHash) throw new Error('Document content hash does not match the indexing request. Refresh and retry.');
  const passages = embeddingPassages(title, body);
  if (passages.length !== input.vectors.length) throw new Error('Embedding count does not match the document passages.');
  const centroid = normalized(Array.from({ length: EMBEDDING_DIMENSIONS }, (_, index) =>
    input.vectors.reduce((sum, values) => sum + values[index], 0)));
  db.exec('SAVEPOINT topic_embeddings');
  try {
    db.prepare(`INSERT INTO topic_embedding_index(topic_id, model_id, source_version, content_hash, centroid, indexed_at, limited)
      VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT(topic_id) DO UPDATE SET
      model_id = excluded.model_id, source_version = excluded.source_version, content_hash = excluded.content_hash,
      centroid = excluded.centroid, indexed_at = excluded.indexed_at, limited = excluded.limited`)
      .run(input.id, input.model, input.sourceVersion, input.contentHash, bytes(centroid),
        Math.floor(Date.now() / 1000), Number(current.body_length) > EMBEDDING_TEXT_LIMIT ? 1 : 0);
    db.prepare('DELETE FROM topic_embedding_passages WHERE topic_id = ?').run(input.id);
    const insert = db.prepare('INSERT INTO topic_embedding_passages(topic_id, position, excerpt, vector) VALUES (?, ?, ?, ?)');
    passages.forEach((passage, index) => insert.run(input.id, index, passage, bytes(input.vectors[index])));
    db.exec('RELEASE topic_embeddings');
    return { accepted: true };
  } catch (error) {
    db.exec('ROLLBACK TO topic_embeddings; RELEASE topic_embeddings');
    throw error;
  }
}

function similarity(a: number[], b: number[]): number {
  let sum = 0;
  for (let i = 0; i < EMBEDDING_DIMENSIONS; i++) sum += a[i] * b[i];
  return Math.max(-1, Math.min(1, sum));
}

export function relatedTopics(db: DatabaseSync, raw: unknown, enabled: boolean): RelatedTopics {
  const input = relatedTopicsInputSchema.parse(raw);
  if (!enabled) return { state: 'disabled', limited: false, results: [] };
  const current = source(db, input.id);
  if (current.kind !== 'Topic') throw new Error('Related topics requires a Topic.');
  const indexed = db.prepare('SELECT * FROM topic_embedding_index WHERE topic_id = ? AND model_id = ? AND source_version = ?')
    .get(input.id, EMBEDDING_MODEL, Number(current.resource_version));
  const sourceVector = indexed ? vector(indexed.centroid) : null;
  const best: Array<{ id: string; score: number }> = [];
  if (sourceVector) {
    for (const row of db.prepare(`SELECT r.id, i.centroid FROM topic_embedding_index i JOIN resources r ON r.id = i.topic_id
      WHERE r.kind = 'Topic' AND r.deleted_at IS NULL AND r.id != ?
      AND i.model_id = ? AND i.source_version = r.resource_version
      AND (? IS NULL OR EXISTS (SELECT 1 FROM json_each(r.spec, '$.workstreams') WHERE value = ?))`)
      .iterate(input.id, EMBEDDING_MODEL, input.workstream ?? null, input.workstream ?? null)) {
      const score = similarity(sourceVector, vector(row.centroid));
      if (score < 0.35) continue;
      best.push({ id: String(row.id), score });
      best.sort((a, b) => b.score - a.score || a.id.localeCompare(b.id));
      if (best.length > 40) best.pop();
    }

  }
  const parents: string[] = JSON.parse(String(current.parents));
  const results = best.slice(0, input.limit).map(({ id, score }) => {
      const doc = source(db, id);
      const candidateParents: string[] = JSON.parse(String(doc.parents));
      let excerpt = String(doc.body).slice(0, 600);
      let passageScore = -1;
      if (sourceVector) {
        for (const passage of db.prepare('SELECT excerpt, vector FROM topic_embedding_passages WHERE topic_id = ?').iterate(id)) {
          const score = similarity(sourceVector, vector(passage.vector));
          if (score > passageScore) { passageScore = score; excerpt = String(passage.excerpt); }
        }
      }
      return { id, title: String(doc.title), excerpt, similarity: score,
        confidence: matchConfidence(passageScore, score, false,
          Number(indexed?.limited) === 1 || Number(doc.body_length) > EMBEDDING_TEXT_LIMIT),
        alreadyLinked: parents.includes(id) || candidateParents.includes(input.id),
        evidence: 'semantic' as const };
    });
  return { state: indexed ? 'ready' : 'pending', limited: Number(current.body_length) > EMBEDDING_TEXT_LIMIT, results };
}

export function semanticSearch(
  db: DatabaseSync, raw: unknown, vectors: number[][], canReadKind: (kind: string) => boolean,
): { count: number; results: DocumentSearchHit[]; limited: boolean } {
  const input = semanticSearchSchema.parse(raw);
  const kinds = EMBEDDING_KINDS.filter(kind => canReadKind(kind) && (!input.kinds || input.kinds.includes(kind)));
  if (!kinds.length) return { count: 0, results: [], limited: false };
  refreshDocumentSearch(db);
  const limited = !!db.prepare(`SELECT 1 FROM topic_embedding_index i JOIN resources r ON r.id = i.topic_id
    WHERE r.deleted_at IS NULL AND r.kind IN (${kinds.map(() => '?').join(',')})
    AND i.model_id = ? AND i.source_version = r.resource_version AND i.limited = 1 LIMIT 1`).get(...kinds, EMBEDDING_MODEL);
  const candidates = new Map<string, DocumentSearchHit>();
  const literalMatches = new Map<string, string>();
  if (input.literalQuery) {
    const phrase = input.literalQuery.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const expression = new RegExp(`(?<![\\p{L}\\p{N}_])${phrase}(?![\\p{L}\\p{N}_])`, 'iu');
    for (const row of db.prepare(`SELECT r.id, document_search.title || char(10) || document_search.body AS text FROM resources r
      JOIN document_search ON document_search.rowid = r.rowid
      WHERE r.deleted_at IS NULL AND r.kind IN (${kinds.map(() => '?').join(',')})
      AND document_search MATCH ?`).iterate(...kinds, `"${input.literalQuery.replaceAll('"', '""')}"`)) {
      const text = String(row.text);
      const match = expression.exec(text);
      if (!match) continue;
      let start = Math.max(0, match.index - 160);
      if (start && /[\uDC00-\uDFFF]/.test(text[start])) start--;
      let end = Math.min(text.length, match.index + 1200);
      if (end < text.length && /[\uDC00-\uDFFF]/.test(text[end])) end--;
      literalMatches.set(String(row.id), Array.from(text.slice(start, end)).slice(0, 600).join(''));
    }
  }
  const documentScores = new Map<string, number[]>();
  for (const row of db.prepare(`SELECT r.id, r.kind, r.resource_version, s.title, p.excerpt, p.vector, i.centroid, i.limited FROM resources r
    JOIN topic_embedding_index i ON i.topic_id = r.id JOIN document_search s ON s.rowid = r.rowid
    JOIN topic_embedding_passages p ON p.topic_id = r.id
    WHERE r.deleted_at IS NULL AND r.kind IN (${kinds.map(() => '?').join(',')})
    AND i.model_id = ? AND i.source_version = r.resource_version`).iterate(...kinds, EMBEDDING_MODEL)) {
    const values = vector(row.vector);
    const scores = vectors.map(query => similarity(query, values));
    const score = Math.max(...scores);
    if (score < 0.35 && !literalMatches.has(String(row.id))) continue;
    const id = String(row.id);
    let centroidScores = documentScores.get(id);
    if (!centroidScores) {
      const centroid = vector(row.centroid);
      centroidScores = vectors.map(query => similarity(query, centroid));
      documentScores.set(id, centroidScores);
    }
    if (score > (candidates.get(id)?.score ?? Number.NEGATIVE_INFINITY)) candidates.set(id, {
      id, kind: String(row.kind), title: String(row.title), excerpt: literalMatches.get(id) ?? String(row.excerpt), score, similarity: score,
      resourceVersion: Number(row.resource_version),
      ...(literalMatches.has(id) ? { literalMatch: true } : {}),
      confidence: matchConfidence(score, centroidScores[scores.indexOf(score)], literalMatches.has(id), Number(row.limited) === 1),
    });
  }
  const results = [...candidates.values()].sort((a, b) =>
    Number(!!b.literalMatch) - Number(!!a.literalMatch) || b.score - a.score || a.id.localeCompare(b.id)).slice(0, input.limit);
  return { count: results.length, results, limited: limited || candidates.size > results.length };
}
