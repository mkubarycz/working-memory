import { describe, expect, it } from 'vitest';
import { compile } from 'svelte/compiler';
import { readFileSync } from 'node:fs';
import { placementApplyInput, placementBugContext } from '../src/renderer/documents/topicPlacementActions';
import type { TopicPlacement } from '../../control-plane/src/topicPlacementContract';

const result: TopicPlacement = {
  state: 'ready', sourceVersion: 3, limited: false,
  suggestions: [{
    parent: { id: 'parent', title: 'Parent', resourceVersion: 5 },
    workstream: { id: 'ws', title: 'Workstream', resourceVersion: 7 },
    similarity: 0.8, confidence: { level: 'high', reason: 'Supporting evidence' },
    excerpt: 'Embedding evidence', evidence: 'parent-membership',
  }],
};
describe('topic placement UI actions', () => {
  it('passes captured versions instead of silently applying a newer selection', () => {
    expect(placementApplyInput('topic', result, result.suggestions[0])).toEqual({
      id: 'topic', expectedResourceVersion: 3,
      parent: { id: 'parent', resourceVersion: 5 }, workstream: { id: 'ws', resourceVersion: 7 },
    });
  });
  it('captures the selected suggestion and failed-apply context through existing search reporting', () => {
    const report = placementBugContext({ id: 'topic', title: 'Topic', resourceVersion: 3 },
      result, result.suggestions[0], 'Conflict: parent changed', false);
    expect(report.trace[0]).toMatchObject({ status: 'error', error: 'Conflict: parent changed',
      arguments: { selectedSuggestion: result.suggestions[0], result } });
    expect(report.context?.document).toEqual({ id: 'topic', title: 'Topic', kind: 'Topic' });
    expect(placementBugContext({ id: 'topic', title: 'Topic', resourceVersion: 3 }, null, null, '', true).loading).toBe(true);
  });
  it('compiles the production placement component with explicit selection/apply and shared reporting', () => {
    const source = readFileSync(new URL('../src/renderer/documents/TopicPlacement.svelte', import.meta.url), 'utf8');
    expect(() => compile(source, { filename: 'TopicPlacement.svelte', generate: 'client' })).not.toThrow();
  });
});
