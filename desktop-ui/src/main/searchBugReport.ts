import { z } from 'zod';
import type { ChatBugReportDependencies } from './chatBugReport';
import { bugReportSection, bugReportTitle } from './chatBugReport';
import type { ChatBugReportDraft } from '../shared/contracts';

export const searchBugReportInputSchema = z.object({
  description: z.string().trim().min(1, 'Describe what went wrong.').max(8000),
  search: z.object({
    prompt: z.string().max(2000),
    context: z.unknown().optional(),
    response: z.object({
      query: z.string(), queries: z.array(z.string()), results: z.array(z.unknown()).max(1000),
      blocks: z.array(z.unknown()).optional(), trace: z.array(z.unknown()).optional(),
      partial: z.boolean().optional(), limited: z.boolean().optional(),
    }).nullable(),
    trace: z.array(z.unknown()).max(1000),
    supportingEvidence: z.string().max(16000).optional(),
    loading: z.boolean(), error: z.string(), notice: z.string(), requestId: z.string().nullable(),
  }),
});

export async function createSearchBugReport(
  input: unknown, dependencies: Omit<ChatBugReportDependencies, 'client' | 'diagnostics'> & {
    client: Pick<ChatBugReportDependencies['client'], 'topicCreate'>;
  },
): Promise<ChatBugReportDraft> {
  const { description, search } = searchBugReportInputSchema.parse(input);
  dependencies.assertCurrent();
  const section = (heading: string, value: unknown, limit?: number) =>
    bugReportSection(heading, value, dependencies.secrets, limit);
  const { results = [], trace: responseTrace, ...response } = search.response ?? {};
  const body = '# Search bug report\n'
    + section('What was the bug?', description)
    + (search.supportingEvidence ? section('Supporting evidence', search.supportingEvidence, 16000) : '')
    + section('Search request', { prompt: search.prompt, context: search.context })
    + section('Search state', { capturedAt: new Date(dependencies.now?.() ?? Date.now()).toISOString(),
      requestId: search.requestId, loading: search.loading, error: search.error, notice: search.notice })
    + section('Search response', { ...response, returnedResults: results.length,
      includedResults: Math.min(results.length, 100), omittedResults: Math.max(0, results.length - 100) })
    + results.slice(0, 100).map((hit, index) => section(`Result ${index + 1}`, hit, 6000)).join('')
    + section('Search activity and timings', search.trace.length ? search.trace : responseTrace ?? [])
    + section('Reporting environment', { ...dependencies.environment, backendUrl: new URL(dependencies.environment.backendUrl).origin });
  const title = bugReportTitle('Search bug', description, dependencies.secrets);
  dependencies.assertCurrent();
  const created = await dependencies.client.topicCreate({ title, body });
  return { id: created.id, title, body };
}
