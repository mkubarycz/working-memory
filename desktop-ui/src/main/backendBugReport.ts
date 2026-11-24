import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { bugReportSection, bugReportTitle, type ChatBugReportDependencies } from './chatBugReport';
import type { ChatBugReportDraft } from '../shared/contracts';
import { TransientBugReports } from './transientBugReports';

export const backendBugReportInputSchema = z.object({
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

export class BackendBugReports extends TransientBugReports {
  create(input: unknown, dependencies: Pick<ChatBugReportDependencies, 'secrets'> & {
    environment: Omit<ChatBugReportDependencies['environment'], 'backendUrl'> & { backendUrl: string | null };
    upgradeFailure: (port: number) => unknown;
  }): ChatBugReportDraft {
    const { description, failure } = backendBugReportInputSchema.parse(input);
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
    return this.keep(draft, failure.instance?.mcpUrl ?? dependencies.environment.backendUrl ?? 'http://127.0.0.1',
      { desktop: { version: dependencies.environment.desktopVersion, build: dependencies.environment.desktopBuild },
        backend: { version: failure.instance?.version ?? 'Unknown (no live backend query)' } });
  }
}
