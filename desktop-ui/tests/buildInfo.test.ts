import { describe, expect, it } from 'vitest';
import { formatDesktopBuildTimestamp } from '../src/renderer/buildInfo';

describe('desktop build identity', () => {
  it('formats the immutable build timestamp for display', () => {
    const label = formatDesktopBuildTimestamp('2026-10-04T01:55:49.000Z', 'en-US');
    expect(label).toContain('Oct');
    expect(label).toContain('55:49');
  });
});
