import { describe, expect, it, vi } from 'vitest';

vi.mock('vscode', () => {
  class EventEmitter<T> {
    get event() {
      return (_listener: (event: T) => void) => ({ dispose: () => {} });
    }
    fire(): void {}
  }
  class FileSystemError extends Error {
    static FileNotFound(): FileSystemError {
      return new FileSystemError('File not found');
    }
    static NoPermissions(): FileSystemError {
      return new FileSystemError('No permissions');
    }
  }
  return {
    Disposable: class {
      constructor(_dispose: () => void) {}
    },
    EventEmitter,
    FilePermission: { Readonly: 1 },
    FileSystemError,
    FileType: { File: 1 },
    Uri: { parse: (value: string) => ({ path: value, toString: () => value }) },
  };
});

describe('Working Memory document provider', () => {
  it('keeps custom-editor handles byte-free', async () => {
    const { WorkstreamDocumentProvider } = await import('../src/contentProvider');
    const provider = new WorkstreamDocumentProvider();
    const uri = {
      path: '/topic/chat-context.working-memory',
      toString: () => 'working-memory:/topic/chat-context.working-memory',
    };

    const bytes = provider.readFile(uri as never);

    expect(bytes).toHaveLength(0);
  });
});
