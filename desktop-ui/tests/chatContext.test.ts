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
      kind: 'Config',
      id: 'config-id',
      slug: null,
      title: 'Daily review',
    })).toEqual({
      kind: 'Config',
      routeKind: 'document',
      identifier: 'config-id',
      title: 'Daily review',
    });
    expect(chatContextForDocument({ kind: 'topic', id: '', slug: null, title: 'Untitled' })).toBeUndefined();
  });

  it('marks a container-app virtual document as an implicit app target', () => {
    expect(chatContextForDocument({
      kind: 'container-app',
      id: 'sunset-chess',
      slug: 'sunset-chess',
      title: 'Sunset Chess',
    })).toEqual({
      kind: 'container-app',
      routeKind: 'document',
      identifier: 'sunset-chess',
      title: 'Sunset Chess',
      containerAppId: 'sunset-chess',
    });
  });
});