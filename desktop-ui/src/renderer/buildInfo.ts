declare const __WM_BUILD_TIMESTAMP__: string;

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
