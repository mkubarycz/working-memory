import { markdown } from '@codemirror/lang-markdown';
import { EditorState } from '@codemirror/state';
import { EditorView } from '@codemirror/view';
import { describe, expect, it, vi } from 'vitest';
import {
  activateLivePreview,
  isOpenableMarkdownHref,
  liveMarkdownPreview,
  livePreviewActivated,
  MarkdownLinkClickController,
  parseListMarker,
  renderedMarkdownLinkAt,
  resetLivePreview,
  type LinkPointerEvent,
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

describe('live Markdown link clicks', () => {
  const LINKS = [
    '[inline](https://example.com/a "Title")',
    'See [ref][Docs] and [Docs] and [docs][]',
    '<https://example.com/auto>',
    '[topic](working-memory://open/topic/next-step) [file](wm-attachment:0f0e-1)',
    '[bad](javascript:alert(1)) [mail](mailto:a@b.c) <me@example.com> [undefined]',
    '',
    '[docs]: <https://docs.example.com/x\\(1\\)>',
  ].join('\n');

  function createState(doc = LINKS, anchor = doc.length, activated = false): EditorState {
    const state = EditorState.create({
      doc,
      selection: { anchor },
      extensions: [markdown(), livePreviewActivated, liveMarkdownPreview],
    });
    return activated ? state.update({ effects: activateLivePreview.of() }).state : state;
  }

  function at(doc: string, needle: string): number {
    const index = doc.indexOf(needle);
    if (index < 0) throw new Error(`missing ${needle}`);
    return index + 1;
  }

  function linkTargets(state: EditorState): string[] {
    const targets: string[] = [];
    state.field(liveMarkdownPreview).between(0, state.doc.length, (from, to, value) => {
      if (String(value.spec.class ?? '').includes('cm-live-link-target')) {
        targets.push(state.doc.sliceString(from, to));
      }
    });
    return targets;
  }

  it('resolves inline, reference, collapsed, shortcut, and autolinks when rendered', () => {
    const state = createState();
    const href = (needle: string) => renderedMarkdownLinkAt(state, at(LINKS, needle))?.href ?? null;

    expect(href('inline')).toBe('https://example.com/a');
    expect(href('ref]')).toBe('https://docs.example.com/x(1)');
    expect(href('Docs] and')).toBe('https://docs.example.com/x(1)');
    expect(href('docs][]')).toBe('https://docs.example.com/x(1)');
    expect(href('https://example.com/auto')).toBe('https://example.com/auto');
    expect(href('topic]')).toBe('working-memory://open/topic/next-step');
    expect(href('file]')).toBe('wm-attachment:0f0e-1');
  });

  it('leaves unsafe, unroutable, and undefined references to normal editing', () => {
    const state = createState();

    expect(renderedMarkdownLinkAt(state, at(LINKS, 'bad]'))).toBeNull();
    expect(renderedMarkdownLinkAt(state, at(LINKS, 'mail]'))).toBeNull();
    expect(renderedMarkdownLinkAt(state, at(LINKS, 'me@example.com'))).toBeNull();
    expect(renderedMarkdownLinkAt(state, at(LINKS, 'undefined]'))).toBeNull();
    expect(renderedMarkdownLinkAt(state, at(LINKS, 'See'))).toBeNull();
    expect(isOpenableMarkdownHref('javascript:alert(1)')).toBe(false);
    expect(isOpenableMarkdownHref('//evil.example')).toBe(false);
    expect(isOpenableMarkdownHref('/topic/x.working-memory')).toBe(true);
  });

  it('marks only rendered links as click targets and drops the expanded editing line', () => {
    const doc = '[one](https://one.example)\n[two](https://two.example)';
    expect(linkTargets(createState(doc, 0))).toEqual([
      '[one](https://one.example)',
      '[two](https://two.example)',
    ]);

    const editing = createState(doc, 2, true);
    expect(linkTargets(editing)).toEqual(['[two](https://two.example)']);
    expect(renderedMarkdownLinkAt(editing, 2)).toBeNull();
    expect(renderedMarkdownLinkAt(editing, at(doc, 'two'))?.href).toBe('https://two.example');
  });

  describe('event precedence', () => {
    const doc = 'Intro line\n[open me](https://example.com/x)\nTail';
    const linkPos = at(doc, 'open me');
    const linkElement = {} as Element;

    function pointer(overrides: Partial<LinkPointerEvent> = {}, onLink = true): LinkPointerEvent {
      return {
        button: 0,
        detail: 1,
        shiftKey: false,
        altKey: false,
        metaKey: false,
        ctrlKey: false,
        target: {
          closest: (selector: string) => (onLink && selector === '.cm-live-link-target' ? linkElement : null),
        } as unknown as EventTarget,
        ...overrides,
      };
    }

    /**
     * Mirrors CodeMirror's InputState.runHandlers: higher-precedence plugin
     * handlers run first and a `true` result prevents the default action and
     * stops every later handler, including the built-in mousedown selection
     * and the editor's mouseup live-preview activation.
     */
    function simulateClick(
      controller: MarkdownLinkClickController,
      state: EditorState,
      event: LinkPointerEvent,
    ) {
      const view = { state, posAtDOM: (node: Node) => (node === (linkElement as unknown) ? linkPos : 0) };
      const later = { selection: 0, activation: 0 };
      if (!controller.mousedown(view, event)) later.selection += 1;
      if (!controller.mouseup()) later.activation += 1;
      const clickHandled = controller.click(view, event);
      return { ...later, clickHandled };
    }

    it('opens an unmodified click on a rendered link once without editing or expanding', () => {
      const open = vi.fn();
      const controller = new MarkdownLinkClickController(open);
      const state = createState(doc, 0);
      const result = simulateClick(controller, state, pointer());

      expect(open).toHaveBeenCalledTimes(1);
      expect(open).toHaveBeenCalledWith('https://example.com/x');
      expect(result).toEqual({ selection: 0, activation: 0, clickHandled: true });
      expect(state.field(livePreviewActivated)).toBe(false);
      expect(state.doc.toString()).toBe(doc);
    });

    it('lets clicks on the expanded editing line place the cursor instead of opening', () => {
      const open = vi.fn();
      const controller = new MarkdownLinkClickController(open);
      const result = simulateClick(controller, createState(doc, linkPos, true), pointer());

      expect(open).not.toHaveBeenCalled();
      expect(result).toEqual({ selection: 1, activation: 1, clickHandled: false });
    });

    it('keeps non-link clicks able to enter editing', () => {
      const open = vi.fn();
      const controller = new MarkdownLinkClickController(open);
      const result = simulateClick(controller, createState(doc, 0), pointer({}, false));

      expect(open).not.toHaveBeenCalled();
      expect(result).toEqual({ selection: 1, activation: 1, clickHandled: false });
    });

    it('preserves modifier and non-primary clicks', () => {
      for (const modifier of [
        { shiftKey: true },
        { altKey: true },
        { metaKey: true },
        { ctrlKey: true },
        { button: 1 },
        { button: 2 },
      ]) {
        const open = vi.fn();
        const controller = new MarkdownLinkClickController(open);
        const result = simulateClick(controller, createState(doc, 0), pointer(modifier));

        expect(open).not.toHaveBeenCalled();
        expect(result).toEqual({ selection: 1, activation: 1, clickHandled: false });
      }
    });

    it('does not reopen on the second click of a double click', () => {
      const open = vi.fn();
      const controller = new MarkdownLinkClickController(open);
      const state = createState(doc, 0);
      simulateClick(controller, state, pointer());
      const second = simulateClick(controller, state, pointer({ detail: 2 }));

      expect(open).toHaveBeenCalledTimes(1);
      expect(second).toEqual({ selection: 0, activation: 0, clickHandled: true });
    });

    it('ignores a click that lands somewhere other than the pressed link', () => {
      const open = vi.fn();
      const controller = new MarkdownLinkClickController(open);
      const state = createState(doc, 0);
      const view = { state, posAtDOM: () => linkPos };
      expect(controller.mousedown(view, pointer())).toBe(true);
      expect(controller.mouseup()).toBe(true);
      expect(controller.click(view, pointer({}, false))).toBe(true);

      expect(open).not.toHaveBeenCalled();
      expect(controller.mouseup()).toBe(false);
    });
  });
});
