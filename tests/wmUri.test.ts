import { expect, test } from 'vitest';
import { parsePanelRevealTarget } from '../src/wmUri';

test('parses topic URI target', () => {
  expect(parsePanelRevealTarget('working-memory:/topic/my-topic.md')).toEqual({
    kind: 'topic',
    id: 'my-topic',
  });
});

test('parses encoded workstream URI target', () => {
  expect(
    parsePanelRevealTarget('working-memory:/workstream/weekly%20review.md'),
  ).toEqual({
    kind: 'workstream',
    id: 'weekly review',
  });
});

test('ignores non-panel URI kinds', () => {
  expect(parsePanelRevealTarget('working-memory:/topic-type/foo.md')).toBeNull();
  expect(parsePanelRevealTarget('file:///tmp/a.md')).toBeNull();
});
