import {
  Prec,
  StateEffect,
  StateField,
  type EditorState,
  type Extension,
  type Range,
} from '@codemirror/state';
import { syntaxTree } from '@codemirror/language';
import {
  Decoration,
  EditorView,
  ViewPlugin,
  WidgetType,
  type DecorationSet,
} from '@codemirror/view';
import { unescapeMarkdown } from './markdown';

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

export interface MarkdownLink {
  from: number;
  to: number;
  href: string;
}

type SyntaxNode = ReturnType<ReturnType<typeof syntaxTree>['resolveInner']>;

const LINK_NODES = new Set(['Link', 'Autolink']);
const LINK_TARGET_CLASS = 'cm-live-link-target';
const OPENABLE_SCHEME = /^(?:https?|working-memory|vscode|wm-attachment):/i;

function normalizeLinkLabel(label: string): string {
  return label.replace(/^\[|\]$/g, '').trim().replace(/\s+/g, ' ').toLowerCase();
}

function linkDestination(raw: string): string {
  const trimmed = raw.trim();
  const unwrapped = trimmed.startsWith('<') && trimmed.endsWith('>') ? trimmed.slice(1, -1) : trimmed;
  return unescapeMarkdown(unwrapped);
}

/** Only links the desktop app can route are opened on click; anything else stays editable. */
export function isOpenableMarkdownHref(href: string): boolean {
  return OPENABLE_SCHEME.test(href) || /^\/[^/]/.test(href);
}

export function markdownLinkDefinitions(state: EditorState): Map<string, string> {
  const definitions = new Map<string, string>();
  syntaxTree(state).iterate({
    enter(node) {
      if (node.name !== 'LinkReference') return;
      const label = node.node.getChild('LinkLabel');
      const url = node.node.getChild('URL');
      if (label && url) {
        const key = normalizeLinkLabel(state.doc.sliceString(label.from, label.to));
        if (key && !definitions.has(key)) {
          definitions.set(key, linkDestination(state.doc.sliceString(url.from, url.to)));
        }
      }
      return false;
    },
  });
  return definitions;
}

function linkHref(
  state: EditorState,
  node: SyntaxNode,
  definitions: () => Map<string, string>,
): string | null {
  const url = node.getChild('URL');
  if (node.name === 'Autolink') {
    const destination = url ? state.doc.sliceString(url.from, url.to) : '';
    return /^[a-z][a-z0-9+.-]*:/i.test(destination) ? destination : null;
  }
  if (url) return linkDestination(state.doc.sliceString(url.from, url.to));
  const marks = node.getChildren('LinkMark');
  if (marks.length < 2) return null;
  const text = state.doc.sliceString(marks[0].to, marks[1].from);
  const label = node.getChild('LinkLabel');
  const labelText = label ? state.doc.sliceString(label.from, label.to) : '';
  const key = normalizeLinkLabel(labelText && labelText !== '[]' ? labelText : text);
  return key ? definitions().get(key) ?? null : null;
}

function linkIsRendered(state: EditorState, activeLines: Set<number>, from: number, to: number): boolean {
  return !activeLines.has(state.doc.lineAt(from).from) && !activeLines.has(state.doc.lineAt(to).from);
}

/**
 * Returns the openable Markdown link (inline, reference, or autolink) at a
 * document position when that link is rendered rather than expanded for
 * editing. Links on the active editing line return null so clicks edit them.
 */
export function renderedMarkdownLinkAt(state: EditorState, pos: number): MarkdownLink | null {
  const tree = syntaxTree(state);
  const activeLines = activeLineStarts(state);
  let definitions: Map<string, string> | null = null;
  const lookup = () => (definitions ??= markdownLinkDefinitions(state));
  for (const side of [1, -1] as const) {
    for (let node: SyntaxNode | null = tree.resolveInner(pos, side); node; node = node.parent) {
      if (!LINK_NODES.has(node.name)) continue;
      if (!linkIsRendered(state, activeLines, node.from, node.to)) return null;
      const href = linkHref(state, node, lookup);
      return href && isOpenableMarkdownHref(href) ? { from: node.from, to: node.to, href } : null;
    }
  }
  return null;
}

export interface LinkPointerEvent {
  button: number;
  detail: number;
  shiftKey: boolean;
  altKey: boolean;
  metaKey: boolean;
  ctrlKey: boolean;
  target: EventTarget | null;
}

export interface LinkPointerView {
  state: EditorState;
  posAtDOM(node: Node, offset?: number): number;
}

function isPlainPrimaryClick(event: LinkPointerEvent): boolean {
  return event.button === 0
    && !event.shiftKey
    && !event.altKey
    && !event.metaKey
    && !event.ctrlKey;
}

function renderedLinkForEvent(view: LinkPointerView, event: LinkPointerEvent): MarkdownLink | null {
  const target = event.target as Partial<Element> | null;
  const element = typeof target?.closest === 'function'
    ? target.closest(`.${LINK_TARGET_CLASS}`)
    : null;
  if (!element) return null;
  return renderedMarkdownLinkAt(view.state, view.posAtDOM(element, 0));
}

/**
 * Gives rendered Markdown links precedence over CodeMirror's pointer
 * selection. An unmodified primary press on a rendered link is consumed at
 * mousedown (so the editor neither moves the cursor, focuses, nor expands the
 * line), its mouseup is consumed (so live-preview activation does not run),
 * and the matching single click opens the link exactly once. Modified clicks,
 * other buttons, and links on the expanded editing line keep editor defaults.
 */
export class MarkdownLinkClickController {
  private pending: MarkdownLink | null = null;

  constructor(private readonly openLink: (href: string) => void) {}

  mousedown(view: LinkPointerView, event: LinkPointerEvent): boolean {
    this.pending = isPlainPrimaryClick(event) ? renderedLinkForEvent(view, event) : null;
    return this.pending !== null;
  }

  mouseup(): boolean {
    return this.pending !== null;
  }

  click(view: LinkPointerView, event: LinkPointerEvent): boolean {
    const pending = this.pending;
    this.pending = null;
    if (!pending) return false;
    if (event.detail > 1 || !isPlainPrimaryClick(event)) return true;
    const link = renderedLinkForEvent(view, event);
    if (link && link.from === pending.from && link.href === pending.href) this.openLink(link.href);
    return true;
  }
}

export function markdownLinkClicks(openLink: (href: string) => void): Extension {
  return Prec.high(ViewPlugin.define(() => new MarkdownLinkClickController(openLink), {
    eventHandlers: {
      mousedown(event, view) { return this.mousedown(view, event); },
      mouseup() { return this.mouseup(); },
      click(event, view) { return this.click(view, event); },
    },
  }));
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

const linkTargetDecoration = Decoration.mark({ class: `cm-live-link ${LINK_TARGET_CLASS}` });

function buildDecorations(state: EditorState): DecorationSet {
  const decorations: Range<Decoration>[] = [];
  const activeLines = activeLineStarts(state);
  const decoratedHeadingLines = new Set<number>();
  let definitions: Map<string, string> | null = null;
  const lookupDefinitions = () => (definitions ??= markdownLinkDefinitions(state));

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
      if (LINK_NODES.has(node.name) && linkIsRendered(state, activeLines, node.from, node.to)) {
        if (node.name === 'Link') {
          const [opening, closing] = node.node.getChildren('LinkMark');
          if (opening && closing) {
            decorations.push(
              Decoration.replace({ atomic: true }).range(node.from, opening.to),
              Decoration.replace({ atomic: true }).range(closing.from, node.to),
            );
          }
        }
        const href = linkHref(state, node.node, lookupDefinitions);
        if (href && isOpenableMarkdownHref(href)) {
          decorations.push(linkTargetDecoration.range(node.from, node.to));
        }
      }
      if (node.name === 'LinkMark' && node.node.parent?.name === 'Link') return;
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
  '.cm-live-link-target': {
    cursor: 'pointer',
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
