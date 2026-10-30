import MarkdownIt from 'markdown-it';
import { linkTargetTooltips } from '../linkTargetTooltips';

/**
 * Shared markdown-it instance for the webview. `html: false` is the security
 * pivot: any raw HTML the author types (e.g. `<script>`, `<img onerror=...>`)
 * is ESCAPED into text rather than emitted as live markup, so the rendered
 * output is safe to inject via `{@html}`. `linkify` autolinks bare URLs and
 * `breaks: false` keeps standard markdown paragraph semantics.
 *
 * (Defense-in-depth note: if we ever set `html: true` to allow authored HTML,
 * this is where a DOMPurify.sanitize() pass on the returned string would slot
 * in. With `html: false` there is no raw-HTML injection surface, so it's not
 * needed for this MVP.)
 */
const md = new MarkdownIt({
  html: false,
  linkify: true,
  breaks: false,
}).use(linkTargetTooltips);

export const unescapeMarkdown = md.utils.unescapeAll;

const defaultImageRenderer = md.renderer.rules.image;

export function imageOpenButton(source: string): string {
  return `<button type="button" class="markdown-image-open" data-image-source="${md.utils.escapeHtml(source)}"`
    + ' title="Open image in default viewer" aria-label="Open image in default viewer">'
    + '<span class="codicon codicon-zoom-in" aria-hidden="true"></span></button>';
}

export function resolveMarkdownImageSource(src: string, attachmentBaseUrl = ''): string {
  const match = /^wm-attachment:([0-9a-f-]+)$/.exec(src);
  const baseUrl = attachmentBaseUrl.replace(/\/$/, '');
  return match && baseUrl ? `${baseUrl}/attachments/${match[1]}` : src;
}

md.renderer.rules.image = (tokens, idx, options, env, self) => {
  const srcIndex = tokens[idx].attrIndex('src');
  const src = srcIndex >= 0 ? tokens[idx].attrs?.[srcIndex]?.[1] : undefined;
  const attachmentBaseUrl = typeof env?.attachmentBaseUrl === 'string'
    ? env.attachmentBaseUrl
    : '';
  if (src && srcIndex >= 0 && tokens[idx].attrs) {
    tokens[idx].attrs![srcIndex][1] = resolveMarkdownImageSource(String(src), attachmentBaseUrl);
  }
  const image = defaultImageRenderer
    ? defaultImageRenderer(tokens, idx, options, env, self)
    : self.renderToken(tokens, idx, options);
  const resolvedSource = String(tokens[idx].attrGet('src') ?? '');
  return `<span class="markdown-image">${image}${imageOpenButton(resolvedSource)}</span>`;
};

/** Render markdown source to an HTML string that is safe to inject as `{@html}`. */
export function renderMarkdown(src: string, attachmentBaseUrl = ''): string {
  return md.render(src ?? '', { attachmentBaseUrl });
}
