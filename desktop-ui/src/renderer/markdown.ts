import MarkdownIt from 'markdown-it';
import { linkTargetTooltips } from './linkTargetTooltips';

const markdown = new MarkdownIt({ html: false, linkify: true, breaks: true }).use(linkTargetTooltips);

export function renderMarkdown(source: string): string {
  return markdown.render(source);
}