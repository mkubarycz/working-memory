import { markdown } from '@codemirror/lang-markdown';
import { EditorState } from '@codemirror/state';
import { EditorView } from '@codemirror/view';
import { describe, expect, it, vi } from 'vitest';
import {
  attachmentImagePreview,
  parseMarkdownImage,
  requestMeasureWhenImageSettles,
} from '../src/renderer/documents/attachmentImages';
import { resolveMarkdownImageSource } from '../src/renderer/documents/markdown';
import { livePreviewActivated } from '../src/renderer/documents/liveMarkdownPreview';

describe('hybrid Markdown images', () => {
  it('parses attachment image syntax without changing the source', () => {
    expect(parseMarkdownImage(
      '![screen capture](wm-attachment:643b0c71-938c-4339-810c-15df424a19cf)',
    )).toEqual({
      alt: 'screen capture',
      source: 'wm-attachment:643b0c71-938c-4339-810c-15df424a19cf',
    });
  });

  it('leaves non-image and malformed syntax visible as source', () => {
    expect(parseMarkdownImage('[link](https://example.com)')).toBeNull();
    expect(parseMarkdownImage('![missing destination]()')).toBeNull();
  });

  it('resolves attachment references against the selected environment', () => {
    expect(resolveMarkdownImageSource(
      'wm-attachment:643b0c71-938c-4339-810c-15df424a19cf',
      'http://127.0.0.1:7717/',
    )).toBe(
      'http://127.0.0.1:7717/attachments/643b0c71-938c-4339-810c-15df424a19cf',
    );
    expect(resolveMarkdownImageSource(
      'https://example.com/image.png',
      'http://127.0.0.1:7717',
    )).toBe('https://example.com/image.png');
  });

  it('keeps rendered images atomic when the caret is at a source boundary', () => {
    const source = '![screen capture](wm-attachment:643b0c71-938c-4339-810c-15df424a19cf)';
    const state = EditorState.create({
      doc: source,
      selection: { anchor: source.length },
      extensions: [
        markdown(),
        livePreviewActivated,
        attachmentImagePreview('http://127.0.0.1:7717'),
      ],
    });
    const [atomicSource] = state.facet(EditorView.atomicRanges);
    const view = { state } as EditorView;
    const ranges: Array<[number, number]> = [];
    atomicSource(view).between(0, state.doc.length, (from, to) => {
      ranges.push([from, to]);
    });

    expect(ranges).toEqual([[0, source.length]]);
  });

  it('remeasures the editor after an image finishes loading', () => {
    const image = new EventTarget() as HTMLImageElement;
    Object.defineProperty(image, 'complete', { value: false });
    const requestMeasure = vi.fn();
    requestMeasureWhenImageSettles(image, requestMeasure);

    image.dispatchEvent(new Event('load'));

    expect(requestMeasure).toHaveBeenCalledOnce();
  });
});
