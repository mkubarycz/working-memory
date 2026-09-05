import { describe, expect, it } from 'vitest';
import { chatContextForDocument } from '../src/shared/contracts';

describe('chatContextForDocument', () => {
  it('projects a selected document into stable model context', () => {
    expect(chatContextForDocument({
      kind: 'topic',
      id: 'topic-id',
      slug: 'selected-topic',
      title: 'Selected topic',
    })).toEqual({
      kind: 'topic',
      routeKind: 'topic',
      identifier: 'selected-topic',
      title: 'Selected topic',
    });
  });

  it('normalizes generic kinds and returns no context without an identifier', () => {
    expect(chatContextForDocument({
      kind: 'Nanite',
      id: 'nanite-id',
      slug: null,
      title: 'Daily review',
    })).toEqual({
      kind: 'Nanite',
      routeKind: 'document',
      identifier: 'nanite-id',
      title: 'Daily review',
    });
    expect(chatContextForDocument({ kind: 'topic', id: '', slug: null, title: 'Untitled' })).toBeUndefined();
  });
});