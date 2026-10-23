import { describe, expect, it } from 'vitest';
import {
  topicAutocompleteDelay,
  TOPIC_AUTOCOMPLETE_IDLE_MS,
  TOPIC_AUTOCOMPLETE_MIN_INTERVAL_MS,
} from '../src/renderer/topicAutocomplete';
import { parseTopicAutocomplete, topicAutocompletePrompt } from '../src/main/topicAutocomplete';
import type { TopicAutocompleteInput } from '../src/shared/contracts';

const input: TopicAutocompleteInput = {
  body: 'Improve the release workflow and make installer testing easier.',
  currentTitle: '',
  currentTopicType: 'topic',
  topicTypes: [
    { id: 'topic', label: 'Topic', description: '' },
    { id: 'feature', label: 'Feature', description: 'New functionality' },
  ],
};

describe('topic and workstream suggestions', () => {
  it('keeps ordinary topic inference unchanged', () => {
    expect(topicAutocompletePrompt(input)).not.toContain('workstreamTitle');
    expect(parseTopicAutocomplete('{"title":"Installer testing","topicType":"feature"}', input))
      .toEqual({ title: 'Installer testing', topicType: 'feature' });
  });

  it('requests the broader workstream name alongside the first topic fields', () => {
    const draft = { ...input, currentWorkstreamTitle: 'Release improvements' };
    expect(topicAutocompletePrompt(draft)).toContain('"workstreamTitle"');
    expect(topicAutocompletePrompt(draft)).toContain('Current workstream title: Release improvements');
    expect(parseTopicAutocomplete(
      '```json\n{"title":"Installer testing","topicType":"feature","workstreamTitle":" Releases "}\n```',
      draft,
    )).toEqual({ title: 'Installer testing', topicType: 'feature', workstreamTitle: 'Releases' });
  });

  it('rejects missing or blank workstream suggestions explicitly', () => {
    for (const workstreamTitle of [undefined, '', '  ', 17]) {
      expect(() => parseTopicAutocomplete(JSON.stringify({
        title: 'Installer testing', topicType: 'feature', workstreamTitle,
      }), { ...input, currentWorkstreamTitle: '' })).toThrow('did not suggest a workstream title');
    }
  });

  it('bounds title lengths and retains the current type for an unknown suggestion', () => {
    expect(parseTopicAutocomplete(JSON.stringify({
      title: 'T'.repeat(150), topicType: 'unknown', workstreamTitle: 'W'.repeat(150),
    }), { ...input, currentWorkstreamTitle: '' })).toEqual({
      title: 'T'.repeat(120), topicType: 'topic', workstreamTitle: 'W'.repeat(120),
    });
  });

  it('reports invalid model output and missing topic titles', () => {
    expect(() => parseTopicAutocomplete('not JSON', input)).toThrow('invalid JSON');
    expect(() => parseTopicAutocomplete('null', input)).toThrow('invalid suggestion');
    expect(() => parseTopicAutocomplete('{"topicType":"feature"}', input)).toThrow('did not suggest a title');
  });
});

describe('topic autocomplete scheduling', () => {
  it('suggests titles after an idle pause without requiring punctuation', () => {
    const body = 'Improve installer testing and simplify the release workflow';
    expect(topicAutocompleteDelay({
      body,
      lastSuggestedBody: '',
      lastRequestedAt: 0,
      now: TOPIC_AUTOCOMPLETE_MIN_INTERVAL_MS,
    })).toBe(TOPIC_AUTOCOMPLETE_IDLE_MS);
  });

  it('queues edits during the cooldown instead of dropping them', () => {
    const body = 'Improve installer testing and simplify the release workflow';
    expect(topicAutocompleteDelay({
      body: `${body} with automated smoke tests`,
      lastSuggestedBody: body,
      lastRequestedAt: TOPIC_AUTOCOMPLETE_MIN_INTERVAL_MS,
      now: TOPIC_AUTOCOMPLETE_MIN_INTERVAL_MS + 1_000,
    })).toBe(9_000);
    expect(topicAutocompleteDelay({
      body: `${body} with automated smoke tests`,
      lastSuggestedBody: body,
      lastRequestedAt: TOPIC_AUTOCOMPLETE_MIN_INTERVAL_MS,
      now: TOPIC_AUTOCOMPLETE_MIN_INTERVAL_MS * 2,
    })).toBe(TOPIC_AUTOCOMPLETE_IDLE_MS);
  });

  it('does not request for short or unchanged content', () => {
    expect(topicAutocompleteDelay({
      body: 'Short sentence.',
      lastSuggestedBody: '',
      lastRequestedAt: 0,
      now: 20_000,
    })).toBeNull();
    const body = 'This is enough draft content without punctuation';
    expect(topicAutocompleteDelay({
      body: `  ${body}  `,
      lastSuggestedBody: body,
      lastRequestedAt: 0,
      now: 20_000,
    })).toBeNull();
  });
});
