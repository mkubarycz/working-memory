import { describe, expect, it } from 'vitest';
import { chatContextForDocument } from '../src/shared/contracts';

describe('chatContextForDocument', () => {
  it('targets registered host tasks without inventing a context for lists or unregistered tasks', () => {
    expect(chatContextForDocument({
      kind: 'host-tasks', id: 'approved-host-tasks', title: 'Host tasks',
    })).toBeUndefined();
    expect(chatContextForDocument({ kind: 'host-task', id: 'task-id', title: 'Import messages' })).toEqual({
      kind: 'host-task', routeKind: 'host-task', identifier: 'task-id', title: 'Import messages',
    });
    expect(chatContextForDocument({ kind: 'host-task-create', id: 'new-host-task', title: 'Add host task' })).toBeUndefined();
  });

  it('projects a selected document into stable model context', () => {
    expect(chatContextForDocument({
      kind: 'topic',
      id: 'topic-id',

      title: 'Selected topic',
    })).toEqual({
      kind: 'topic',
      routeKind: 'topic',
      identifier: 'topic-id',
      title: 'Selected topic',
    });
  });

  it('normalizes generic kinds and returns no context without an identifier', () => {
    expect(chatContextForDocument({
      kind: 'Config',
      id: 'config-id',

      title: 'Daily review',
    })).toEqual({
      kind: 'Config',
      routeKind: 'document',
      identifier: 'config-id',
      title: 'Daily review',
    });
    expect(chatContextForDocument({ kind: 'topic', id: '',  title: 'Untitled' })).toBeUndefined();
  });

  it('marks a container-app virtual document as an implicit app target', () => {
    expect(chatContextForDocument({
      kind: 'container-app',
      id: 'sunset-chess',

      title: 'Sunset Chess',
    })).toEqual({
      kind: 'container-app',
      routeKind: 'document',
      identifier: 'sunset-chess',
      title: 'Sunset Chess',
      containerAppId: 'sunset-chess',
    });
  });

  it('does not scope chat to an unsaved topic draft', () => {
    expect(chatContextForDocument({
      kind: 'topic-create',
      id: 'draft-id',

      title: 'New Topic',
    })).toBeUndefined();
  });
});