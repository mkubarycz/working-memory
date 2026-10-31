import { StateField, type EditorState, type Range } from '@codemirror/state';
import { syntaxTree } from '@codemirror/language';
import {
  Decoration,
  EditorView,
  WidgetType,
  type DecorationSet,
} from '@codemirror/view';
import { imageOpenButton, resolveMarkdownImageSource } from './markdown';
import { livePreviewActivated } from './liveMarkdownPreview';

const IMAGE_PATTERN = /^!\[([^\]]*)\]\((\S+?)(?:\s+["'][^"']*["'])?\)$/;

export interface MarkdownImage {
  alt: string;
  source: string;
}

export function parseMarkdownImage(value: string): MarkdownImage | null {
  const match = IMAGE_PATTERN.exec(value);
  return match ? { alt: match[1], source: match[2] } : null;
}

export function requestMeasureWhenImageSettles(
  image: HTMLImageElement,
  requestMeasure: () => void,
): void {
  if (image.complete) {
    queueMicrotask(requestMeasure);
    return;
  }
  image.addEventListener('load', requestMeasure, { once: true });
  image.addEventListener('error', requestMeasure, { once: true });
}

class ImageWidget extends WidgetType {
  constructor(
    private readonly image: MarkdownImage,
    private readonly attachmentBaseUrl: string,
  ) {
    super();
  }

  eq(other: ImageWidget): boolean {
    return other.image.alt === this.image.alt
      && other.image.source === this.image.source
      && other.attachmentBaseUrl === this.attachmentBaseUrl;
  }

  toDOM(view: EditorView): HTMLElement {
    const figure = document.createElement('figure');
    figure.className = 'hybrid-markdown-image';
    const image = document.createElement('img');
    image.src = resolveMarkdownImageSource(this.image.source, this.attachmentBaseUrl);
    image.alt = this.image.alt;
    image.loading = 'lazy';
    requestMeasureWhenImageSettles(image, () => view.requestMeasure());
    const container = document.createElement('span');
    container.className = 'markdown-image';
    container.appendChild(image);
    container.insertAdjacentHTML('beforeend', imageOpenButton(image.src));
    figure.appendChild(container);
    return figure;
  }

  ignoreEvent(event: Event): boolean {
    return event.type === 'contextmenu'
      || (event instanceof MouseEvent && event.button === 2)
      || (event.target instanceof Element && Boolean(event.target.closest('.markdown-image-open')));
  }
}

function selectionTouches(state: EditorState, from: number, to: number): boolean {
  if (!state.field(livePreviewActivated, false)) return false;
  return state.selection.ranges.some((range) => (
    range.empty
      ? range.head > from && range.head < to
      : range.from < to && range.to > from
  ));
}

function buildImageDecorations(
  state: EditorState,
  attachmentBaseUrl: string,
): DecorationSet {
  const decorations: Range<Decoration>[] = [];
  syntaxTree(state).iterate({
    enter(node) {
      if (node.name !== 'Image' || selectionTouches(state, node.from, node.to)) return;
      const parsed = parseMarkdownImage(state.doc.sliceString(node.from, node.to));
      if (!parsed) return;
      decorations.push(
        Decoration.replace({
          atomic: true,
          block: true,
          widget: new ImageWidget(parsed, attachmentBaseUrl),
        }).range(node.from, node.to),
      );
    },
  });
  return Decoration.set(decorations, true);
}

export function attachmentImagePreview(attachmentBaseUrl: string) {
  return StateField.define<DecorationSet>({
    create: (state) => buildImageDecorations(state, attachmentBaseUrl),
    update: (decorations, transaction) => (
      transaction.docChanged || transaction.selection
        ? buildImageDecorations(transaction.state, attachmentBaseUrl)
        : decorations
    ),
    provide: (field) => [
      EditorView.decorations.from(field),
      EditorView.atomicRanges.of((view) => view.state.field(field)),
    ],
  });
}
