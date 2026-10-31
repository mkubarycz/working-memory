import TurndownService from 'turndown';
import { isOpenableMarkdownHref } from './liveMarkdownPreview';

const converter = new TurndownService({
  headingStyle: 'atx',
  codeBlockStyle: 'fenced',
  bulletListMarker: '-',
});

converter.remove(['script', 'style', 'iframe', 'object', 'embed', 'template', 'noscript']);
converter.addRule('unroutableLinks', {
  filter: node => node.nodeName === 'A'
    && !isOpenableMarkdownHref(node.getAttribute('href')?.trim() ?? ''),
  replacement: content => content,
});
converter.addRule('unsupportedImages', {
  filter: node => node.nodeName === 'IMG'
    && !/^(?:https?:|wm-attachment:|\/[^/])/i.test(node.getAttribute('src')?.trim() ?? ''),
  replacement: (_content, node) => converter.escape(node.getAttribute('alt') ?? ''),
});

export function markdownFromClipboard(clipboard: Pick<DataTransfer, 'getData'> | null): string | null {
  const html = clipboard?.getData('text/html');
  return html?.trim() ? converter.turndown(html) : null;
}
