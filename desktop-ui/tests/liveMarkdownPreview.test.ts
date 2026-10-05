import { markdown } from '@codemirror/lang-markdown';
import { EditorState } from '@codemirror/state';
import { EditorView } from '@codemirror/view';
import { describe, expect, it } from 'vitest';
import {
  activateLivePreview,
  liveMarkdownPreview,
  livePreviewActivated,
  parseListMarker,
  resetLivePreview,
} from '../src/renderer/documents/liveMarkdownPreview';

describe('live Markdown preview', () => {
  function createState(doc: string, anchor = 0): EditorState {
    return EditorState.create({
      doc,
      selection: { anchor },
      extensions: [markdown(), livePreviewActivated, liveMarkdownPreview],
    });
  }

  function replacements(state: EditorState): Array<[number, number]> {
    const ranges: Array<[number, number]> = [];
    state.field(liveMarkdownPreview).between(0, state.doc.length, (from, to) => {
      if (from < to) ranges.push([from, to]);
    });
    return ranges;
  }

  function atomicRanges(state: EditorState): Array<[number, number]> {
    const ranges: Array<[number, number]> = [];
    const view = { state } as EditorView;
    for (const source of state.facet(EditorView.atomicRanges)) {
      source(view).between(0, state.doc.length, (from, to) => {
        if (from < to) ranges.push([from, to]);
      });
    }
    return ranges;
  }

  it('renders the first line without exposing its syntax before activation', () => {
    const state = createState('# Heading\n\n**bold**', 2);
    const decorations: Array<{ from: number; to: number; spec: Record<string, unknown> }> = [];
    state.field(liveMarkdownPreview).between(0, state.doc.length, (from, to, value) => {
      decorations.push({ from, to, spec: value.spec });
    });

    expect(state.field(livePreviewActivated)).toBe(false);
    expect(decorations).toContainEqual({
      from: 0,
      to: 0,
      spec: expect.objectContaining({ class: 'cm-live-heading-1' }),
    });
    expect(replacements(state)).toHaveLength(3);
  });

  it('reveals formatting marks only on the active line after user activation', () => {
    const initial = createState('# Heading\n\n**bold**', 2);
    const state = initial.update({
      effects: activateLivePreview.of(),
    }).state;
    const decorations: Array<{ from: number; to: number; spec: Record<string, unknown> }> = [];
    state.field(liveMarkdownPreview).between(0, state.doc.length, (from, to, value) => {
      decorations.push({ from, to, spec: value.spec });
    });

    expect(state.field(livePreviewActivated)).toBe(true);
    expect(replacements(state)).toHaveLength(2);
  });

  it('makes hidden Markdown syntax atomic for pointer and keyboard navigation', () => {
    const state = createState('## Heading\n\n**bold**');

    expect(atomicRanges(state)).toEqual(replacements(state));
  });

  it('keeps formatting marks visible on the active line', () => {
    const initial = createState('**bold**', 4);
    const state = initial.update({
      effects: activateLivePreview.of(),
    }).state;

    expect(replacements(state)).toEqual([]);
  });

  it('returns to a fully rendered first line when the document changes', () => {
    const activated = createState('## First topic', 5).update({
      effects: activateLivePreview.of(),
    }).state;
    const switched = activated.update({
      changes: {
        from: 0,
        to: activated.doc.length,
        insert: '## Second topic',
      },
      selection: { anchor: 0 },
      effects: resetLivePreview.of(),
    }).state;

    expect(switched.field(livePreviewActivated)).toBe(false);
    expect(replacements(switched)).toEqual([[0, 3]]);
  });

  it('hides heading separator whitespace so rendered headings align with content', () => {
    const state = createState('##   Heading\nBody');

    expect(replacements(state)).toEqual([[0, 5]]);
  });

  it('parses polished bullet and numbered list markers with nesting depth', () => {
    expect(parseListMarker('- item')).toEqual({
      depth: 0,
      from: 0,
      to: 1,
      label: '•',
      ordered: false,
    });
    expect(parseListMarker('  12) nested')).toEqual({
      depth: 1,
      from: 2,
      to: 5,
      label: '12.',
      ordered: true,
    });
    expect(parseListMarker('not a list')).toBeNull();
  });

  it('keeps list markers rendered while editing item text', () => {
    const initial = createState('- first\n  1. nested', 3);
    expect(replacements(initial)).toEqual([
      [0, 1],
      [10, 12],
    ]);
    const active = initial.update({
      effects: activateLivePreview.of(),
    }).state;

    expect(replacements(active)).toEqual([
      [0, 1],
      [10, 12],
    ]);
  });

  it('identifies bullet and ordered lines for stable hanging indentation', () => {
    const state = createState('- bullet\n  2. ordered');
    const lineClasses: string[] = [];
    state.field(liveMarkdownPreview).between(0, state.doc.length, (_from, _to, value) => {
      if (typeof value.spec.class === 'string' && value.spec.class.includes('cm-live-list-line')) {
        lineClasses.push(value.spec.class);
      }
    });

    expect(lineClasses).toEqual([
      'cm-live-list-line cm-live-list-bullet cm-live-list-depth-0',
      'cm-live-list-line cm-live-list-ordered cm-live-list-depth-1',
    ]);
  });

  it('reveals a list marker only when the marker itself is edited', () => {
    const initial = createState('- first\n2. second', 0);
    const active = initial.update({
      effects: activateLivePreview.of(),
    }).state;

    expect(replacements(active)).toEqual([[8, 10]]);
  });
});
