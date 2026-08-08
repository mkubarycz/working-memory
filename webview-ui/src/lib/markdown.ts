import MarkdownIt from 'markdown-it';

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
const md: MarkdownIt = new MarkdownIt({
  html: false,
  linkify: true,
  breaks: false,
});

/** Render markdown source to an HTML string that is safe to inject as `{@html}`. */
export function renderMarkdown(src: string): string {
  return md.render(src ?? '');
}
