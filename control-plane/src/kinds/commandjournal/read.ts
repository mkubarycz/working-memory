import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CreationOrderedDocument, DocumentEnvelope, Store } from '../../store.js';
import { asError, asText } from '../toolResult.js';
import { COMMAND_JOURNAL_KIND, type CommandJournalEvent, type CommandJournalSpec } from './index.js';
import { CommandJournal } from './commandJournal.js';

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 100;

const refFilter = z
  .object({
    kind: z.string().min(1).max(256),
    id: z.string().min(1).max(256),
  })
  .strict();

const entityRefFilter = refFilter
  .extend({ relation: z.enum(['referenced', 'mutated']).optional() })
  .strict();

interface CursorPayload {
  version: 1;
  createdAt: number;
  creationSequence: number;
  filterKey: string;
}

interface ReadFilters {
  primaryScope?: z.infer<typeof refFilter>;
  entityRef?: z.infer<typeof entityRefFilter>;
}

function isV2CommandJournal(document: DocumentEnvelope): boolean {
  const spec = document.spec as Partial<CommandJournalSpec>;
  return spec.schemaVersion === 2 &&
    typeof spec.primaryScope === 'object' && spec.primaryScope !== null &&
    Array.isArray(spec.entityRefs) &&
    Array.isArray(spec.events);
}

function filterKey(filters: ReadFilters): string {
  return JSON.stringify({
    primaryScope: filters.primaryScope ?? null,
    entityRef: filters.entityRef ?? null,
  });
}

function encodeCursor(item: CreationOrderedDocument, filters: ReadFilters): string {
  const payload: CursorPayload = {
    version: 1,
    createdAt: item.document.metadata.createdAt,
    creationSequence: item.creationSequence,
    filterKey: filterKey(filters),
  };
  return Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
}

function decodeCursor(cursor: string, filters: ReadFilters): CursorPayload {
  try {
    if (cursor.length > 2_048 || !/^[A-Za-z0-9_-]+$/.test(cursor)) {
      throw new Error('invalid encoding');
    }
    const decoded = Buffer.from(cursor, 'base64url');
    if (decoded.toString('base64url') !== cursor) {
      throw new Error('non-canonical encoding');
    }
    const value = JSON.parse(decoded.toString('utf8')) as Partial<CursorPayload>;
    if (
      value.version !== 1 ||
      !Number.isInteger(value.createdAt) ||
      Number(value.createdAt) < 0 ||
      !Number.isInteger(value.creationSequence) ||
      Number(value.creationSequence) <= 0 ||
      typeof value.filterKey !== 'string'
    ) {
      throw new Error('invalid payload');
    }
    if (value.filterKey !== filterKey(filters)) {
      throw new Error('filter mismatch');
    }
    return value as CursorPayload;
  } catch (error) {
    const reason = error instanceof Error && error.message === 'filter mismatch'
      ? 'it was created for different filters'
      : 'it is not a valid opaque cursor';
    throw new Error(`Malformed cursor: ${reason}.`);
  }
}

function isAfterCursor(item: CreationOrderedDocument, cursor: CursorPayload): boolean {
  return item.document.metadata.createdAt < cursor.createdAt ||
    (item.document.metadata.createdAt === cursor.createdAt && item.creationSequence < cursor.creationSequence);
}

function matchesFilters(document: DocumentEnvelope, filters: ReadFilters): boolean {
  const spec = document.spec as CommandJournalSpec;
  if (
    filters.primaryScope &&
    (spec.primaryScope.kind !== filters.primaryScope.kind || spec.primaryScope.id !== filters.primaryScope.id)
  ) {
    return false;
  }
  if (filters.entityRef) {
    return spec.entityRefs.some((ref) =>
      ref.kind === filters.entityRef!.kind &&
      ref.id === filters.entityRef!.id &&
      (filters.entityRef!.relation === undefined || ref.relation === filters.entityRef!.relation),
    );
  }
  return true;
}

function eventSummaries(events: CommandJournalEvent[]) {
  const results = new Map(
    events
      .filter((event): event is Extract<CommandJournalEvent, { type: 'tool_result' }> => event.type === 'tool_result')
      .map((event) => [event.callId, event.status]),
  );
  return events
    .filter((event): event is Extract<CommandJournalEvent, { type: 'tool_call' }> => event.type === 'tool_call')
    .map((event) => ({
      sequence: event.sequence,
      timestamp: event.timestamp,
      toolName: event.toolName,
      callId: event.callId,
      status: results.get(event.callId) ?? 'pending',
    }));
}

function summarize(document: DocumentEnvelope) {
  const spec = document.spec as CommandJournalSpec;
  return {
    id: document.metadata.id,
    resourceVersion: document.metadata.resourceVersion,
    createdAt: document.metadata.createdAt,
    startedAt: spec.startedAt,
    completedAt: spec.completedAt,
    status: spec.status,
    request: spec.request,
    primaryScope: spec.primaryScope,
    entityRefs: spec.entityRefs,
    completion: spec.completion && {
      finalAssistantText: spec.completion.finalAssistantText,
      stopReason: spec.completion.stopReason,
      mutated: spec.completion.mutated,
      navigationTarget: spec.completion.navigationTarget,
    },
    eventSummaries: eventSummaries(spec.events),
  };
}

export function registerWsCommandJournalRead(server: McpServer, store: Store): void {
  server.registerTool(
    'ws-commandjournal-read',
    {
      title: 'Command Journal: Read History',
      description:
        'Read one full CommandJournal by id, or page global history newest-first. List cursors are opaque and ordered by immutable createdAt then id; renderers may reverse loaded results for chronological display.',
      inputSchema: {
        id: z.string().min(1).optional().describe('Read one full journal for inspection.'),
        limit: z.number().int().min(1).max(MAX_LIMIT).optional(),
        cursor: z.string().min(1).optional(),
        primaryScope: refFilter.optional(),
        entityRef: entityRefFilter.optional(),
      },
    },
    async ({ id, limit, cursor, primaryScope, entityRef }) => {
      if (id !== undefined) {
        if (limit !== undefined || cursor !== undefined || primaryScope !== undefined || entityRef !== undefined) {
          return asError('Command journal id reads cannot be combined with list pagination or filters.');
        }
        const document = store.getDocument({ id, kind: COMMAND_JOURNAL_KIND });
        return asText({
          journal: document?.kind === COMMAND_JOURNAL_KIND && isV2CommandJournal(document)
            ? new CommandJournal(document)
            : null,
        });
      }

      const filters: ReadFilters = { primaryScope, entityRef };
      let decodedCursor: CursorPayload | undefined;
      if (cursor !== undefined) {
        try {
          decodedCursor = decodeCursor(cursor, filters);
        } catch (error) {
          return asError((error as Error).message);
        }
      }

      const pageSize = limit ?? DEFAULT_LIMIT;
      const candidates = store
        .listDocumentsByCreation({ kind: COMMAND_JOURNAL_KIND })
        .filter((item) => isV2CommandJournal(item.document))
        .filter((item) => matchesFilters(item.document, filters))
        .filter((item) => decodedCursor === undefined || isAfterCursor(item, decodedCursor));
      const page = candidates.slice(0, pageSize);
      const nextCursor = candidates.length > pageSize && page.length > 0
        ? encodeCursor(page[page.length - 1], filters)
        : undefined;
      return asText({
        journals: page.map((item) => summarize(item.document)),
        ...(nextCursor === undefined ? {} : { nextCursor }),
      });
    },
  );
}