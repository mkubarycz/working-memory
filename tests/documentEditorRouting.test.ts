/**
 * WM 14.2.1: EVERY Working Memory document kind opens in the unified Svelte
 * custom editor. `working-memory.open` builds the target via
 * `DocumentEditorProvider.uriFor(kind, id)` and hands it to
 * `vscode.openWith(uri, DocumentEditorProvider.viewType)`. These tests pin that
 * routing surface: for every supported kind the URI carries the kind + id under
 * the `.working-memory` extension (so the `customEditors` `filenamePattern`
 * matches and the `working-memory:` FS provider resolves it), and the viewType
 * is the single unified editor — no `.md` virtual-doc route remains.
 */

import { test, expect, vi } from 'vitest';

vi.mock('vscode', () => {
  class EventEmitter<T> {
    get event() {
      return (_listener: (e: T) => void) => ({ dispose: () => {} });
    }
    fire(): void {}
  }
  return {
    EventEmitter,
    Uri: {
      // Mirror vscode.Uri.parse enough to expose scheme + path for assertions.
      parse: (value: string) => {
        const idx = value.indexOf(':');
        return {
          scheme: value.slice(0, idx),
          path: value.slice(idx + 1),
          toString: () => value,
        };
      },
    },
  };
});

// Every kind `working-memory.open` and the deep-link handler accept.
const KINDS = ['workstream', 'topic', 'topic-type', 'alert'] as const;

test('uriFor builds a `.working-memory` unified-editor URI for every kind', async () => {
  const { DocumentEditorProvider } = await import(
    '../src/webview/documentEditorProvider'
  );
  for (const kind of KINDS) {
    const uri = DocumentEditorProvider.uriFor(kind, 'my-id');
    expect(uri.scheme).toBe('working-memory');
    expect(uri.path).toBe(`/${kind}/my-id.working-memory`);
  }
});

test('uriFor percent-encodes the slug/id segment', async () => {
  const { DocumentEditorProvider } = await import(
    '../src/webview/documentEditorProvider'
  );
  const uri = DocumentEditorProvider.uriFor('topic', 'a/b c');
  expect(uri.path).toBe('/topic/a%2Fb%20c.working-memory');
});

test('the unified editor viewType is stable', async () => {
  const { DocumentEditorProvider } = await import(
    '../src/webview/documentEditorProvider'
  );
  expect(DocumentEditorProvider.viewType).toBe('workingMemory.documentEditor');
});
