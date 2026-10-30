import { describe, expect, it } from 'vitest';
import { markdownFromClipboard } from '../src/renderer/documents/markdownPaste';
import { renderMarkdown } from '../src/renderer/documents/markdown';

const incidentUrl = 'https://example.com/incidents/details/123456789/summary';
const incidentTitle = 'Incident 123456789 : <Declared Outage><Example Customer>An operation is currently performing on this storage account that requires exclusive access.';
const clipboard = (html: string) => ({ getData: (type: string) => type === 'text/html' ? html : incidentTitle });

describe('rich-text Markdown paste', () => {
  it('preserves the incident title, literal angle brackets and its link', () => {
    const source = markdownFromClipboard(clipboard(
      `<html><body><!--StartFragment--><p><a href="${incidentUrl}">`
      + incidentTitle.replace(/</g, '&lt;').replace(/>/g, '&gt;')
      + '</a></p><!--EndFragment--></body></html>',
    ))!;
    const rendered = renderMarkdown(source);
    expect(source).toContain(incidentUrl);
    expect(rendered).toContain(`href="${incidentUrl}"`);
    expect(rendered).toContain('&lt;Declared Outage&gt;&lt;Example Customer&gt;');
    expect(rendered).toContain('requires exclusive access.');
  });

  it('converts headings, paragraphs, inline formatting, lists, and code to Markdown', () => {
    const source = markdownFromClipboard(clipboard(
      '<h2>Heading</h2><p><strong>bold</strong> and <em>italic</em> <code>x &lt; y</code></p>'
      + '<ul><li>one</li><li>two</li></ul><pre><code>const x = 1;</code></pre>',
    ))!;
    expect(source).toContain('## Heading');
    expect(source).toContain('**bold** and _italic_ `x < y`');
    expect(source).toMatch(/- +one\n- +two/);
    expect(source).toContain('```\nconst x = 1;\n```');
  });

  it('keeps plain-text and Markdown paste on the native path', () => {
    expect(markdownFromClipboard(null)).toBeNull();
    expect(markdownFromClipboard(clipboard(''))).toBeNull();
    expect(markdownFromClipboard(clipboard(' \n '))).toBeNull();
  });

  it('escapes Markdown-like text and strips executable markup and unsafe link targets', () => {
    const source = markdownFromClipboard(clipboard(
      '<script>alert(1)</script><style>body{display:none}</style>'
      + '<p>*literal* <a href="javascript:alert(2)">label</a>'
      + '<a href="data:text/html,test">data label</a></p>'
      + '<iframe src="https://example.com">frame</iframe>',
    ))!;
    expect(source).toContain('\\*literal\\*');
    expect(source).toContain('label');
    expect(source).not.toMatch(/alert|javascript:|data:|display:none|iframe|frame/);
    expect(renderMarkdown(source)).not.toContain('<em>');
  });

  it('preserves valid attachment references and does not persist local clipboard image URLs', () => {
    const source = markdownFromClipboard(clipboard(
      '<img src="wm-attachment:60138e0f-1ca7-460d-a66b-2bc80fb82942" alt="screenshot">'
      + '<img src="file:///private/clipboard.png" alt="local">'
      + '<img src="data:image/png;base64,abc" alt="embedded">'
      + '<a href="working-memory://open/topic/next">next</a>',
    ))!;
    expect(source).toContain('![screenshot](wm-attachment:60138e0f-1ca7-460d-a66b-2bc80fb82942)');
    expect(source).toContain('[next](working-memory://open/topic/next)');
    expect(source).not.toMatch(/file:|data:/);
    expect(source).toContain('local');
    expect(source).toContain('embedded');
  });

  it('escapes link destination parentheses and decodes HTML entities once', () => {
    const source = markdownFromClipboard(clipboard(
      '<a href="https://example.com/a(1)?a=1&amp;b=2">A [label] &amp; B</a>',
    ))!;
    const rendered = renderMarkdown(source);
    expect(rendered).toContain('href="https://example.com/a(1)?a=1&amp;b=2"');
    expect(rendered).toContain('A [label] &amp; B</a>');
  });
});
