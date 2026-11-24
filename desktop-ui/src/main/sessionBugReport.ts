import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { instanceFeaturesV4Schema } from '../../../control-plane/src/instanceFeatures';
import { backendBugReportInputSchema } from './backendBugReport';
import { buildChatBugReport, bugReportSection, bugReportTitle, chatBugReportInputSchema, type ChatBugReportDependencies } from './chatBugReport';
import { featureBugReportInputSchema } from './featureBugReport';
import { searchBugReportInputSchema } from './searchBugReport';
import { TransientBugReports } from './transientBugReports';

const healthState = z.enum(['unknown', 'healthy', 'degraded', 'unreachable']);
export const sessionBugReportInputSchema = z.object({
  renderer: z.object({
    capturedAt: z.string().datetime(), screen: z.string().max(200), authenticated: z.boolean(),
    backendHealth: z.object({ state: z.enum(['healthy', 'unreachable']), endpoint: z.string().max(4000),
      result: z.string().max(32768), observedAt: z.number(), source: z.string().max(100) }).nullable(),
    aiHealth: z.object({ state: healthState, result: z.string().max(32768), observedAt: z.number() }),
    features: instanceFeaturesV4Schema.partial({ topicPlacementAutoLoad: true }),
    openDocuments: z.number().int().nonnegative(), activeChatContexts: z.number().int().nonnegative(),
    errors: z.record(z.string().max(100), z.string().max(32768)),
  }),
  operation: z.discriminatedUnion('kind', [
    z.object({ kind: z.literal('chat'), input: chatBugReportInputSchema.omit({ description: true }), toolDetail: z.unknown().optional() }),
    z.object({ kind: z.literal('search'), search: searchBugReportInputSchema.shape.search }),
    z.object({ kind: z.literal('placement'), search: searchBugReportInputSchema.shape.search }),
    z.object({ kind: z.literal('features'), failure: featureBugReportInputSchema.shape.failure }),
    z.object({ kind: z.literal('backend'), failure: backendBugReportInputSchema.shape.failure }),
  ]).nullable(),
});

type Dependencies = Pick<ChatBugReportDependencies, 'secrets' | 'diagnostics'> & {
  environment: Omit<ChatBugReportDependencies['environment'], 'backendUrl'> & { backendUrl: string | null };
  uptimeSeconds: number;
  featureDiagnostics?: unknown;
  upgradeFailure: (port: number) => unknown;
};

export class SessionBugReports extends TransientBugReports {
  private captured: { id: string; evidence: string; secrets: string[] } | undefined;

  capture(input: unknown, dependencies: Dependencies) {
    const { renderer, operation } = sessionBugReportInputSchema.parse(input);
    const backendUrl = dependencies.environment.backendUrl;
    const sourceUrl = backendUrl ? new URL(backendUrl).origin : 'http://127.0.0.1';
    const section = (heading: string, value: unknown) => bugReportSection(heading, value, dependencies.secrets);
    let evidence = section('Reporting environment', { ...dependencies.environment, backendUrl: backendUrl ? sourceUrl : null,
      uptimeSeconds: dependencies.uptimeSeconds })
      + section('Desktop session snapshot', renderer)
      + section('Local work diagnostics', dependencies.diagnostics());
    if (operation?.kind === 'chat') {
      evidence += buildChatBugReport({ ...operation.input, description: 'Selected chat message evidence' }, null, {
        ...dependencies, environment: { ...dependencies.environment, backendUrl: sourceUrl },
        now: () => Date.parse(renderer.capturedAt),
      }).body;
      if (operation.toolDetail) evidence += section('Selected tool details', operation.toolDetail);
      evidence += '\nOnly the displayed message snapshot is included; no journal or conversation is fetched.\n';
    } else if (operation?.kind === 'search' || operation?.kind === 'placement') {
      evidence += section(`Selected ${operation.kind} operation`, operation.search);
    } else if (operation?.kind === 'features') {
      evidence += section('Selected feature operation', operation.failure)
        + section('Feature operation diagnostics', dependencies.featureDiagnostics ?? 'No feature failure captured in this environment.');
    } else if (operation?.kind === 'backend') {
      evidence += section('Selected backend operation', operation.failure)
        + section('Failed upgrade diagnostics', operation.failure.instance
          ? dependencies.upgradeFailure(operation.failure.instance.port) ?? 'No failed upgrade captured for this port.'
          : 'No instance selected.');
    } else evidence += '\nNo operation is selected. No document or conversation content was collected.\n';
    const id = randomUUID();
    this.captured = { id, evidence, secrets: [...dependencies.secrets] };
    return this.keep({ id, title: 'Session bug report', body: `# Desktop session bug report\n${evidence}`, sessionOnly: true },
      backendUrl ?? sourceUrl, {
        desktop: { version: dependencies.environment.desktopVersion, build: dependencies.environment.desktopBuild },
        backend: { version: 'Unknown (session snapshot; no live backend query)' },
      });
  }

  describe(id: unknown, description: unknown) {
    const parsedId = z.string().uuid().parse(id);
    const text = z.string().trim().min(1, 'Describe what went wrong.').max(8000).parse(description);
    const captured = this.captured;
    const report = this.latest;
    if (!captured || !report || captured.id !== parsedId || report.draft.id !== parsedId) {
      throw new Error('The session snapshot is no longer available. Reopen Report Bug.');
    }
    report.draft.title = bugReportTitle('Session bug', text, captured.secrets);
    report.draft.body = '# Desktop session bug report\n'
      + bugReportSection('What was the bug?', text, captured.secrets) + captured.evidence;
    return { ...report.draft };
  }
}
