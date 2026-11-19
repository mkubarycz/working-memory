import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { bugReportSection, bugReportTitle, type ChatBugReportDependencies } from './chatBugReport';
import type { ChatBugReportDraft, FeedbackContext, SharedTopicReceipt } from '../shared/contracts';

const inputSchema = z.object({
  description: z.string().trim().min(1, 'Describe what went wrong.').max(8000),
  failure: z.object({
    error: z.string().min(1).max(32768), operation: z.string().max(200), capturedAt: z.string().datetime(),
    provider: z.enum(['docker', 'podman']),
    instance: z.object({
      port: z.number().int().min(1).max(65535), name: z.string(), container: z.string(),
      mcpUrl: z.string().url(), state: z.string(), version: z.string().nullable(),
    }).passthrough().nullable(),
    backendChannel: z.enum(['off', 'stable', 'canary']).nullable(),
    backendTarget: z.object({ version: z.string(), image: z.string() }).nullable(),
  }),
});

export class BackendBugReports {
  private latest: { draft: ChatBugReportDraft; sourceUrl: string; context: FeedbackContext } | undefined;

  create(input: unknown, dependencies: Pick<ChatBugReportDependencies, 'secrets'> & {
    environment: Omit<ChatBugReportDependencies['environment'], 'backendUrl'> & { backendUrl: string | null };
    upgradeFailure: (port: number) => unknown;
  }): ChatBugReportDraft {
    const { description, failure } = inputSchema.parse(input);
    const section = (heading: string, value: unknown) => bugReportSection(heading, value, dependencies.secrets);
    const body = '# Backend settings bug report\n'
      + section('What was the bug?', description)
      + section('Selected error and backend settings', failure)
      + section('Latest failed upgrade for this port', failure.instance
        ? dependencies.upgradeFailure(failure.instance.port) ?? 'No upgrade failure captured on this desktop.'
        : 'No instance selected.')
      + section('Reporting environment', { ...dependencies.environment,
        backendUrl: dependencies.environment.backendUrl ? new URL(dependencies.environment.backendUrl).origin : null });
    const draft = { id: randomUUID(), title: bugReportTitle('Backend settings bug', description, dependencies.secrets), body, sessionOnly: true };
    this.latest = { draft, sourceUrl: failure.instance?.mcpUrl ?? dependencies.environment.backendUrl ?? 'http://127.0.0.1',
      context: { desktop: { version: dependencies.environment.desktopVersion, build: dependencies.environment.desktopBuild },
        backend: { version: failure.instance?.version ?? 'Unknown (no live backend query)' } } };
    return { ...draft };
  }

  feedbackSource(id: string) {
    const report = this.latest;
    if (!report || report.draft.id !== id) return undefined;
    return {
      topic: { title: report.draft.title, body: report.draft.body }, sourceUrl: report.sourceUrl, context: report.context,
      recordReceipt: async (receipt: SharedTopicReceipt) => {
        if (!report.draft.body.includes(receipt.statusUrl)) {
          report.draft.body += `\n\nFeedback sent on ${receipt.submittedAt}. [Check status](${receipt.statusUrl})`;
        }
      },
    };
  }
}
