import MarkdownIt from 'markdown-it';

const markdown = new MarkdownIt({ html: false, linkify: true, breaks: true });

export function renderMarkdown(source: string): string {
  return markdown.render(source);
}