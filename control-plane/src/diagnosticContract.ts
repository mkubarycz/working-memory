import { z } from 'zod';

export const toolQueueSettingsSchema = z.object({
  maxConcurrency: z.number().int().min(1).max(64),
  maxQueueSize: z.number().int().min(1).max(1000),
  queueTimeoutMs: z.number().int().min(100).max(300000),
  heapDispatchPausePercent: z.number().int().min(10).max(90),
}).strict();
export type ToolQueueSettings = z.infer<typeof toolQueueSettingsSchema>;
export const DEFAULT_TOOL_QUEUE_SETTINGS: ToolQueueSettings = {
  maxConcurrency: 4, maxQueueSize: 16, queueTimeoutMs: 5000, heapDispatchPausePercent: 60,
};
export const toolQueueSettingsUpdateSchema = z.object({
  expectedBootId: z.string().uuid(),
  expectedSettings: toolQueueSettingsSchema,
  settings: toolQueueSettingsSchema,
}).strict();
export type ToolQueueSettingsUpdate = z.infer<typeof toolQueueSettingsUpdateSchema>;

export const diagnosticEventSchema = z.object({
  sequence: z.number().int(), at: z.number(), code: z.string(), requestId: z.string().nullable(),
  route: z.string(), status: z.number().int(), durationMs: z.number(), count: z.number().int(),
});
export const queueProcessingSchema = z.object({
  processedPerSecond: z.number(), processedLastMinute: z.number().int(),
  averageWaitMs: z.number().nullable(), averageRunMs: z.number().nullable(),
});
export const toolTimingTotalsSchema = z.object({
  finished: z.number().int().nonnegative(), executed: z.number().int().nonnegative(),
  waitMs: z.number().nonnegative(), runMs: z.number().nonnegative(),
});
export const queueDropsSchema = z.object({
  timeouts: z.number().int().nonnegative(),
  rejections: z.number().int().nonnegative(),
  shutdown: z.number().int().nonnegative(),
});
export const runtimeSampleSchema = z.object({
  at: z.number(), bootId: z.string().uuid(),
  heapUsedBytes: z.number(), heapLimitBytes: z.number(), rssBytes: z.number(),
  externalBytes: z.number(), arrayBufferBytes: z.number(), cpuPercent: z.number(),
  eventLoopMaxMs: z.number(), gcCount: z.number().int(), gcDurationMs: z.number(),
  queueDepth: z.number().int(), runningTools: z.number().int(),
  peakQueueDepth: z.number().int().optional(),
  processing: queueProcessingSchema.optional(),
  requestsByTool: z.record(z.string(), z.number().int().nonnegative()).optional(),
  timingsByTool: z.record(z.string(), toolTimingTotalsSchema).optional(),
  queueDrops: queueDropsSchema.optional(),
  operations: z.array(z.object({
    requestId: z.string().uuid(), operation: z.string(), caller: z.string(),
    queuedAt: z.number(), startedAt: z.number().optional(),
  })),
});
const queuedToolSchema = z.object({
  requestId: z.string().uuid(), operation: z.string(), caller: z.string(),
  queuedAt: z.number(), startedAt: z.number().optional(),
});
export const toolQueueSnapshotSchema = z.object({
  bootId: z.string().uuid(), observedAt: z.number(),
  settings: toolQueueSettingsSchema.optional(),
  limits: z.object({ running: z.number().int(), waiting: z.number().int(), waitMs: z.number() }),
  memoryBlocked: z.boolean(), running: z.number().int(), waiting: z.number().int(),
  processing: queueProcessingSchema.optional(),
  requestsByTool: z.record(z.string(), z.number().int().nonnegative()).optional(),
  timingsByTool: z.record(z.string(), toolTimingTotalsSchema).optional(),
  queueDrops: queueDropsSchema.optional(),
  items: z.array(queuedToolSchema),
  events: z.array(z.object({
    sequence: z.number().int(), at: z.number(), requestId: z.string().uuid(),
    operation: z.string(), caller: z.string(), event: z.string(),
    waiting: z.number().int(), running: z.number().int(), waitMs: z.number(), runMs: z.number(),
  })),
  history: z.array(runtimeSampleSchema.pick({ at: true, bootId: true, queueDepth: true, peakQueueDepth: true, runningTools: true, processing: true, requestsByTool: true, timingsByTool: true, queueDrops: true })),
});
export type ToolQueueSnapshot = z.infer<typeof toolQueueSnapshotSchema>;
export interface DesktopToolQueue {
  endpoint: string | null;
  snapshot: ToolQueueSnapshot | null;
  error: string | null;
}
export const queuedRequestSchema = z.object({ requestId: z.string().uuid(), body: z.unknown() });
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
  samples: z.array(runtimeSampleSchema).optional(),
  workQueue: toolQueueSnapshotSchema.pick({ limits: true, memoryBlocked: true, running: true, waiting: true, processing: true, items: true, events: true }).optional(),
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
