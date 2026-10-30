import { z } from 'zod';

export const sessionPolicySchema = z.object({
  idleMinutes: z.number().int().min(1).max(1440),
  maxPerClient: z.number().int().min(1).max(10000),
  maxTotal: z.number().int().min(1).max(10000),
  handshakesPerMinute: z.number().int().min(1).max(100000),
  retentionDays: z.number().int().min(1).max(365),
}).strict().refine(value => value.maxPerClient <= value.maxTotal, {
  message: 'The per-client limit must not exceed the total limit.',
});
export type SessionPolicy = z.infer<typeof sessionPolicySchema>;
export const DEFAULT_SESSION_POLICY: SessionPolicy = {
  idleMinutes: 60, maxPerClient: 100, maxTotal: 500, handshakesPerMinute: 1000, retentionDays: 10,
};
export const SESSION_HEAP_FRACTION = 0.6;
export const sessionEventTypeSchema = z.enum([
  'opened', 'closed', 'idle_expired', 'client_quota', 'global_quota', 'rate_limited',
  'memory_rejected', 'initialization_failed', 'cleanup_failed', 'policy_updated', 'server_shutdown',
]);
export type SessionEventType = z.infer<typeof sessionEventTypeSchema>;
// Diagnostics use epoch milliseconds, independently of document metadata timestamps.
const sessionClientSchema = z.object({
  clientId: z.string().nullable(), clientLabel: z.string(), application: z.string(),
});
export const sessionSnapshotSchema = z.object({
  startedAt: z.number(),
  policy: sessionPolicySchema,
  memory: z.object({
    heapUsedBytes: z.number(), heapLimitBytes: z.number(), admissionThresholdBytes: z.number(),
    admissionBlocked: z.boolean(),
  }),
  active: z.array(sessionClientSchema.extend({
    id: z.string(), state: z.enum(['initializing', 'active']), createdAt: z.number(),
    lastActivityAt: z.number(), activeRequests: z.number(), requests: z.number(),
  })),
  events: z.array(sessionClientSchema.extend({
    sequence: z.number(), type: sessionEventTypeSchema, sessionId: z.string().nullable(),
    firstAt: z.number(), lastAt: z.number(), count: z.number(), detail: z.string(),
  })),
  nextCursor: z.number().nullable(),
});
export type SessionSnapshot = z.infer<typeof sessionSnapshotSchema>;
