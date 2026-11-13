import { z } from 'zod';
import type { CommandJournal, ControlPlaneClient } from '../../../shared/controlPlaneClient';
import type { ChatBugReportDraft, ChatBugReportInput } from '../shared/contracts';
import { sanitizeForJournal, sanitizeForJournalWithMetadata } from './desktopChatAgent';

const scope = z.object({ kind: z.string().max(100), id: z.string().max(1000), title: z.string().max(10000).optional() });
const inputSchema: z.ZodType<ChatBugReportInput> = z.object({
  description: z.string().trim().min(1, 'Describe what went wrong.').max(8000),
  run: z.object({
    key: z.string().min(1).max(1000), journalId: z.string().min(1).max(1000).optional(),
    resourceVersion: z.number().int().nonnegative().optional(),
    status: z.enum(['submitting', 'running', 'awaiting_confirmation', 'succeeded', 'failed', 'cancelled', 'interrupted']),
    startedAt: z.number().finite().nonnegative(), completedAt: z.number().finite().nonnegative().optional(),
    userText: z.string().max(1_000_000), assistantText: z.string().max(1_000_000).optional(), scope,
    attachments: z.array(z.object({ id: z.string().max(1000), filename: z.string().max(10000), mimeType: z.string().max(1000) })).max(1000),
    progress: z.array(z.object({ name: z.string().max(1000), status: z.enum(['completed', 'failed', 'cancelled']), summary: z.string().max(10000) })).max(10000).optional(),
    pendingConfirmation: z.object({
      id: z.string().max(1000), tool: z.string().max(1000), arguments: z.record(z.string(), z.unknown()),
      batchCount: z.number().int().nonnegative().optional(),
      batchActions: z.array(z.object({
        tool: z.string().max(1000), count: z.number().int().nonnegative(),
        summary: z.string().max(10000), arguments: z.record(z.string(), z.unknown()),
      })).max(1000).optional(),
    }).optional(),
    unpersistedResult: z.boolean().optional(),
  }),
  renderer: z.object({ conversationBlocked: z.boolean(), localRequestActive: z.boolean() }),
});

export interface ChatBugReportDependencies {
  client: Pick<ControlPlaneClient, 'commandJournalRead' | 'topicCreate'>;
  environment: { desktopVersion: string; desktopBuild: string; backendUrl: string; platform: string; arch: string; processId: number };
  diagnostics: (journalId?: string) => unknown;
  secrets: string[];
  assertCurrent: () => void;
  now?: () => number;
}

function reportText(value: string): string {
  return value
    .replace(/\bBasic\s+[A-Za-z0-9+/]+=*/gi, 'Basic [redacted]')
    .replace(/\bsk-[A-Za-z0-9_-]{8,}/g, '[redacted]')
    .replace(/(https?:\/\/)[^\s/?#]*@/gi, '$1[redacted]@')
    .replace(/wm-attachment:/gi, 'wm-attachment (reference):');
}

function omitReportMedia(value: unknown): unknown {
  const seen = new WeakSet<object>();
  const visit = (candidate: unknown, depth = 0, preview = false): unknown => {
    if (depth > 32) return '[Deep evidence omitted before media filtering]';
    if (typeof candidate === 'string') {
      if (/^\s*[{["]/.test(candidate)) {
        if (candidate.length > 60_000) return '[Oversized serialized evidence omitted before media filtering]';
        let parsed: unknown;
        try { parsed = JSON.parse(candidate); } catch {
          if (preview || /"(?:blob|mimeType)"\s*:|"type"\s*:\s*"(?:image|audio|video|resource|blob)"/i.test(candidate)) {
            return '[Incomplete serialized media/preview omitted before capture]';
          }
        }
        if (parsed !== undefined) return JSON.stringify(visit(parsed, depth + 1));
      }
      return /\bdata:[^,\s]*,/i.test(candidate) ? '[Inline data URI omitted before capture]' : reportText(candidate);
    }
    if (!candidate || typeof candidate !== 'object') return candidate;
    if (seen.has(candidate)) return '[Repeated/circular evidence omitted before media filtering]';
    seen.add(candidate);
    if (Array.isArray(candidate)) {
      return [...candidate.slice(0, 1000).map(child => visit(child, depth + 1)),
        ...(candidate.length > 1000 ? ['[Remaining items omitted before media filtering]'] : [])];
    }
    const record = candidate as Record<string, unknown>;
    const entries = Object.entries(record);
    if (entries.length > 1000) return '[Oversized object omitted before media filtering]';
    const mimeType = typeof record.mimeType === 'string' ? record.mimeType : '';
    const media = Boolean(mimeType) || /^(?:image|audio|video|blob)$/i.test(String(record.type));
    const binaryText = mimeType && !/^(?:text\/|application\/(?:json|xml|yaml)(?:$|;))/i.test(mimeType);
    return Object.fromEntries(entries.map(([key, child]) => [
      key,
      key === 'blob' || key === 'data' && media || key === 'text' && binaryText
        ? '[Inline media payload omitted; reference metadata retained]'
        : visit(child, depth + 1, key === 'preview' && record.truncated === true),
    ]));
  };
  return visit(value);
}

export function buildChatBugReport(
  input: ChatBugReportInput, journal: CommandJournal | null, dependencies: Omit<ChatBugReportDependencies, 'client' | 'assertCurrent'>,
): Omit<ChatBugReportDraft, 'id'> {
  const now = dependencies.now?.() ?? Date.now();
  const section = (heading: string, value: unknown, limit = 32768): string => {
    const sanitized = sanitizeForJournalWithMetadata(omitReportMedia(value), dependencies.secrets);
    const text = reportText(typeof sanitized.value === 'string' ? sanitized.value : JSON.stringify(sanitized.value, null, 2));
    const truncated = sanitized.truncated || text.length > limit;
    return `\n## ${heading}\n\n${text.slice(0, limit).split('\n').map(line => `    ${line}`).join('\n')}\n`
      + (truncated ? '\n[Evidence truncated at the diagnostic size limit.]\n' : '');
  };
  const events = journal?.events ?? [];
  const shareableEvents = events.filter(event => event.type !== 'model_turn' || event.role === 'assistant');
  const last = events.at(-1);
  const response = input.run.assistantText ?? journal?.completion?.finalAssistantText
    ?? events.filter((event): event is Extract<CommandJournal['events'][number], { type: 'model_turn' }> => event.type === 'model_turn' && event.role === 'assistant')
      .reverse().find(event => event.assistantText)?.assistantText;
  let body = '# Chat message bug report\n'
    + section('What was the bug?', input.description)
    + section('Message and last activity', {
      capturedAt: new Date(now).toISOString(), journalId: journal?.id ?? input.run.journalId ?? 'Not available yet',
      rendererStatus: input.run.status, persistedStatus: journal?.status ?? 'No journal captured',
      resourceVersion: journal?.resourceVersion, rendererResourceVersion: input.run.resourceVersion,
      startedAtMs: input.run.startedAt, completedAtMs: journal?.completedAt ?? input.run.completedAt,
      elapsedMs: Math.max(0, now - input.run.startedAt),
      persistedUpdatedAtSeconds: journal?.updatedAt, lastEventAtMs: last?.timestamp,
      sinceLastEventMs: last ? Math.max(0, now - last.timestamp) : undefined,
      scope: journal?.primaryScope ?? input.run.scope, entityRefs: journal?.entityRefs,
      provider: journal?.provider, completion: journal?.completion,
    })
    + section('Prompt', input.run.userText)
    + section('Response or partial response', response ?? 'No assistant response is available.')
    + section('Renderer state', { ...input.renderer, progress: input.run.progress,
      pendingConfirmation: input.run.pendingConfirmation, unpersistedResult: input.run.unpersistedResult })
    + section('Local run diagnostics', dependencies.diagnostics(input.run.journalId))
    + section('Reporting environment', { ...dependencies.environment, backendUrl: new URL(dependencies.environment.backendUrl).origin })
    + section('Prompt attachments (references only; image bytes are not shared)', input.run.attachments);
  const eventSections: string[] = [];
  let remaining = 900_000 - body.length - 1000;
  for (const event of shareableEvents.slice(-100).reverse()) {
    const evidence = event.type === 'model_turn'
      ? { ...event, contentParts: event.contentParts?.filter(part => part.type === 'text') } : event;
    const text = section(`Event ${event.sequence}: ${event.type}`, evidence, 6000);
    if (text.length > remaining) break;
    remaining -= text.length;
    eventSections.unshift(text);
  }
  body += '\n## Journal logs, model responses and tool calls/results\n\n'
    + `Showing the latest ${eventSections.length} of ${shareableEvents.length} shareable events. `
    + (shareableEvents.length > eventSections.length ? `${shareableEvents.length - eventSections.length} older events omitted.\n` : '\n')
    + (events.length > shareableEvents.length ? `${events.length - shareableEvents.length} internal system events excluded.\n` : '')
    + 'General application/backend log files, other conversations, credentials and hidden model reasoning are not collected.\n'
    + eventSections.join('');
  const title = reportText(`Chat bug: ${String(sanitizeForJournal(omitReportMedia(input.description), dependencies.secrets)).split('\n')[0]}`).slice(0, 120);
  return { title, body };
}

export async function createChatBugReport(input: unknown, dependencies: ChatBugReportDependencies): Promise<ChatBugReportDraft> {
  const parsed = inputSchema.parse(input);
  dependencies.assertCurrent();
  const journal = parsed.run.journalId ? await dependencies.client.commandJournalRead({ id: parsed.run.journalId }) : null;
  if (parsed.run.journalId && !journal) throw new Error('The selected message journal is unavailable. Refresh the message and try again.');
  dependencies.assertCurrent();
  const report = buildChatBugReport(parsed, journal, dependencies);
  const created = await dependencies.client.topicCreate(report);
  return { id: created.id, ...report };
}
