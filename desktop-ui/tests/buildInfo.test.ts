import { describe, expect, it } from 'vitest';
import { desktopBuildLabel, formatDesktopBuildTimestamp } from '../src/renderer/buildInfo';

describe('desktop build identity', () => {
  it.each(['1.2.0-build.80', '1.3.0', '1.3.0-rc.1'])('displays the exact installed numbered version %s', version => {
    expect(desktopBuildLabel({ version, development: false }, '2026-10-04T01:55:49.000Z')).toBe(`Version ${version}`);
  });
  it.each([
    { version: '1.2.0', development: true },
    { version: '1.3.0-dev.1', development: false },
    { version: 'development', development: false },
    null,
  ])('keeps build time for a development build or pending metadata: %j', info => {
    expect(desktopBuildLabel(info, '2026-10-04T01:55:49.000Z', 'en-US')).toMatch(/^Built .*Oct.*55:49/);
  });
  it('formats the immutable build timestamp for display', () => {
    const label = formatDesktopBuildTimestamp('2026-10-04T01:55:49.000Z', 'en-US');
    expect(label).toContain('Oct');
    expect(label).toContain('55:49');
  });
});
