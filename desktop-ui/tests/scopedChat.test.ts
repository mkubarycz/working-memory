import { describe, expect, it } from 'vitest';
import type { ChatRun } from '../src/renderer/chatHistory';
import { chatRunDomId, recentRunsForContext } from '../src/renderer/scopedChat';

function run(
  key: string,
  startedAt: number,
  kind: string,
  identifier: string,
  entityRefs: ChatRun['entityRefs'] = [],
): ChatRun {
  return {
    key, journalId: `journal/${key}`, startedAt, status: 'succeeded', userText: key,
    scope: { kind, id: `${identifier}-id`, slug: identifier, title: identifier }, entityRefs, tools: [],
  };
}

describe('scoped chat previews', () => {
  const context = { kind: 'topic', routeKind: 'topic' as const, identifier: 'selected', title: 'Selected' };

  it('returns at most the latest two runs matching kind and primary identifier exactly', () => {
    const runs = [
      run('old', 10, 'Topic', 'selected'),
      run('wrong-kind', 40, 'Workstream', 'selected'),
      run('wrong-id', 50, 'Topic', 'selected-child'),
      run('middle', 20, 'topic', 'selected'),
      run('new', 30, 'topic', 'selected'),
    ];
    expect(recentRunsForContext(runs, context).map((item) => item.key)).toEqual(['new', 'middle']);
  });

  it('returns no previews without a selected document and creates a stable encoded DOM id', () => {
    const selected = run('stable', 10, 'Topic', 'selected');
    expect(recentRunsForContext([selected], undefined)).toEqual([]);
    expect(chatRunDomId(selected)).toBe('chat-run-journal%2Fstable');
  });

  it('includes runs that reference or mutate the current document from another primary scope', () => {
    const related = run('created-topic', 20, 'Workstream', '0-15-2', [
      { kind: 'Topic', id: 'topic-uuid', slug: 'selected', relation: 'mutated' },
    ]);
    const unrelated = run('other-topic', 30, 'Workstream', '0-15-2', [
      { kind: 'Topic', id: 'other-uuid', slug: 'other', relation: 'referenced' },
    ]);

    expect(recentRunsForContext([related, unrelated], context).map((item) => item.key)).toEqual(['created-topic']);
  });
});