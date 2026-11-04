import { describe, expect, it } from 'vitest';
import {
  desktopDeepLink,
  parseDesktopDeepLink,
  parseDesktopResourceLink,
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

  it.each([
    'working-memory://open/topic/case%2F123',
    'http://127.0.0.1:7718/open/topic/case%2F123',
    'http://localhost:7718/open/topic/case%2F123',
    'vscode://kubarycz.working-memory/open/topic/case%2F123',
    'working-memory:/topic/case%2F123.working-memory',
    'working-memory://topic/case%2F123.working-memory',
    '/topic/case%2F123.working-memory',
  ])('routes authored link %s to the same local resource', link => {
    expect(parseDesktopResourceLink(link)).toEqual({ kind: 'topic', identifier: 'case/123' });
  });

  it.each(['workstream', 'topic', 'document', 'agent-message', 'topic-type', 'alert'])(
    'supports authored %s references and canonicalizes alerts', kind => {
      expect(parseDesktopResourceLink(`http://127.0.0.1:7718/open/${kind}/id`))
        .toEqual({ kind: kind === 'alert' ? 'agent-message' : kind, identifier: 'id' });
    },
  );

  it.each([
    'https://example.com/open/topic/id',
    'http://127.0.0.1:7717/open/topic/id',
    'http://127.0.0.1:7718.evil.test/open/topic/id',
    'http://user@127.0.0.1:7718/open/topic/id',
    'http://127.0.0.1:7718/open/topic/id?extra=1',
    'http://127.0.0.1:7718/open/topic/id#extra',
    'http://127.0.0.1:7718/open/topic/%ZZ',
    'http://127.0.0.1:7718/open/config/id',
    'working-memory://other/open/topic/id',
    'javascript:alert(1)',
  ])('does not treat unrelated or invalid URL %s as a local resource', link => {
    expect(parseDesktopResourceLink(link)).toBeNull();
  });
});
