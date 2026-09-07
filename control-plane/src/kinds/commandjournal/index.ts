import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { Base, type KindModule } from '../base.js';
import type { Store } from '../../store.js';
import { registerWsCommandJournalOperations } from './operations.js';
import { registerWsCommandJournalRead } from './read.js';

export const COMMAND_JOURNAL_KIND = 'CommandJournal';

const MAX_TEXT_CHARS = 32_768;
const MAX_PAYLOAD_BYTES = 65_536;
const MAX_EVENTS = 1_000;
const CREDENTIAL_KEY = /(?:^|[_-])(authorization|cookie|credential|password|secret|token)(?:$|[_-])/i;

const boundedText = z.string().max(MAX_TEXT_CHARS);
const identifier = z.string().min(1).max(256);

const jsonValue: z.ZodType<unknown> = z.lazy(() =>
  z.union([
    z.string(),
    z.number().finite(),
    z.boolean(),
    z.null(),
    z.array(jsonValue).max(1_000),
    z.record(z.string().max(256), jsonValue),
  ]),
);

export const sanitizedPayload = jsonValue.superRefine((value, context) => {
  let encoded: string;
  try {
    encoded = JSON.stringify(value);
  } catch {
    context.addIssue({ code: z.ZodIssueCode.custom, message: 'payload must be JSON serializable' });
    return;
  }
  if (Buffer.byteLength(encoded, 'utf8') > MAX_PAYLOAD_BYTES) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      message: `payload exceeds ${MAX_PAYLOAD_BYTES} UTF-8 bytes`,
    });
  }

  const visit = (candidate: unknown): void => {
    if (Array.isArray(candidate)) {
      candidate.forEach(visit);
      return;
    }
    if (!candidate || typeof candidate !== 'object') {
      return;
    }
    for (const [key, child] of Object.entries(candidate as Record<string, unknown>)) {
      if (CREDENTIAL_KEY.test(key)) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          message: `payload contains prohibited credential field "${key}"`,
        });
      }
      visit(child);
    }
  };
  visit(value);
});

export const scopeRef = z
  .object({
    kind: identifier,
    id: identifier,
    slug: identifier.optional(),
    title: boundedText.optional(),
  })
  .strict();

const eventBase = {
  id: identifier,
  sequence: z.number().int().positive(),
  timestamp: z.number().int().nonnegative(),
};

const tokenUsage = z
  .object({
    inputTokens: z.number().int().nonnegative().optional(),
    outputTokens: z.number().int().nonnegative().optional(),
    totalTokens: z.number().int().nonnegative().optional(),
  })
  .strict();

const contentPart = z
  .object({
    type: z.enum(['text', 'reasoning']),
    text: boundedText,
  })
  .strict();

const modelTurn = z
  .object({
    ...eventBase,
    type: z.literal('model_turn'),
    role: z.enum(['assistant', 'system']),
    iteration: z.number().int().positive(),
    assistantText: boundedText.optional(),
    contentParts: z.array(contentPart).max(256).optional(),
    providerResponseId: identifier.optional(),
    finishReason: identifier.optional(),
    usage: tokenUsage.optional(),
    durationMs: z.number().int().nonnegative(),
  })
  .strict()
  .superRefine((event, context) => {
    if (event.role === 'assistant' && event.assistantText === undefined && event.contentParts === undefined) {
      context.addIssue({ code: z.ZodIssueCode.custom, message: 'assistant model turn requires assistantText or contentParts' });
    }
  });

const toolCall = z
  .object({
    ...eventBase,
    type: z.literal('tool_call'),
    modelTurnId: identifier,
    callId: identifier,
    toolName: identifier,
    arguments: sanitizedPayload.optional(),
    argumentParseError: boundedText.optional(),
    retryOfCallId: identifier.optional(),
    dedupedOfCallId: identifier.optional(),
  })
  .strict()
  .superRefine((event, context) => {
    if ((event.arguments === undefined) === (event.argumentParseError === undefined)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'tool call requires exactly one of arguments or argumentParseError',
      });
    }
  });

const toolResult = z
  .object({
    ...eventBase,
    type: z.literal('tool_result'),
    callId: identifier,
    status: z.enum(['success', 'failure', 'cancelled']),
    result: sanitizedPayload.optional(),
    error: sanitizedPayload.optional(),
    durationMs: z.number().int().nonnegative(),
  })
  .strict()
  .superRefine((event, context) => {
    if (event.status === 'success' && event.error !== undefined) {
      context.addIssue({ code: z.ZodIssueCode.custom, message: 'successful tool result cannot include error' });
    }
    if (event.status === 'failure' && event.error === undefined) {
      context.addIssue({ code: z.ZodIssueCode.custom, message: 'failed tool result requires error' });
    }
    if (event.status !== 'success' && event.result !== undefined) {
      context.addIssue({ code: z.ZodIssueCode.custom, message: 'failed or cancelled tool result cannot include result' });
    }
  });

const confirmationRequested = z
  .object({
    ...eventBase,
    type: z.literal('confirmation_requested'),
    confirmationId: identifier,
    callId: identifier.optional(),
    prompt: boundedText,
    payload: sanitizedPayload.optional(),
  })
  .strict();

const confirmationResolved = z
  .object({
    ...eventBase,
    type: z.literal('confirmation_resolved'),
    confirmationId: identifier,
    callId: identifier.optional(),
    resolution: z.enum(['approved', 'rejected', 'cancelled']),
  })
  .strict();

const runError = z
  .object({
    ...eventBase,
    type: z.literal('run_error'),
    stage: identifier,
    message: boundedText,
    code: identifier.optional(),
    retryable: z.boolean().optional(),
    details: sanitizedPayload.optional(),
  })
  .strict();

export const commandJournalEvent = z.discriminatedUnion('type', [
  modelTurn,
  toolCall,
  toolResult,
  confirmationRequested,
  confirmationResolved,
  runError,
]);

export const completion = z
  .object({
    finalAssistantText: boundedText,
    stopReason: identifier,
    usage: tokenUsage.optional(),
    timing: z
      .object({
        totalMs: z.number().int().nonnegative(),
        modelMs: z.number().int().nonnegative().optional(),
        toolsMs: z.number().int().nonnegative().optional(),
      })
      .strict()
      .optional(),
    mutated: z.boolean(),
    navigationTarget: scopeRef.optional(),
  })
  .strict();

export const commandJournalSpec = z
  .object({
    schemaVersion: z.literal(2),
    status: z.enum([
      'running',
      'awaiting_confirmation',
      'succeeded',
      'failed',
      'cancelled',
      'interrupted',
    ]),
    startedAt: z.number().int().nonnegative(),
    completedAt: z.number().int().nonnegative().optional(),
    provider: z
      .object({
        endpoint: z
          .string()
          .url()
          .max(2_048)
          .refine((value) => {
            const url = new URL(value);
            return (
              url.username === '' &&
              url.password === '' &&
              [...url.searchParams.keys()].every((key) => !CREDENTIAL_KEY.test(key))
            );
          }, 'provider endpoint must not contain credentials'),
        mode: identifier,
        model: identifier,
      })
      .strict(),
    request: z.object({ userText: boundedText.min(1) }).strict(),
    primaryScope: scopeRef,
    entityRefs: z
      .array(scopeRef.extend({ relation: z.enum(['referenced', 'mutated']) }).strict())
      .max(500),
    events: z.array(commandJournalEvent).max(MAX_EVENTS),
    completion: completion.optional(),
  })
  .strict()
  .superRefine((spec, context) => {
    const terminal = ['succeeded', 'failed', 'cancelled', 'interrupted'].includes(spec.status);
    if (terminal !== (spec.completedAt !== undefined && spec.completion !== undefined)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'terminal journals require completedAt and completion; active journals forbid them',
      });
    }
    if (spec.completedAt !== undefined && spec.completedAt < spec.startedAt) {
      context.addIssue({ code: z.ZodIssueCode.custom, message: 'completedAt cannot precede startedAt' });
    }

    const eventIds = new Set<string>();
    const modelTurnIds = new Set<string>();
    const callIds = new Set<string>();
    const confirmationCallIds = new Map<string, string | undefined>();
    let pendingConfirmationId: string | undefined;
    for (const [index, event] of spec.events.entries()) {
      if (event.sequence !== index + 1) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['events', index, 'sequence'],
          message: `event sequence must be ${index + 1}`,
        });
      }
      if (eventIds.has(event.id)) {
        context.addIssue({ code: z.ZodIssueCode.custom, path: ['events', index, 'id'], message: 'event id must be unique' });
      }
      eventIds.add(event.id);

      if (pendingConfirmationId !== undefined && event.type !== 'confirmation_resolved') {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['events', index],
          message: 'only confirmation_resolved may follow an outstanding confirmation',
        });
      }

      if (event.type === 'model_turn') {
        modelTurnIds.add(event.id);
      } else if (event.type === 'tool_call') {
        if (!modelTurnIds.has(event.modelTurnId)) {
          context.addIssue({ code: z.ZodIssueCode.custom, path: ['events', index, 'modelTurnId'], message: 'modelTurnId must reference an earlier model_turn' });
        }
        if (callIds.has(event.callId)) {
          context.addIssue({ code: z.ZodIssueCode.custom, path: ['events', index, 'callId'], message: 'callId must be unique' });
        }
        for (const [field, linkedCallId] of [
          ['retryOfCallId', event.retryOfCallId],
          ['dedupedOfCallId', event.dedupedOfCallId],
        ] as const) {
          if (linkedCallId !== undefined && !callIds.has(linkedCallId)) {
            context.addIssue({ code: z.ZodIssueCode.custom, path: ['events', index, field], message: `${field} must reference an earlier tool_call` });
          }
        }
        callIds.add(event.callId);
      } else if (event.type === 'tool_result' && !callIds.has(event.callId)) {
        context.addIssue({ code: z.ZodIssueCode.custom, path: ['events', index, 'callId'], message: 'callId must reference an earlier tool_call' });
      } else if (event.type === 'confirmation_requested') {
        if (confirmationCallIds.has(event.confirmationId)) {
          context.addIssue({ code: z.ZodIssueCode.custom, path: ['events', index, 'confirmationId'], message: 'confirmationId must be unique' });
        }
        if (event.callId !== undefined && !callIds.has(event.callId)) {
          context.addIssue({ code: z.ZodIssueCode.custom, path: ['events', index, 'callId'], message: 'callId must reference an earlier tool_call' });
        }
        if (pendingConfirmationId !== undefined) {
          context.addIssue({ code: z.ZodIssueCode.custom, path: ['events', index, 'confirmationId'], message: 'a confirmation is already awaiting resolution' });
        }
        confirmationCallIds.set(event.confirmationId, event.callId);
        pendingConfirmationId = event.confirmationId;
      } else if (event.type === 'confirmation_resolved') {
        if (!confirmationCallIds.has(event.confirmationId)) {
          context.addIssue({ code: z.ZodIssueCode.custom, path: ['events', index, 'confirmationId'], message: 'confirmationId must reference an earlier confirmation_requested' });
        } else if (pendingConfirmationId !== event.confirmationId) {
          context.addIssue({ code: z.ZodIssueCode.custom, path: ['events', index, 'confirmationId'], message: 'confirmationId is not currently awaiting resolution' });
        } else {
          const requestedCallId = confirmationCallIds.get(event.confirmationId);
          if (event.callId !== requestedCallId) {
            context.addIssue({ code: z.ZodIssueCode.custom, path: ['events', index, 'callId'], message: 'callId must match confirmation_requested linkage' });
          }
          pendingConfirmationId = undefined;
        }
      }
    }
    if (!terminal) {
      const expectedStatus = pendingConfirmationId === undefined ? 'running' : 'awaiting_confirmation';
      if (spec.status !== expectedStatus) {
        context.addIssue({ code: z.ZodIssueCode.custom, path: ['status'], message: `active journal status must be ${expectedStatus}` });
      }
    } else if (pendingConfirmationId !== undefined) {
      context.addIssue({ code: z.ZodIssueCode.custom, path: ['events'], message: 'terminal journal cannot have an unresolved confirmation' });
    }
  });

export type CommandJournalSpec = z.infer<typeof commandJournalSpec>;
export type CommandJournalEvent = z.infer<typeof commandJournalEvent>;
export type CommandJournalCompletion = z.infer<typeof completion>;
export type CommandJournalScopeRef = z.infer<typeof scopeRef>;

const commandJournal: KindModule = {
  name: COMMAND_JOURNAL_KIND,
  descriptor: {
    extends: Base,
    spec: commandJournalSpec,
    fts: (row) => `${row.spec?.request?.userText ?? ''}\n${row.spec?.completion?.finalAssistantText ?? ''}`,
  },
  registerApi: registerCommandJournalApi,
};

function registerCommandJournalApi(server: McpServer, store: Store): void {
  registerWsCommandJournalRead(server, store);
  registerWsCommandJournalOperations(server, store);
}

export default commandJournal;