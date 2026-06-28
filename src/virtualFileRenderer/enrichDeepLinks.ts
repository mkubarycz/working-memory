import { JournalStore } from '../db';

// ── Deep-link enrichment ─────────────────────────────────────────────────────
//
// In rendered markdown previews we rewrite every Working Memory deep-link so it
// shows (1) a leading type codicon and (2) a small child-count where it is
// meaningful. This runs as a single post-pass over already-generated markdown
// (see `enrichDeepLinks`) so we don't have to thread icon/count logic through
// every emission site. The codicon font is loaded into the preview sandbox via
// `contributes.markdown.previewStyles` (media/codicons/codicon.css).

type DeepLinkKind = 'topic' | 'session' | 'workstream' | 'topic-type';

const DEEP_LINK_FIXED_ICON: Record<Exclude<DeepLinkKind, 'topic'>, string> = {
  session: 'comment-discussion',
  workstream: 'repo',
  'topic-type': 'tag',
};

const DEEP_LINK_FALLBACK_ICON = 'symbol-misc';

// [label](vscode://kubarycz.working-memory/open/<kind>/<id>)
const DEEP_LINK_RE =
  /\[([^\]]+)\]\((vscode:\/\/kubarycz\.working-memory\/open\/(topic|session|workstream|topic-type)\/([^)\s]+))\)/g;

function safeDecode(s: string): string {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
}

function iconForDeepLink(
  store: JournalStore,
  kind: DeepLinkKind,
  id: string,
): string {
  if (kind === 'topic') {
    const topic = store.getTopic(id);
    if (topic) {
      const tt = store.getTopicType(topic.topic_type);
      if (tt?.icon) {
        return tt.icon;
      }
    }
    return DEEP_LINK_FALLBACK_ICON;
  }
  return DEEP_LINK_FIXED_ICON[kind];
}

/**
 * Child-count for a deep-link, or `null` when not meaningful (zero, or a
 * reference rather than the entity's own link). `labelStartsWithHash` is true
 * for entry-reference links like `[#123](…workstream…)` — those point at a
 * workstream but represent an entry, so a workstream topic-count would be
 * misleading; we suppress it.
 */
function countForDeepLink(
  store: JournalStore,
  kind: DeepLinkKind,
  id: string,
  labelStartsWithHash: boolean,
): number | null {
  if (kind === 'topic') {
    const n = store.listTopicChildren(id).length;
    return n > 0 ? n : null;
  }
  if (kind === 'session') {
    const n = store.listEntriesForSession(id).length;
    return n > 0 ? n : null;
  }
  if (kind === 'workstream') {
    if (labelStartsWithHash) {
      return null;
    }
    const ws = store.getWorkstreamBySlug(id);
    if (!ws) {
      return null;
    }
    const n = store.listTopicsForWorkstream(ws.id).length;
    return n > 0 ? n : null;
  }
  return null;
}

/**
 * Rewrite Working Memory deep-links in a generated markdown document so each
 * gets a leading type codicon and, where meaningful, a `(N)` child-count in its
 * label. Links inside fenced code blocks are left untouched.
 */
export function enrichDeepLinks(store: JournalStore, markdown: string): string {
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
      (_match, label: string, url: string, kind: DeepLinkKind, rawId: string) => {
        const id = safeDecode(rawId);
        const icon = iconForDeepLink(store, kind, id);
        const count = countForDeepLink(
          store,
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
