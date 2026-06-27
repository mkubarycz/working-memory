/**
 * Tiny URI parser shared by the extension host (tab-group watcher) and the
 * reveal-in-panel feature. Pure string in / plain-object out so it can be
 * unit-tested without importing `vscode`. Only the kinds the panel can scroll
 * to are recognized.
 */
export type RevealKind = 'session' | 'topic' | 'workstream' | 'topic-type';

export interface PanelRevealTarget {
  /**
   * The doc kind, or `null` when we only recovered a slug from a tab label and
   * can't tell session/topic/workstream apart — a null-kind target asks the
   * webview to match a row by slug/id alone.
   */
  kind: RevealKind | null;
  id: string;
}

/** The custom URI scheme our virtual docs live under. */
export const WM_SCHEME = 'working-memory';

const REVEAL_URI_RE =
  /^working-memory:\/(session|topic|workstream|topic-type)\/(.+)\.md$/;

/**
 * Parse a `working-memory:/<kind>/<id>.md` URI string into a reveal target.
 * Returns null for anything that isn't a revealable WM doc. Pass
 * `uri.scheme + ':' + uri.path` from a `vscode.Uri`.
 */
export function parsePanelRevealTarget(uri: string): PanelRevealTarget | null {
  const match = REVEAL_URI_RE.exec(uri);
  if (!match) {
    return null;
  }
  const kind = match[1] as RevealKind;
  let id = match[2];
  try {
    id = decodeURIComponent(id);
  } catch {
    // Keep the raw segment if it isn't valid percent-encoding.
  }
  if (!id) {
    return null;
  }
  return { kind, id };
}

/**
 * Whether a webview tab's `viewType` is VS Code's built-in Markdown preview.
 * The host surfaces it as `mainThreadWebview-markdown.preview`, so we match on
 * substrings (`markdown` + `preview`) to survive a future prefix change.
 */
export function isMarkdownPreviewViewType(
  viewType: string | undefined,
): boolean {
  if (typeof viewType !== 'string') {
    return false;
  }
  const v = viewType.toLowerCase();
  return v.includes('markdown') && v.includes('preview');
}

/**
 * Minimal, vscode-free description of one open editor tab, so this module stays
 * pure and unit-testable. A `preview` tab exposes NO source URI — only a
 * `label` — which is why we disambiguate previews by matching their label
 * against the open `text` tabs.
 */
export interface TabDescriptor {
  kind: 'text' | 'preview' | 'other';
  /** URI scheme for `text` tabs (e.g. `working-memory`, `file`). */
  scheme?: string;
  /** Percent-decoded `uri.path` for `text` tabs. */
  path?: string;
  /** Tab label (basename for text tabs, `"Preview <name>"` for previews). */
  label?: string;
}

/** Last path segment of a `/`-delimited path (the file basename). */
export function basenameFromPath(path: string): string {
  const idx = path.lastIndexOf('/');
  return idx >= 0 ? path.slice(idx + 1) : path;
}

/**
 * Recover the likely source basename a Markdown Preview tab is previewing from
 * its label (`"Preview <filename>"`). The `.md` extension may or may not be
 * present, so callers compare with extension stripped.
 */
export function previewSourceBasename(label: string | undefined): string {
  if (!label) {
    return '';
  }
  return label.replace(/^\s*Preview\s+/i, '').trim();
}

/** Strip a single trailing `.md` (case-insensitive) for label comparison. */
function stripMd(name: string): string {
  return name.replace(/\.md$/i, '');
}

const PREVIEW_PREFIX_RE = /^\s*Preview\s+/i;

/**
 * Derive a WM doc slug from a tab label, or `''` when the label doesn't look
 * like a WM doc basename. A WM virtual doc in Markdown Preview is labeled with
 * the bare basename `"<slug>.md"` (no source URI on the tab); older surfaces
 * use `"Preview <slug>"`. We accept either and reject anything else.
 */
export function slugFromLabel(label: string | undefined): string {
  if (!label) {
    return '';
  }
  const hasPreviewPrefix = PREVIEW_PREFIX_RE.test(label);
  const stripped = label.replace(PREVIEW_PREFIX_RE, '').trim();
  const hasMd = /\.md$/i.test(stripped);
  if (!hasPreviewPrefix && !hasMd) {
    return '';
  }
  return stripMd(stripped).trim();
}

/**
 * Pure reveal router driven by the open-tabs snapshot. Markdown Preview tabs
 * expose no source URI, so rather than guessing we recover the source by
 * scanning every open tab for the `working-memory:` text doc the preview was
 * opened from (a preview is always opened from its source editor).
 *
 * Rules, given the full `tabs` snapshot and the `active` tab:
 * 1. Active WM text tab → reveal it directly.
 * 2. Active Markdown Preview → recover the source from the open WM text tabs
 *    (one tab: use it; several: match the preview label's basename).
 * 3. Active non-text tab whose label looks like a WM doc basename (the real
 *    runtime case) → match an open WM text tab to recover the kind, else emit
 *    a kind-less `{ kind: null, id: slug }` for slug-only matching.
 * 4. Anything else → null.
 */
export function resolveRevealFromTabs(
  tabs: readonly TabDescriptor[],
  active: TabDescriptor | null,
): PanelRevealTarget | null {
  if (!active) {
    return null;
  }

  // 1. Active WM text tab — reveal it directly.
  if (active.kind === 'text' && active.scheme === WM_SCHEME && active.path) {
    return parsePanelRevealTarget(`${WM_SCHEME}:${active.path}`);
  }

  // 2. Active Markdown Preview — recover its source from the open WM text tabs.
  if (active.kind === 'preview') {
    const wmTextTabs = tabs.filter(
      (t): t is TabDescriptor & { path: string } =>
        t.kind === 'text' && t.scheme === WM_SCHEME && !!t.path,
    );
    if (wmTextTabs.length === 0) {
      return null;
    }
    if (wmTextTabs.length === 1) {
      return parsePanelRevealTarget(`${WM_SCHEME}:${wmTextTabs[0].path}`);
    }
    // Several WM docs open — match the preview label's basename to a source.
    const wanted = stripMd(previewSourceBasename(active.label));
    const match = wmTextTabs.find(
      (t) => stripMd(basenameFromPath(t.path)) === wanted,
    );
    return match ? parsePanelRevealTarget(`${WM_SCHEME}:${match.path}`) : null;
  }

  // 3. Active non-text tab whose label looks like a WM doc basename. This is
  //    the real runtime case for a WM doc in Markdown Preview / a custom
  //    editor: it classifies as 'other' with a bare `"<slug>.md"` label and no
  //    source URI on the tab. Recover the slug from the label and resolve it.
  if (active.kind !== 'text') {
    const activeLabelSlug = slugFromLabel(active.label);
    if (activeLabelSlug) {
      // (a) Disambiguate via an open WM text tab with the same basename — this
      //     hands us the kind for free from the still-open source doc.
      const wmTextTabs = tabs.filter(
        (t): t is TabDescriptor & { path: string } =>
          t.kind === 'text' && t.scheme === WM_SCHEME && !!t.path,
      );
      const match = wmTextTabs.find(
        (t) => stripMd(basenameFromPath(t.path)) === activeLabelSlug,
      );
      if (match) {
        return parsePanelRevealTarget(`${WM_SCHEME}:${match.path}`);
      }
      // (b) No matching source text tab open — emit a kind-less reveal-by-slug
      //     so the webview can match a row by slug alone.
      return { kind: null, id: activeLabelSlug };
    }
  }

  // 4. Everything else clears.
  return null;
}
