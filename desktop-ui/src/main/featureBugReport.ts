import { z } from 'zod';
import type { ChatBugReportDependencies } from './chatBugReport';
import { bugReportSection, bugReportTitle } from './chatBugReport';
import type { ChatBugReportDraft } from '../shared/contracts';
import { instanceFeaturesV3Schema } from '../../../control-plane/src/instanceFeatures';

const inputSchema = z.object({
  description: z.string().trim().min(1, 'Describe what went wrong.').max(8000),
  failure: z.object({
    error: z.string().min(1).max(32768), operation: z.string().max(200), capturedAt: z.string().datetime(),
    features: instanceFeaturesV3Schema.nullable(),
    requested: z.object({ feature: z.string().max(80), enabled: z.boolean() }).optional(),
    embeddingsEnabled: z.boolean(),
  }),
});

export async function createFeatureBugReport(
  input: unknown, dependencies: Omit<ChatBugReportDependencies, 'client' | 'diagnostics'> & {
    client: Pick<ChatBugReportDependencies['client'], 'topicCreate'>;
    featureDiagnostics?: unknown;
  },
): Promise<ChatBugReportDraft> {
  const { description, failure } = inputSchema.parse(input);
  dependencies.assertCurrent();
  const section = (heading: string, value: unknown) => bugReportSection(heading, value, dependencies.secrets);
  const body = '# Feature settings bug report\n'
    + section('What was the bug?', description)
    + section('Selected error and feature settings', failure)
    + section('Latest feature operation diagnostics', dependencies.featureDiagnostics ?? 'No container operation was captured.')
    + section('Reporting environment', { ...dependencies.environment, backendUrl: new URL(dependencies.environment.backendUrl).origin });
  const title = bugReportTitle('Feature settings bug', description, dependencies.secrets);
  dependencies.assertCurrent();
  const created = await dependencies.client.topicCreate({ title, body });
  return { id: created.id, title, body };
}
