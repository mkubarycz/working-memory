/**
 * WM 14.2.1: unit coverage for the pure view-dispatch + topic-type
 * customization core of the unified `.working-memory` document editor. This
 * module imports NO Svelte and NO VS Code APIs, so it's tested directly.
 */

import { describe, test, expect } from 'vitest';
import {
  resolveView,
  getTopicTypeConfig,
  iconForTopic,
  FALLBACK_TOPIC_ICON,
} from '../webview-ui/src/lib/viewRegistry';

describe('resolveView', () => {
  test('maps bespoke kinds to their view id', () => {
    expect(resolveView('workstream')).toBe('workstream');
    expect(resolveView('topic')).toBe('topic');
  });

  test('falls back to generic for any other/unknown kind', () => {
    expect(resolveView('alert')).toBe('generic');
    expect(resolveView('topic-type')).toBe('generic');
    expect(resolveView('Nanite')).toBe('generic');
    expect(resolveView('')).toBe('generic');
  });
});

describe('getTopicTypeConfig', () => {
  test('returns an empty config for an unregistered type', () => {
    expect(getTopicTypeConfig('feature')).toEqual({});
    expect(getTopicTypeConfig('does-not-exist')).toEqual({});
  });
});

describe('iconForTopic', () => {
  test('uses the non-empty control-plane icon when no registry override', () => {
    expect(iconForTopic('feature', 'rocket')).toBe('rocket');
  });

  test('falls back when the control-plane icon is null/undefined', () => {
    expect(iconForTopic('feature', null)).toBe(FALLBACK_TOPIC_ICON);
    expect(iconForTopic('feature', undefined)).toBe(FALLBACK_TOPIC_ICON);
  });

  test('falls back when the control-plane icon is empty/whitespace', () => {
    expect(iconForTopic('feature', '')).toBe(FALLBACK_TOPIC_ICON);
    expect(iconForTopic('feature', '   ')).toBe(FALLBACK_TOPIC_ICON);
  });

  test('FALLBACK_TOPIC_ICON is the shared default', () => {
    expect(FALLBACK_TOPIC_ICON).toBe('symbol-key');
  });
});
