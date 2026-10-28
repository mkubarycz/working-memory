declare const __WM_BUILD_TIMESTAMP__: string;
import type { DesktopBuildInfo } from '../shared/contracts';

export function desktopBuildLabel(info: DesktopBuildInfo | null, timestamp: string, locales?: Intl.LocalesArgument): string {
  if (info && !info.development && /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/.test(info.version)
    && !/(?:^|[.-])dev(?:[.-]|$)/i.test(info.version)) {
    return `Version ${info.version}`;
  }
  return `Built ${formatDesktopBuildTimestamp(timestamp, locales)}`;
}

export const DESKTOP_BUILD_TIMESTAMP =
  typeof __WM_BUILD_TIMESTAMP__ === 'string'
    ? __WM_BUILD_TIMESTAMP__
    : '1970-01-01T00:00:00.000Z';

export function formatDesktopBuildTimestamp(
  timestamp: string,
  locales?: Intl.LocalesArgument,
): string {
  return new Intl.DateTimeFormat(locales, {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
    second: '2-digit',
  }).format(new Date(timestamp));
}
