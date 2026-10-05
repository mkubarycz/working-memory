import {
  StateEffect,
  StateField,
  type EditorState,
  type Range,
} from '@codemirror/state';
import { syntaxTree } from '@codemirror/language';
import {
  Decoration,
  EditorView,
  WidgetType,
  type DecorationSet,
} from '@codemirror/view';

const HIDDEN_MARKS = new Set([
  'CodeMark',
  'EmphasisMark',
  'HeaderMark',
  'LinkMark',
]);

const HEADING_CLASSES: Record<string, string> = {
  ATXHeading1: 'cm-live-heading-1',
  ATXHeading2: 'cm-live-heading-2',
  ATXHeading3: 'cm-live-heading-3',
  ATXHeading4: 'cm-live-heading-4',
  ATXHeading5: 'cm-live-heading-5',
  ATXHeading6: 'cm-live-heading-6',
};

export const activateLivePreview = StateEffect.define<void>();
export const resetLivePreview = StateEffect.define<void>();

export const livePreviewActivated = StateField.define<boolean>({
  create: () => false,
  update: (activated, transaction) => {
    if (transaction.effects.some((effect) => effect.is(resetLivePreview))) return false;
    return activated || transaction.effects.some((effect) => effect.is(activateLivePreview));
  },
});

function activeLineStarts(state: EditorState): Set<number> {
  const lines = new Set<number>();
  if (!state.field(livePreviewActivated, false)) return lines;
  for (const range of state.selection.ranges) {
    lines.add(state.doc.lineAt(range.from).from);
    lines.add(state.doc.lineAt(range.to).from);
  }
  return lines;
}

function selectionTouchesRange(state: EditorState, from: number, to: number): boolean {
  if (!state.field(livePreviewActivated, false)) return false;
  return state.selection.ranges.some((range) => (
    range.empty
      ? range.head >= from && range.head <= to
      : range.from < to && range.to > from
  ));
}

export interface ListMarker {
  depth: number;
  from: number;
  to: number;
  label: string;
  ordered: boolean;
}

export function parseListMarker(line: string): ListMarker | null {
  const match = /^([ \t]*)([-+*]|\d+[.)])(?=\s)/.exec(line);
  if (!match) return null;
  const indentation = match[1].replace(/\t/g, '  ').length;
  return {
    depth: Math.min(6, Math.floor(indentation / 2)),
    from: match[1].length,
    to: match[0].length,
    label: /^\d/.test(match[2]) ? match[2].replace(/[.)]$/, '.') : '•',
    ordered: /^\d/.test(match[2]),
  };
}

class ListMarkerWidget extends WidgetType {
  constructor(private readonly marker: ListMarker) {
    super();
  }

  eq(other: ListMarkerWidget): boolean {
    return other.marker.label === this.marker.label
      && other.marker.ordered === this.marker.ordered;
  }

  toDOM(): HTMLElement {
    const marker = document.createElement('span');
    marker.className = this.marker.ordered
      ? 'cm-live-list-marker cm-live-list-marker-ordered'
      : 'cm-live-list-marker cm-live-list-marker-bullet';
    marker.textContent = this.marker.label;
    marker.setAttribute('aria-hidden', 'true');
    return marker;
  }

  ignoreEvent(): boolean {
    return true;
  }
}

function buildDecorations(state: EditorState): DecorationSet {
  const decorations: Range<Decoration>[] = [];
  const activeLines = activeLineStarts(state);
  const decoratedHeadingLines = new Set<number>();

  for (let lineNumber = 1; lineNumber <= state.doc.lines; lineNumber += 1) {
    const line = state.doc.line(lineNumber);
    const marker = parseListMarker(line.text);
    if (!marker) continue;
    decorations.push(
      Decoration.line({
        class: [
          'cm-live-list-line',
          marker.ordered ? 'cm-live-list-ordered' : 'cm-live-list-bullet',
          `cm-live-list-depth-${marker.depth}`,
        ].join(' '),
      }).range(line.from),
    );
    const markerFrom = line.from + marker.from;
    const markerTo = line.from + marker.to;
    if (!selectionTouchesRange(state, markerFrom, markerTo)) {
      decorations.push(
        Decoration.replace({
          atomic: true,
          widget: new ListMarkerWidget(marker),
        }).range(markerFrom, markerTo),
      );
    }
  }

  syntaxTree(state).iterate({
    enter(node) {
      const line = state.doc.lineAt(node.from);
      const headingClass = HEADING_CLASSES[node.name];
      if (headingClass && !decoratedHeadingLines.has(line.from)) {
        decorations.push(Decoration.line({ class: headingClass }).range(line.from));
        decoratedHeadingLines.add(line.from);
      }
      if (HIDDEN_MARKS.has(node.name) && !activeLines.has(line.from)) {
        let hiddenTo = node.to;
        if (node.name === 'HeaderMark') {
          while (hiddenTo < line.to && /[ \t]/.test(state.doc.sliceString(hiddenTo, hiddenTo + 1))) {
            hiddenTo += 1;
          }
        }
        decorations.push(Decoration.replace({ atomic: true }).range(node.from, hiddenTo));
      }
    },
  });

  return Decoration.set(decorations, true);
}

export const liveMarkdownPreview = StateField.define<DecorationSet>({
  create: buildDecorations,
  update: (decorations, transaction) => (
    transaction.docChanged
      || transaction.selection
      || transaction.effects.some((effect) => effect.is(activateLivePreview))
      || transaction.effects.some((effect) => effect.is(resetLivePreview))
      ? buildDecorations(transaction.state)
      : decorations
  ),
  provide: (field) => [
    EditorView.decorations.from(field),
    EditorView.atomicRanges.of((view) => {
      const atomic: Range<Decoration>[] = [];
      view.state.field(field).between(0, view.state.doc.length, (from, to, value) => {
        if (value.spec.atomic === true) atomic.push(value.range(from, to));
      });
      return Decoration.set(atomic, true);
    }),
  ],
});

export const liveMarkdownTheme = EditorView.baseTheme({
  '.cm-live-heading-1': {
    fontSize: '1.55em',
    fontWeight: '700',
    lineHeight: '1.35',
  },
  '.cm-live-heading-2': {
    fontSize: '1.35em',
    fontWeight: '650',
    lineHeight: '1.4',
  },
  '.cm-live-heading-3': {
    fontSize: '1.18em',
    fontWeight: '650',
  },
  '.cm-live-heading-4, .cm-live-heading-5, .cm-live-heading-6': {
    fontWeight: '650',
  },
  '.cm-live-strong': {
    fontWeight: '700',
  },
  '.cm-live-emphasis': {
    fontStyle: 'italic',
  },
  '.cm-live-link': {
    color: 'var(--vscode-textLink-foreground)',
    textDecoration: 'underline',
    textUnderlineOffset: '2px',
  },
  '.cm-live-monospace': {
    borderRadius: '3px',
    padding: '0.08em 0.25em',
    backgroundColor: 'var(--vscode-textCodeBlock-background, rgba(128, 128, 128, 0.1))',
    fontFamily: 'var(--vscode-editor-font-family, monospace)',
  },
  '.cm-live-list-line': {
    paddingLeft: 'calc(var(--cm-live-list-gutter) + var(--cm-live-list-depth-indent, 0em))',
    textIndent: 'calc(-1 * (var(--cm-live-list-gutter) + var(--cm-live-list-depth-indent, 0em)))',
  },
  '.cm-live-list-bullet, .cm-live-list-ordered': {
    '--cm-live-list-gutter': '2em',
  },
  '.cm-live-list-depth-1': {
    '--cm-live-list-depth-indent': '0.75em',
    color: 'color-mix(in srgb, var(--vscode-editor-foreground) 92%, transparent)',
  },
  '.cm-live-list-depth-2': {
    '--cm-live-list-depth-indent': '1.5em',
    color: 'color-mix(in srgb, var(--vscode-editor-foreground) 84%, transparent)',
  },
  '.cm-live-list-depth-3': {
    '--cm-live-list-depth-indent': '2.25em',
    color: 'color-mix(in srgb, var(--vscode-editor-foreground) 84%, transparent)',
  },
  '.cm-live-list-depth-4': {
    '--cm-live-list-depth-indent': '3em',
    color: 'color-mix(in srgb, var(--vscode-editor-foreground) 84%, transparent)',
  },
  '.cm-live-list-depth-5': {
    '--cm-live-list-depth-indent': '3.75em',
    color: 'color-mix(in srgb, var(--vscode-editor-foreground) 84%, transparent)',
  },
  '.cm-live-list-depth-6': {
    '--cm-live-list-depth-indent': '4.5em',
    color: 'color-mix(in srgb, var(--vscode-editor-foreground) 84%, transparent)',
  },
  '.cm-live-list-marker': {
    display: 'inline-block',
    boxSizing: 'border-box',
    color: 'var(--vscode-descriptionForeground)',
    fontVariantNumeric: 'tabular-nums',
    width: '1.65em',
    paddingRight: '0.35em',
    textAlign: 'right',
    userSelect: 'none',
  },
});
