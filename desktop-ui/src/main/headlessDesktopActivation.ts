import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { parseDesktopDeepLink } from '../shared/deepLink';

const execute = promisify(execFile);

interface ActivationEvents {
  on(event: 'activate', listener: () => void): unknown;
  on(event: 'open-url', listener: (event: { preventDefault(): void }, url: string) => void): unknown;
}

export async function launchDesktopApplication(bundle: string, application: string, url?: string): Promise<void> {
  await execute('/usr/bin/open', ['-na', bundle, '--args', application, ...(url ? [url] : [])]);
}

export function registerHeadlessDesktopActivation(
  application: ActivationEvents,
  launch: (url?: string) => Promise<void>,
  reportError: (error: unknown) => void,
): void {
  application.on('activate', () => { void launch().catch(reportError); });
  application.on('open-url', (event, url) => {
    if (!parseDesktopDeepLink(url)) return;
    event.preventDefault();
    void launch(url).catch(reportError);
  });
}
