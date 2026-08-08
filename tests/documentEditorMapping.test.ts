/**
 * WM 14.2.1: unit coverage for the pure ref-parsing + kind-mapping helpers of
 * the unified document editor. `parseRef` only reads `uri.path`, so a minimal
 * `{ path } as vscode.Uri` stand-in is enough; the `vscode` module is mocked so
 * the provider imports.
 */

import { describe, test, expect, vi } from 'vitest';
import type * as vscode from 'vscode';

vi.mock('vscode', () => {
  class EventEmitter<T> {
    get event() {
      return (_l: (e: T) => void) => ({ dispose: () => {} });
    }
    fire(): void {}
  }
  return {
    EventEmitter,
    Uri: {
      parse: (value: string) => {
        const idx = value.indexOf(':');
        return { scheme: value.slice(0, idx), path: value.slice(idx + 1) };
      },
    },
  };
});

const uri = (path: string): vscode.Uri => ({ path }) as vscode.Uri;

describe('parseRef', () => {
  test('parses a valid /kind/id.working-memory path', async () => {
    const { parseRef } = await import('../src/webview/documentEditorProvider');
    expect(parseRef(uri('/topic/my-topic.working-memory'))).toEqual({
      kindHint: 'topic',
      identifier: 'my-topic',
    });
    expect(parseRef(uri('/workstream/ws-1.working-memory'))).toEqual({
      kindHint: 'workstream',
      identifier: 'ws-1',
    });
  });

  test('percent-decodes the identifier segment', async () => {
    const { parseRef } = await import('../src/webview/documentEditorProvider');
    expect(parseRef(uri('/topic/a%2Fb%20c.working-memory'))).toEqual({
      kindHint: 'topic',
      identifier: 'a/b c',
    });
  });

  test('keeps the raw identifier when it is not valid percent-encoding', async () => {
    const { parseRef } = await import('../src/webview/documentEditorProvider');
    expect(parseRef(uri('/topic/100%.working-memory'))).toEqual({
      kindHint: 'topic',
      identifier: '100%',
    });
  });

  test('malformed paths fall back to the document kindHint + raw path', async () => {
    const { parseRef } = await import('../src/webview/documentEditorProvider');
    expect(parseRef(uri('/no-extension/here'))).toEqual({
      kindHint: 'document',
      identifier: '/no-extension/here',
    });
    // Legacy `.workstream` extension is NOT matched → falls back.
    expect(parseRef(uri('/workstream/ws-1.workstream'))).toEqual({
      kindHint: 'document',
      identifier: '/workstream/ws-1.workstream',
    });
  });
});

describe('controlPlaneKindFor', () => {
  test('maps known URI kind hints to control-plane kind names', async () => {
    const { controlPlaneKindFor } = await import(
      '../src/webview/documentEditorProvider'
    );
    expect(controlPlaneKindFor('workstream')).toBe('Workstream');
    expect(controlPlaneKindFor('topic')).toBe('Topic');
    expect(controlPlaneKindFor('topic-type')).toBe('TopicType');
    expect(controlPlaneKindFor('alert')).toBe('Alert');
  });

  test('document is the generic by-id lookup (null kind)', async () => {
    const { controlPlaneKindFor } = await import(
      '../src/webview/documentEditorProvider'
    );
    expect(controlPlaneKindFor('document')).toBeNull();
  });

  test('an unknown kind hint passes straight through', async () => {
    const { controlPlaneKindFor } = await import(
      '../src/webview/documentEditorProvider'
    );
    expect(controlPlaneKindFor('Nanite')).toBe('Nanite');
  });
});
