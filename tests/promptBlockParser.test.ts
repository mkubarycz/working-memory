/**
 * Part B of the prompt-block-marker feature: the pure parser that splits a
 * journal prompt into ordered text / block segments. A malformed or unclosed
 * marker must degrade to raw text, never crash. The `vscode` module is mocked
 * only so the provider file imports (the parser itself is vscode-free).
 */

import { describe, expect, test, vi } from 'vitest';

vi.mock('vscode', () => {
  class EventEmitter<T> {
    get event() {
      return (_l: (e: T) => void) => ({ dispose: () => {} });
    }
    fire(): void {}
  }
  return { EventEmitter, Uri: { parse: (v: string) => ({ path: v }) } };
});

import { parsePromptBlocks } from '../src/webview/documentEditorProvider';

describe('parsePromptBlocks', () => {
  test('a single well-formed block yields a block segment', () => {
    const request =
      '// START BLOCK /document/tmpl.working-memory#instructions?v3\nhello world\n// END BLOCK';
    expect(parsePromptBlocks(request)).toEqual([
      {
        kind: 'block',
        route: '/document/tmpl.working-memory',
        field: 'instructions',
        version: '3',
        content: 'hello world',
      },
    ]);
  });

  test('surrounding text becomes ordered text segments', () => {
    const request = [
      '# Context\nnow',
      '// START BLOCK /topic/a.working-memory#body?v2\nthe body\n// END BLOCK',
      '# Task\ndo it',
    ].join('\n\n');
    const segs = parsePromptBlocks(request);
    expect(segs.map((s) => s.kind)).toEqual(['text', 'block', 'text']);
    expect(segs[0]).toEqual({ kind: 'text', text: '# Context\nnow' });
    expect(segs[1]).toMatchObject({ route: '/topic/a.working-memory', field: 'body', version: '2' });
    expect(segs[2]).toEqual({ kind: 'text', text: '# Task\ndo it' });
  });

  test('multiple blocks are all extracted in order', () => {
    const request = [
      '// START BLOCK /document/t.working-memory#instructions?v1\nA\n// END BLOCK',
      '// START BLOCK /topic/x.working-memory#body?v5\nB\n// END BLOCK',
    ].join('\n\n');
    const segs = parsePromptBlocks(request);
    expect(segs.filter((s) => s.kind === 'block')).toHaveLength(2);
    expect((segs[0] as { content: string }).content).toBe('A');
    expect((segs[1] as { field: string }).field).toBe('body');
  });

  test('no markers ⇒ a single passthrough text segment', () => {
    expect(parsePromptBlocks('just some plain prompt')).toEqual([
      { kind: 'text', text: 'just some plain prompt' },
    ]);
  });

  test('an unclosed START marker falls back to raw text (no crash)', () => {
    const request = '// START BLOCK /topic/a.working-memory#body?v2\ndangling content, no end';
    const segs = parsePromptBlocks(request);
    expect(segs).toHaveLength(1);
    expect(segs[0].kind).toBe('text');
    expect((segs[0] as { text: string }).text).toContain('START BLOCK');
  });

  test('a malformed header (missing ?v) is not treated as a block', () => {
    const request = '// START BLOCK /topic/a.working-memory#body\nx\n// END BLOCK';
    const segs = parsePromptBlocks(request);
    expect(segs.every((s) => s.kind === 'text')).toBe(true);
  });

  test('a separator-only text run between blocks is dropped', () => {
    const request = [
      '// START BLOCK /document/t.working-memory#instructions?v1\nA\n// END BLOCK',
      '---',
      '// START BLOCK /topic/x.working-memory#body?v2\nB\n// END BLOCK',
    ].join('\n\n');
    const segs = parsePromptBlocks(request);
    expect(segs.map((s) => s.kind)).toEqual(['block', 'block']);
  });
});
