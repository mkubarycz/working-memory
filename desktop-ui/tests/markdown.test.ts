import { describe, expect, it } from 'vitest';
import { renderMarkdown } from '../src/renderer/markdown';
import { renderMarkdown as renderDocumentMarkdown } from '../src/renderer/documents/markdown';

describe('desktop assistant Markdown', () => {
  it('renders headings, emphasis, and lists as formatted HTML', () => {
    const rendered = renderMarkdown('### Working Memory\n\n- **Status:** In progress');

    expect(rendered).toContain('<h3>Working Memory</h3>');
    expect(rendered).toContain('<li><strong>Status:</strong> In progress</li>');
    expect(rendered).not.toContain('### Working Memory');
  });

  describe.each([
    ['chat', renderMarkdown],
    ['documents', renderDocumentMarkdown],
  ] as const)('%s link target tooltips', (_surface, render) => {
    it.each([
      ['[External](https://example.com/path?q=one&next=two)', 'https://example.com/path?q=one&amp;next=two'],
      ['[Internal](working-memory://open/topic/topic-id)', 'working-memory://open/topic/topic-id'],
      ['[Bridge](http://127.0.0.1:7718/open/topic/topic-id)', 'http://127.0.0.1:7718/open/topic/topic-id'],
      ['[Reference][docs]\n\n[docs]: https://example.com/docs', 'https://example.com/docs'],
      ['<https://example.com/auto>', 'https://example.com/auto'],
      ['https://example.com/bare', 'https://example.com/bare'],
      ['[Email](mailto:hello@example.com)', 'mailto:hello@example.com'],
      ['[File](wm-attachment:attachment-id)', 'wm-attachment:attachment-id'],
    ])('shows the rendered destination for %s', (source, href) => {
      expect(render(source)).toContain(`href="${href}" title="${href}"`);
    });

    it('preserves an authored title alongside the target URL without changing source', () => {
      const source = '[Documentation](https://example.com "Helpful description")';
      expect(render(source)).toContain('title="https://example.com\nHelpful description"');
      expect(render(source)).toContain('>Documentation</a>');
      expect(source).toBe('[Documentation](https://example.com "Helpful description")');
    });

    it('escapes tooltip attributes and retains unsafe-link filtering', () => {
      const html = render('[safe](https://example.com "A &quot;quote&quot; & text")');
      expect(html).toContain('title="https://example.com\nA &quot;quote&quot; &amp; text"');
      expect(render('[bad](javascript:alert%281%29)')).not.toContain('<a ');
    });
  });

  it('escapes raw HTML from model responses', () => {
    const rendered = renderMarkdown('<script>alert("no")</script>');

    expect(rendered).not.toContain('<script>');
    expect(rendered).toContain('&lt;script&gt;');
  });
});