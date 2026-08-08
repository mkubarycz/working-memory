/**
 * WM 14.2.1: unit coverage for the generic fallback view-model builder and its
 * `asString` helper. Pure logic — the `vscode` module is mocked only so the
 * provider imports.
 */

import { describe, test, expect, vi } from 'vitest';
import type { DocumentEnvelope } from '../src/controlPlaneClient';

vi.mock('vscode', () => {
  class EventEmitter<T> {
    get event() {
      return (_l: (e: T) => void) => ({ dispose: () => {} });
    }
    fire(): void {}
  }
  return { EventEmitter, Uri: { parse: (v: string) => ({ path: v }) } };
});

function envelope(
  spec: Record<string, unknown>,
  metadata: Partial<DocumentEnvelope['metadata']> = {},
): DocumentEnvelope {
  return {
    kind: 'Nanite',
    metadata: {
      id: 'id-1',
      slug: 'slug-1',
      labels: {},
      createdAt: 1,
      updatedAt: 2,
      deletedAt: null,
      resourceVersion: 3,
      ...metadata,
    },
    spec,
    status: {},
  };
}

describe('asString', () => {
  test('coerces null/undefined to an empty string', async () => {
    const { asString } = await import('../src/webview/documentEditorProvider');
    expect(asString(null)).toBe('');
    expect(asString(undefined)).toBe('');
  });

  test('passes strings through unchanged', async () => {
    const { asString } = await import('../src/webview/documentEditorProvider');
    expect(asString('hello')).toBe('hello');
  });

  test('JSON-stringifies objects (pretty-printed)', async () => {
    const { asString } = await import('../src/webview/documentEditorProvider');
    expect(asString({ a: 1 })).toBe(JSON.stringify({ a: 1 }, null, 2));
    expect(asString([1, 2])).toBe(JSON.stringify([1, 2], null, 2));
  });

  test('stringifies other primitives', async () => {
    const { asString } = await import('../src/webview/documentEditorProvider');
    expect(asString(42)).toBe('42');
    expect(asString(true)).toBe('true');
  });
});

describe('buildGenericVM', () => {
  test('title falls back spec.title → spec.label → slug → id', async () => {
    const { buildGenericVM } = await import(
      '../src/webview/documentEditorProvider'
    );
    expect(buildGenericVM(envelope({ title: 'T', label: 'L' })).title).toBe('T');
    expect(buildGenericVM(envelope({ label: 'L' })).title).toBe('L');
    expect(buildGenericVM(envelope({})).title).toBe('slug-1');
    expect(
      buildGenericVM(envelope({}, { slug: null })).title,
    ).toBe('id-1');
  });

  test('flattens spec values via asString (objects → JSON, primitives pass through)', async () => {
    const { buildGenericVM } = await import(
      '../src/webview/documentEditorProvider'
    );
    const vm = buildGenericVM(envelope({ count: 7, meta: { a: 1 } }));
    const byKey = Object.fromEntries(vm.spec.map((f) => [f.key, f.value]));
    expect(byKey.count).toBe('7');
    expect(byKey.meta).toBe(JSON.stringify({ a: 1 }, null, 2));
  });

  test('sorts spec fields by key', async () => {
    const { buildGenericVM } = await import(
      '../src/webview/documentEditorProvider'
    );
    const vm = buildGenericVM(envelope({ zeta: 1, alpha: 2, mid: 3 }));
    expect(vm.spec.map((f) => f.key)).toEqual(['alpha', 'mid', 'zeta']);
  });

  test('carries the envelope kind + metadata through', async () => {
    const { buildGenericVM } = await import(
      '../src/webview/documentEditorProvider'
    );
    const vm = buildGenericVM(envelope({}));
    expect(vm).toMatchObject({
      kind: 'Nanite',
      id: 'id-1',
      slug: 'slug-1',
      createdAt: 1,
      updatedAt: 2,
      resourceVersion: 3,
    });
  });

  test('tolerates a missing spec', async () => {
    const { buildGenericVM } = await import(
      '../src/webview/documentEditorProvider'
    );
    const env = envelope({});
    // Simulate an envelope with no spec at all.
    (env as { spec?: unknown }).spec = undefined;
    const vm = buildGenericVM(env);
    expect(vm.spec).toEqual([]);
    expect(vm.title).toBe('slug-1');
  });
});
