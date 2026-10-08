import { describe, expect, it } from 'vitest';
import {
  shouldRequestTopicAutocomplete,
  TOPIC_AUTOCOMPLETE_MIN_INTERVAL_MS,
} from '../src/renderer/topicAutocomplete';

describe('topic autocomplete scheduling', () => {
  it('waits for a sentence and enforces the ten second request interval', () => {
    const body = 'This is enough draft content for one complete sentence.';
    expect(shouldRequestTopicAutocomplete({
      body,
      lastSuggestedBody: '',
      lastRequestedAt: 0,
      now: TOPIC_AUTOCOMPLETE_MIN_INTERVAL_MS,
    })).toBe(true);
    expect(shouldRequestTopicAutocomplete({
      body: `${body} Another sentence.`,
      lastSuggestedBody: body,
      lastRequestedAt: TOPIC_AUTOCOMPLETE_MIN_INTERVAL_MS,
      now: TOPIC_AUTOCOMPLETE_MIN_INTERVAL_MS * 2 - 1,
    })).toBe(false);
    expect(shouldRequestTopicAutocomplete({
      body: `${body} Another sentence.`,
      lastSuggestedBody: body,
      lastRequestedAt: TOPIC_AUTOCOMPLETE_MIN_INTERVAL_MS,
      now: TOPIC_AUTOCOMPLETE_MIN_INTERVAL_MS * 2,
    })).toBe(true);
  });

  it('does not request for short or unfinished content', () => {
    expect(shouldRequestTopicAutocomplete({
      body: 'Short sentence.',
      lastSuggestedBody: '',
      lastRequestedAt: 0,
      now: 20_000,
    })).toBe(false);
    expect(shouldRequestTopicAutocomplete({
      body: 'This draft is long enough but still unfinished',
      lastSuggestedBody: '',
      lastRequestedAt: 0,
      now: 20_000,
    })).toBe(false);
  });
});
