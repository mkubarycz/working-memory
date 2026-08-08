import { describe, expect, it } from 'vitest';
import { renderMarkdown } from '../webview-ui/src/lib/markdown';

describe('renderMarkdown', () => {
  it('renders a heading', () => {
    expect(renderMarkdown('# Hello')).toContain('<h1>Hello</h1>');
  });

  it('renders an unordered list', () => {
    const html = renderMarkdown('- one\n- two');
    expect(html).toContain('<ul>');
    expect(html).toContain('<li>one</li>');
    expect(html).toContain('<li>two</li>');
  });

  it('renders a link', () => {
    const html = renderMarkdown('[VS Code](https://code.visualstudio.com)');
    expect(html).toContain('<a href="https://code.visualstudio.com">VS Code</a>');
  });

  it('renders a fenced code block', () => {
    const html = renderMarkdown('```\nconst x = 1;\n```');
    expect(html).toContain('<pre>');
    expect(html).toContain('<code>');
    expect(html).toContain('const x = 1;');
  });

  it('autolinks bare URLs (linkify)', () => {
    const html = renderMarkdown('see https://example.com now');
    expect(html).toContain('<a href="https://example.com">');
  });

  // Security guard: markdown-it is configured `html: false`, so authored raw
  // HTML must be ESCAPED, never emitted as live markup.
  it('escapes a raw <script> tag instead of injecting it', () => {
    const html = renderMarkdown('<script>alert(1)</script>');
    expect(html).not.toContain('<script>');
    expect(html).toContain('&lt;script&gt;');
  });

  it('escapes an <img onerror> XSS payload', () => {
    const html = renderMarkdown('<img src=x onerror=alert(1)>');
    expect(html).not.toContain('<img');
    expect(html).toContain('&lt;img');
  });

  it('does not emit an onerror attribute as live markup', () => {
    const html = renderMarkdown('hi <img src=x onerror="alert(document.cookie)">');
    expect(html).not.toMatch(/<img[^>]*onerror/i);
  });
});
