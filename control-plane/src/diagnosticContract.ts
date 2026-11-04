import { z } from 'zod';

export const diagnosticEventSchema = z.object({
  sequence: z.number().int(), at: z.number(), code: z.string(), requestId: z.string().nullable(),
  route: z.string(), status: z.number().int(), durationMs: z.number(), count: z.number().int(),
});
export const diagnosticsSchema = z.object({
  bootId: z.string().uuid(), version: z.string(), startedAt: z.number(), observedAt: z.number(),
  runtime: z.object({
    heapUsedBytes: z.number(), heapLimitBytes: z.number(), rssBytes: z.number(),
    eventLoopMaxMs: z.number(), activeRequests: z.number().int(), activeSessions: z.number().int(),
    admissionBlocked: z.boolean(),
  }),
  minutes: z.array(z.object({
    at: z.number(), transactions: z.number().int(), errors: z.number().int(),
    averageMs: z.number(), maxMs: z.number(),
  })),
  callers: z.array(z.object({
    caller: z.string(), route: z.string(), status: z.number().int(), transactions: z.number().int(),
  })),
  events: z.array(diagnosticEventSchema),
});
export type InstanceDiagnostics = z.infer<typeof diagnosticsSchema>;

export const incidentSchema = z.object({
  id: z.string().uuid(), environment: z.string(), at: z.number(), kind: z.enum(['outage', 'restart', 'memory_pressure', 'event_loop_stall']),
  evidence: z.string(), topicId: z.string().nullable(), deliveryError: z.string().nullable(),
});
export type InstanceIncident = z.infer<typeof incidentSchema>;
export const incidentReportRequestSchema = incidentSchema.pick({
  id: true, environment: true, at: true, kind: true, evidence: true,
}).extend({
  environment: z.string().url().max(2048),
  at: z.number().nonnegative(),
  evidence: z.string().max(20000),
}).strict();
export const monitorStateSchema = z.object({
  environments: z.record(z.string(), z.object({
    bootId: z.string().nullable(), failures: z.number().int(), outageId: z.string().nullable(),
    memoryBlocked: z.boolean(), stallAt: z.number(),
    lastEvidence: z.string().default('No pre-incident runtime sample was available.'),
  })),
  incidents: z.array(incidentSchema),
});
export type MonitorState = z.infer<typeof monitorStateSchema>;
export interface DesktopDiagnostics {
  instance: InstanceDiagnostics | null;
  error: string | null;
  incidents: InstanceIncident[];
}
