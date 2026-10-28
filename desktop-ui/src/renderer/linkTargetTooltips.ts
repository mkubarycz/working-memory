import type MarkdownIt from 'markdown-it';

export function linkTargetTooltips(markdown: InstanceType<typeof MarkdownIt>): void {
  const renderLink = markdown.renderer.rules.link_open;
  markdown.renderer.rules.link_open = (tokens, index, options, env, renderer) => {
    const token = tokens[index];
    const href = token.attrGet('href');
    if (href) {
      const title = token.attrGet('title');
      token.attrSet('title', title ? `${href}\n${title}` : href);
    }
    return renderLink
      ? renderLink(tokens, index, options, env, renderer)
      : renderer.renderToken(tokens, index, options);
  };
}
