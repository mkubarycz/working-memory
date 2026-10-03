import { describe, expect, it } from 'vitest';
import {
  filterMentionApps,
  mentionKeyEventAction,
  mentionKeyAction,
  mentionTokenAtCaret,
  replaceMentionToken,
} from '../src/renderer/mentionCompletion';

const apps = [
  { id: 'clarinet-hero' as const, displayName: 'Claranet Hero', icon: 'music' },
  { id: 'banking-app' as const, displayName: 'Banking App', icon: 'credit-card' },
  { id: 'sunset-chess' as const, displayName: 'Sunset Chess', icon: 'symbol-event' },
];

describe('Container App mention completion', () => {
  it.each([
    ['@', 1, ''],
    ['hello @sun', 10, 'sun'],
    ['hello (@bank', 12, 'bank'],
    ['hello, @clar', 12, 'clar'],
    ['@sunset_ch', 10, 'sunset_ch'],
    ['first @banking-app then @sun', 29, 'sun'],
  ])('finds a mention token in %s', (value, caret, query) => {
    expect(mentionTokenAtCaret(value, caret, apps)).toMatchObject({ query });
  });

  it.each([
    ['person@example.com', 18],
    ['identifier_@sun', 15],
    ['dotted.@sun', 11],
    ['path/@sun', 9],
    ['already @banking-app ', 21],
  ])('does not trigger inside a token in %s', (value, caret) => {
    expect(mentionTokenAtCaret(value, caret, apps)).toBeNull();
  });

  it('filters case-insensitively across ids, separators, and display names', () => {
    expect(filterMentionApps(apps, '').map((app) => app.id)).toEqual(apps.map((app) => app.id));
    expect(filterMentionApps(apps, 'BANKING_APP').map((app) => app.id)).toEqual(['banking-app']);
    expect(filterMentionApps(apps, 'sunset ch').map((app) => app.id)).toEqual(['sunset-chess']);
    expect(filterMentionApps(apps, 'Claranet Hero').map((app) => app.id)).toEqual(['clarinet-hero']);
    expect(filterMentionApps(apps, 'missing')).toEqual([]);
  });

  it('closes after a complete display-name alias so Enter submits router-valid prose', () => {
    const value = '@Sunset Chess show games';
    expect(mentionTokenAtCaret(value, value.length, apps)).toBeNull();
    expect(mentionKeyAction('Enter', false, 0, 0)).toEqual({ type: 'send' });
  });

  it('replaces only the current token and returns the exact new caret', () => {
    const value = 'compare @banking with @sunset_chess today';
    const caret = value.indexOf('_chess');
    const token = mentionTokenAtCaret(value, caret, apps);
    expect(token).not.toBeNull();
    expect(replaceMentionToken(value, token!, 'sunset-chess')).toEqual({
      value: 'compare @banking with @sunset-chess  today',
      caret: 36,
    });
  });

  it('preserves text before and after a mid-message mention', () => {
    const value = 'before (@banking_app) after';
    const token = mentionTokenAtCaret(value, value.indexOf(') after'), apps)!;
    expect(replaceMentionToken(value, token, 'banking-app')).toEqual({
      value: 'before (@banking-app ) after',
      caret: 21,
    });
  });

  it('wraps keyboard navigation and separates selection, dismissal, and sending', () => {
    expect(mentionKeyAction('ArrowDown', true, 3, 2)).toEqual({ type: 'navigate', index: 0 });
    expect(mentionKeyAction('ArrowUp', true, 3, 0)).toEqual({ type: 'navigate', index: 2 });
    expect(mentionKeyAction('Enter', true, 3, 1)).toEqual({ type: 'select', index: 1 });
    expect(mentionKeyAction('Tab', true, 3, 1)).toEqual({ type: 'select', index: 1 });
    expect(mentionKeyAction('Escape', true, 3, 1)).toEqual({ type: 'dismiss' });
    expect(mentionKeyAction('Enter', false, 0, 0)).toEqual({ type: 'send' });
    expect(mentionKeyAction('Enter', true, 0, 0)).toEqual({ type: 'none' });
  });

  it('leaves Shift+Enter untouched at the event level while the popup is open', () => {
    let prevented = false;
    const action = mentionKeyEventAction({
      key: 'Enter',
      shiftKey: true,
      preventDefault: () => { prevented = true; },
    }, true, 3, 1);

    expect(action).toEqual({ type: 'none' });
    expect(prevented).toBe(false);
  });
});
