/**
 * Deep-link enrichment for rendered control-plane virtual docs (WM 13.0.2
 * `feature-friendly-wm-links`, ported from the 12.x
 * `virtualFileRenderer/enrichDeepLinks`).
 *
 * In rendered markdown previews we rewrite every Working Memory deep-link so it
 * shows (1) a leading type codicon and (2) a small child-count where it is
 * meaningful. This runs as a single PURE post-pass over already-generated
 * markdown (see `enrichDeepLinks`) so we don't thread icon/count logic through
 * every per-kind renderer emission site. The codicon font is loaded into the
 * preview sandbox via `contributes.markdown.previewStyles`
 * (media/codicons/codicon.css).
 *
 * Unlike the 12.x version — which reached into the journal `JournalStore` — this
 * module is fed an injected {@link DeepLinkContext} so it stays VS Code-free and
 * I/O-free (hence directly unit-testable). `contentProvider.ts` builds the
 * context from the control plane and runs this pass over the final markdown.
 *
 * `session` deep-links are intentionally DROPPED here: sessions don't live in
 * the control plane, so a session link carries no enrichable icon/count and is
 * left exactly as authored.
 */

/** The deep-link kinds this pass enriches (session is intentionally excluded). */
type EnrichableKind = 'topic' | 'workstream' | 'topic-type' | 'alert';

/** Fixed codicons for non-topic kinds. `alert` is skipped before this is read. */
const FIXED_ICON: Record<Exclude<EnrichableKind, 'topic'>, string> = {
  workstream: 'repo',
  'topic-type': 'tag',
  alert: 'warning',
};

/** Fallback icon when a topic (or its topic-type) can't be resolved. */
export const DEEP_LINK_FALLBACK_ICON = 'symbol-misc';

// [label](vscode://kubarycz.working-memory/open/<kind>/<id>) — session dropped.
const DEEP_LINK_RE =
  /\[([^\]]+)\]\((vscode:\/\/kubarycz\.working-memory\/open\/(topic|workstream|topic-type|alert)\/([^)\s]+))\)/g;

/**
 * Injected lookup the pure enrichment pass uses to resolve icons + counts. Built
 * once per render from the control plane (all topics / topic-types /
 * workstreams) — see `contentProvider.ts`. Every method degrades gracefully:
 * unknown slugs yield the fallback icon / a zero count so a dangling reference
 * never breaks the link.
 */
export interface DeepLinkContext {
  /** Icon for a topic-type slug (its `icon`), or the fallback when unknown. */
  topicTypeIcon(slug: string): string;
  /** The topic-type slug a topic uses, or null when the topic is unknown. */
  topicTypeOf(slug: string): string | null;
  /** Number of child topics (topics whose `parents` includes this slug). */
  topicChildCount(slug: string): number;
  /** Number of topics whose `workstreams` includes this workstream slug. */
  workstreamTopicCount(slug: string): number;
}

function safeDecode(s: string): string {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
}

function iconForDeepLink(
  ctx: DeepLinkContext,
  kind: EnrichableKind,
  id: string,
): string {
  if (kind === 'topic') {
    const type = ctx.topicTypeOf(id);
    return type ? ctx.topicTypeIcon(type) : DEEP_LINK_FALLBACK_ICON;
  }
  return FIXED_ICON[kind];
}

/**
 * Child-count for a deep-link, or `null` when not meaningful (zero, or a
 * reference rather than the entity's own link). `labelStartsWithHash` is true
 * for entry-reference links like `[#123](…workstream…)` — those point at a
 * workstream but represent an entry, so a workstream topic-count would be
 * misleading; we suppress it.
 */
function countForDeepLink(
  ctx: DeepLinkContext,
  kind: EnrichableKind,
  id: string,
  labelStartsWithHash: boolean,
): number | null {
  if (kind === 'topic') {
    const n = ctx.topicChildCount(id);
    return n > 0 ? n : null;
  }
  if (kind === 'workstream') {
    if (labelStartsWithHash) {
      return null;
    }
    const n = ctx.workstreamTopicCount(id);
    return n > 0 ? n : null;
  }
  return null;
}

/**
 * Rewrite Working Memory deep-links in a generated markdown document so each
 * gets a leading type codicon and, where meaningful, a `(N)` child-count in its
 * label. Links inside fenced code blocks (``` / ~~~) are left untouched; `alert`
 * links (which carry their own status icon at the render site) and labels that
 * already contain a `codicon-` span are skipped so we never double-icon.
 */
export function enrichDeepLinks(markdown: string, ctx: DeepLinkContext): string {
  const lines = markdown.split('\n');
  let inFence = false;
  for (let i = 0; i < lines.length; i++) {
    const trimmed = lines[i].trim();
    if (trimmed.startsWith('```') || trimmed.startsWith('~~~')) {
      inFence = !inFence;
      continue;
    }
    if (inFence) {
      continue;
    }
    lines[i] = lines[i].replace(
      DEEP_LINK_RE,
      (
        match,
        label: string,
        url: string,
        kind: EnrichableKind,
        rawId: string,
      ) => {
        // Alert links carry their own status icon (bell/info/pass) emitted at
        // the render site, and labels that already contain a codicon span are
        // pre-iconned — don't double up.
        if (kind === 'alert' || label.includes('codicon-')) {
          return match;
        }
        const id = safeDecode(rawId);
        const icon = iconForDeepLink(ctx, kind, id);
        const count = countForDeepLink(
          ctx,
          kind,
          id,
          label.trimStart().startsWith('#'),
        );
        const newLabel = count !== null ? `${label} (${count})` : label;
        return `[<span class="codicon codicon-${icon}"></span> ${newLabel}](${url})`;
      },
    );
  }
  return lines.join('\n');
}
