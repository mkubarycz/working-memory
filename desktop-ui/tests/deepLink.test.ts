import { describe, expect, it } from 'vitest';
import {
  desktopDeepLink,
  parseDesktopDeepLink,
} from '../src/shared/deepLink';

describe('desktop Working Memory deep links', () => {
  it('builds and parses resource links', () => {
    const link = desktopDeepLink('topic', 'design notes');
    expect(link).toBe('working-memory://open/topic/design%20notes');
    expect(parseDesktopDeepLink(link)).toEqual({
      kind: 'topic',
      identifier: 'design notes',
    });
  });

  it('supports identifiers containing slashes', () => {
    expect(parseDesktopDeepLink(
      'working-memory://open/document/id%2Fwith%20spaces',
    )).toEqual({
      kind: 'document',
      identifier: 'id/with spaces',
    });
  });

  it('rejects unsupported routes, kinds, and extra URL state', () => {
    expect(parseDesktopDeepLink('vscode://kubarycz.working-memory/open/topic/one')).toBeNull();
    expect(parseDesktopDeepLink('working-memory://edit/topic/one')).toBeNull();
    expect(parseDesktopDeepLink('working-memory://open/session/one')).toBeNull();
    expect(parseDesktopDeepLink('working-memory://open/topic/one?unexpected=true')).toBeNull();
  });
});
