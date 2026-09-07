import { describe, expect, it } from 'vitest';
import { renderMarkdown } from '../src/renderer/markdown';

describe('desktop assistant Markdown', () => {
  it('renders headings, emphasis, and lists as formatted HTML', () => {
    const rendered = renderMarkdown('### Working Memory\n\n- **Status:** In progress');

    expect(rendered).toContain('<h3>Working Memory</h3>');
    expect(rendered).toContain('<li><strong>Status:</strong> In progress</li>');
    expect(rendered).not.toContain('### Working Memory');
  });

  it('escapes raw HTML from model responses', () => {
    const rendered = renderMarkdown('<script>alert("no")</script>');

    expect(rendered).not.toContain('<script>');
    expect(rendered).toContain('&lt;script&gt;');
  });
});