import { z } from 'zod';

export const EMBEDDING_MODEL = 'minilm-l6-v2:1110a243:384:v1';
export const EMBEDDING_DIMENSIONS = 384;
export const EMBEDDING_TEXT_LIMIT = 32000;
export const EMBEDDING_HOST_PORT = 7716;
export function embeddingErrorMessage(error: unknown): string {
  const messages: string[] = [];
  for (let depth = 0; depth < 3 && error instanceof Error; depth++) {
    if (error.message) messages.push(error.message);
    error = error.cause;
  }
  if (!messages.length && typeof error === 'string') messages.push(error);
  return (messages.join(': ') || 'Embedding operation failed without an error message.')
    .replace(/\bBearer\s+\S+/gi, 'Bearer [redacted]')
    .replace(/\b[a-f0-9]{64}\b/gi, '[redacted]')
    .replace(/(\b(?:token|api[_ -]?key|password|authorization)["']?\s*[=:]\s*)(?:"[^"]*"|'[^']*'|[^\s,;]+)/gi, '$1[redacted]')
    .replace(/(https?:\/\/)[^/\s@]+@/gi, '$1[redacted]@')
    .slice(0, 4000);
}
export const SEMANTIC_SEARCH_INFERENCE_TIMEOUT_MS = 60_000;
export const embeddingHostSettingsSchema = z.object({
  idleTimeoutMinutes: z.number().int().min(1).max(1440).nullable(),
}).strict();
export type EmbeddingHostSettings = z.infer<typeof embeddingHostSettingsSchema>;
export const semanticSearchTimingsSchema = z.object({
  startupMs: z.number().nonnegative().optional(),
  inferenceMs: z.number().nonnegative(),
  rankingMs: z.number().nonnegative(),
  hostMs: z.number().nonnegative(),
}).strict();
export type SemanticSearchTimings = z.infer<typeof semanticSearchTimingsSchema>;
export const EMBEDDING_DOWNLOAD_BYTES = 90871461;
export const EMBEDDING_KINDS = ['Topic', 'Workstream', 'AgentMessage', 'CommandJournal', 'ContainerClaim', 'TopicType', 'Agent'] as const;
export const matchConfidenceSchema = z.object({
  level: z.enum(['high', 'medium', 'low']), reason: z.string().min(1),
}).strict();
export type MatchConfidence = z.infer<typeof matchConfidenceSchema>;
export function matchConfidence(passage: number, document: number, literal = false, limited = false): MatchConfidence {
  if (literal) return { level: 'high', reason: 'The exact search word or phrase occurs in this document. This verifies the text match, not its intended meaning.' };
  if (passage >= 0.65 && document >= 0.5 && !limited) {
    return { level: 'high', reason: 'Strong supporting-passage similarity agrees with the document-level similarity.' };
  }
  if (passage >= 0.45 && document >= 0.35) {
    return { level: 'medium', reason: limited ? 'Supporting evidence matches, but document coverage is limited.'
      : 'Supporting-passage and document-level similarities agree, but are not both strong.' };
  }
  return { level: 'low', reason: 'Supporting evidence is weak or does not strongly agree with the document-level similarity.' };
}
export const semanticSearchSchema = z.object({
  queries: z.array(z.string().trim().min(1).max(500)).min(1).max(8),
  literalQuery: z.string().trim().min(1).max(2000).optional(),
  kinds: z.array(z.enum(EMBEDDING_KINDS)).min(1).optional(),
  limit: z.number().int().min(1).max(40).default(20),
}).strict();
export const embeddingActionSchema = z.enum(['enable', 'pause', 'resume', 'retry', 'disable']);
export function isPrivateEmbeddingAddress(value: string): boolean {
  const parts = value.split('.');
  if (parts.length !== 4 || parts.some(part => !/^(0|[1-9]\d{0,2})$/.test(part) || Number(part) > 255)) return false;
  const [a, b] = parts.map(Number);
  return a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168)
    || (a === 169 && b === 254);
}
const embeddingEndpointSchema = z.string().url().refine(value => {
    if (!URL.canParse(value)) return false;
    const url = new URL(value);
    const local = ['host.docker.internal', '127.0.0.1', '[::1]'].includes(url.hostname);
    const wsl = isPrivateEmbeddingAddress(url.hostname) && Number(url.port) === EMBEDDING_HOST_PORT;
    return url.protocol === 'http:' && (local || wsl)
      && !url.username && !url.password && url.pathname === '/' && !url.search && !url.hash
      && Number(url.port) >= 1024 && value === url.origin;
  }, 'Use a local host endpoint or a private WSL IPv4 address on port 7716.');
export const embeddingHostSchema = z.object({
  endpoint: embeddingEndpointSchema,
  token: z.string().regex(/^[a-f0-9]{64}$/),
  candidates: z.array(embeddingEndpointSchema).min(1).max(8).optional(),
}).strict();
export type EmbeddingHost = z.infer<typeof embeddingHostSchema>;
export const embeddingNetworkResultSchema = z.object({
  endpoints: z.array(embeddingEndpointSchema), error: z.string().nullable(),
}).strict();
export const embeddingConfigureSchema = z.object({
  action: embeddingActionSchema,
  host: embeddingHostSchema.optional(),
}).strict();
export const embeddingStatsSchema = z.object({
  total: z.number().int().nonnegative(),
  indexed: z.number().int().nonnegative(),
  pending: z.number().int().nonnegative(),
  limited: z.number().int().nonnegative(),
  vectorBytes: z.number().int().nonnegative(),
  lastIndexedAt: z.number().nullable(),
}).strict();
export type EmbeddingStats = z.infer<typeof embeddingStatsSchema>;
export const semanticStatusSchema = z.object({
  enabled: z.boolean(), ready: z.boolean(), stats: embeddingStatsSchema,
}).strict();
export const embeddingWorkSchema = z.object({
  id: z.string().min(1),
  sourceVersion: z.number().int().nonnegative(),
  contentHash: z.string().regex(/^[a-f0-9]{64}$/),
  limited: z.boolean(),
  passages: z.array(z.string().min(1).max(1400)).min(1).max(80),
}).strict();
export type EmbeddingWork = z.infer<typeof embeddingWorkSchema>;
export const embeddingBatchSchema = z.object({
  stats: embeddingStatsSchema,
  work: embeddingWorkSchema.nullable(),
}).strict();
export const embeddingVectorSchema = z.array(z.number().finite()).length(EMBEDDING_DIMENSIONS)
  .refine(vector => {
    const norm = vector.reduce((sum, value) => sum + value * value, 0);
    return norm > 0.99 && norm < 1.01;
  }, 'Embedding vectors must be normalized.');
export const embeddingSubmitSchema = z.object({
  id: z.string().min(1),
  sourceVersion: z.number().int().nonnegative(),
  contentHash: z.string().regex(/^[a-f0-9]{64}$/),
  model: z.literal(EMBEDDING_MODEL),
  vectors: z.array(embeddingVectorSchema).min(1).max(80),
}).strict();
export const embeddingReadySchema = z.object({
  ready: z.literal(true), backend: z.string(), warning: z.string().nullable(),
  rssBytes: z.number().nonnegative(),
}).strict();
export const embeddingInferenceSchema = z.object({
  id: z.number().int(), vectors: z.array(embeddingVectorSchema).min(1).max(80),
  durationMs: z.number().nonnegative(), rssBytes: z.number().nonnegative(),
  startupMs: z.number().nonnegative().optional(),
}).strict();
export const embeddingHostRequestSchema = z.object({
  model: z.literal(EMBEDDING_MODEL),
  texts: z.array(z.string().min(1).max(1400)).min(1).max(80),
}).strict();
export const embeddingHostStatusSchema = z.object({
  model: z.literal(EMBEDDING_MODEL), version: z.string(),
  phase: z.enum(['idle', 'downloading', 'starting', 'indexing', 'error']),
  downloadBytes: z.number().nonnegative(), backend: z.string().nullable(),
  warning: z.string().nullable(), error: z.string().nullable(),
  rssBytes: z.number().nonnegative().nullable(),
  idleTimeoutMinutes: embeddingHostSettingsSchema.shape.idleTimeoutMinutes.optional(),
  networkEnabled: z.boolean().optional(),
  networkEndpoints: z.array(z.string().url()).optional(),
  networkError: z.string().nullable().optional(),
}).strict();
export const embeddingDashboardSchema = z.object({
  endpoint: z.string().nullable(), enabled: z.boolean(), paused: z.boolean(),
  phase: z.enum(['disabled', 'paused', 'downloading', 'starting', 'indexing', 'idle', 'error']),
  model: z.literal(EMBEDDING_MODEL), downloadBytes: z.number().nonnegative(),
  downloadTotal: z.number().nonnegative(), backend: z.string().nullable(),
  warning: z.string().nullable(), error: z.string().nullable(),
  rssBytes: z.number().nonnegative().nullable(), lastInferenceMs: z.number().nonnegative().nullable(),
  lastSuccessAtMs: z.number().nullable(), stats: embeddingStatsSchema.nullable(),
}).strict();
export type EmbeddingDashboard = z.infer<typeof embeddingDashboardSchema>;
export const relatedTopicsInputSchema = z.object({
  id: z.string().min(1),
  workstream: z.string().min(1).optional(),
  limit: z.number().int().min(1).max(10).default(6),
}).strict();
export const relatedTopicsSchema = z.object({
  state: z.enum(['ready', 'pending', 'disabled']),
  limited: z.boolean(),
  results: z.array(z.object({
    id: z.string(),
    title: z.string(),
    excerpt: z.string(),
    similarity: z.number().nullable(),
    alreadyLinked: z.boolean(),
    evidence: z.enum(['semantic', 'keyword', 'both']),
    confidence: matchConfidenceSchema.optional(),
  }).strict()),
}).strict();
export type RelatedTopics = z.infer<typeof relatedTopicsSchema>;
