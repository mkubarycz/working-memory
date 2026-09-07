import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { type Store, ConflictError, NotFoundError } from '../../store.js';
import { defaultStatus, validateSpec } from '../registry.js';
import { asError, asText } from '../toolResult.js';
import {
  COMMAND_JOURNAL_KIND,
  commandJournalEvent,
  completion,
  scopeRef,
  type CommandJournalEvent,
} from './index.js';
import { CommandJournal } from './commandJournal.js';

const provider = z
  .object({
    endpoint: z.string().url().max(2_048),
    mode: z.string().min(1).max(256),
    model: z.string().min(1).max(256),
  })
  .strict();

const terminalStatus = z.enum(['succeeded', 'failed', 'cancelled', 'interrupted']);

function existingJournal(store: Store, id: string) {
  const existing = store.getDocument({ id, kind: COMMAND_JOURNAL_KIND });
  return existing?.kind === COMMAND_JOURNAL_KIND ? existing : null;
}

function conflictMessage(id: string, current: number): string {
  return `Conflict: command journal "${id}" changed since it was read (current resourceVersion ${current}).`;
}

function statusAfterAppend(events: CommandJournalEvent[]): 'running' | 'awaiting_confirmation' {
  let awaiting = false;
  for (const event of events) {
    if (event.type === 'confirmation_requested') {
      awaiting = true;
    } else if (event.type === 'confirmation_resolved') {
      awaiting = false;
    }
  }
  return awaiting ? 'awaiting_confirmation' : 'running';
}

function mergeEntityRefs(existing: unknown, discovered: z.infer<typeof scopeRef>[] & Array<{ relation: 'referenced' | 'mutated' }>) {
  const merged = new Map<string, Record<string, unknown>>();
  for (const ref of [...((existing as Record<string, unknown>[]) ?? []), ...discovered]) {
    const key = `${ref.kind}\u0000${ref.id}\u0000${ref.relation}`;
    merged.set(key, { ...merged.get(key), ...ref });
  }
  return [...merged.values()];
}

export function registerWsCommandJournalOperations(server: McpServer, store: Store): void {
  server.registerTool(
    'ws-commandjournal-create',
    {
      title: 'Command Journal: Create Run',
      description: 'Create one running CommandJournal for one submitted user request. Returns the created journal.',
      inputSchema: {
        startedAt: z.number().int().nonnegative(),
        provider,
        request: z.object({ userText: z.string().min(1).max(32_768) }).strict(),
        primaryScope: scopeRef,
        entityRefs: z.array(scopeRef.extend({ relation: z.enum(['referenced', 'mutated']) }).strict()).max(500).optional(),
      },
    },
    async ({ startedAt, provider, request, primaryScope, entityRefs }) => {
      try {
        const spec = validateSpec(COMMAND_JOURNAL_KIND, {
          schemaVersion: 2,
          status: 'running',
          startedAt,
          provider,
          request,
          primaryScope,
          entityRefs: entityRefs ?? [],
          events: [],
        });
        const created = store.createDocument({
          kind: COMMAND_JOURNAL_KIND,
          spec,
          status: defaultStatus(COMMAND_JOURNAL_KIND),
        });
        return asText(new CommandJournal(created));
      } catch (error) {
        return asError((error as Error).message);
      }
    },
  );

  server.registerTool(
    'ws-commandjournal-append',
    {
      title: 'Command Journal: Append Events',
      description: 'Atomically append one or more ordered events using resourceVersion compare-and-swap. Sequences must continue canonically.',
      inputSchema: {
        id: z.string().min(1),
        expectedResourceVersion: z.number().int().nonnegative(),
        events: z.array(commandJournalEvent).min(1).max(1_000),
        entityRefs: z.array(scopeRef.extend({ relation: z.enum(['referenced', 'mutated']) }).strict()).max(500).optional(),
      },
    },
    async ({ id, expectedResourceVersion, events, entityRefs }) => {
      const existing = existingJournal(store, id);
      if (!existing) {
        return asError(`Unknown command journal id: "${id}".`);
      }
      if (existing.metadata.resourceVersion !== expectedResourceVersion) {
        return asError(conflictMessage(id, existing.metadata.resourceVersion));
      }
      if (!['running', 'awaiting_confirmation'].includes(String(existing.spec.status))) {
        return asError(`Command journal "${id}" is terminal and cannot accept events.`);
      }
      try {
        const appendedEvents = [...(existing.spec.events as CommandJournalEvent[]), ...events];
        const nextSpec = validateSpec(COMMAND_JOURNAL_KIND, {
          ...existing.spec,
          status: statusAfterAppend(appendedEvents),
          events: appendedEvents,
          entityRefs: entityRefs === undefined
            ? existing.spec.entityRefs
            : mergeEntityRefs(existing.spec.entityRefs, entityRefs),
        });
        const updated = store.updateDocument({ id, expectedResourceVersion, spec: nextSpec });
        return asText(new CommandJournal(updated));
      } catch (error) {
        if (error instanceof ConflictError) {
          return asError(conflictMessage(id, error.currentResourceVersion));
        }
        if (error instanceof NotFoundError) {
          return asError(`Unknown command journal id: "${id}".`);
        }
        return asError((error as Error).message);
      }
    },
  );

  server.registerTool(
    'ws-commandjournal-finalize',
    {
      title: 'Command Journal: Finalize Run',
      description: 'Finalize an active CommandJournal exactly once using resourceVersion compare-and-swap.',
      inputSchema: {
        id: z.string().min(1),
        expectedResourceVersion: z.number().int().nonnegative(),
        status: terminalStatus,
        completedAt: z.number().int().nonnegative(),
        completion,
        entityRefs: z.array(scopeRef.extend({ relation: z.enum(['referenced', 'mutated']) }).strict()).max(500).optional(),
      },
    },
    async ({ id, expectedResourceVersion, status, completedAt, completion, entityRefs }) => {
      const existing = existingJournal(store, id);
      if (!existing) {
        return asError(`Unknown command journal id: "${id}".`);
      }
      if (existing.metadata.resourceVersion !== expectedResourceVersion) {
        return asError(conflictMessage(id, existing.metadata.resourceVersion));
      }
      if (!['running', 'awaiting_confirmation'].includes(String(existing.spec.status))) {
        return asError(`Command journal "${id}" is already terminal.`);
      }
      try {
        const nextSpec = validateSpec(COMMAND_JOURNAL_KIND, {
          ...existing.spec,
          status,
          completedAt,
          completion,
          entityRefs: entityRefs === undefined
            ? existing.spec.entityRefs
            : mergeEntityRefs(existing.spec.entityRefs, entityRefs),
        });
        const updated = store.updateDocument({ id, expectedResourceVersion, spec: nextSpec });
        return asText(new CommandJournal(updated));
      } catch (error) {
        if (error instanceof ConflictError) {
          return asError(conflictMessage(id, error.currentResourceVersion));
        }
        if (error instanceof NotFoundError) {
          return asError(`Unknown command journal id: "${id}".`);
        }
        return asError((error as Error).message);
      }
    },
  );
}