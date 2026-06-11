export type PanelRevealKind = 'session' | 'topic' | 'workstream';

export interface PanelRevealTarget {
  kind: PanelRevealKind;
  id: string;
}

const PANEL_REVEAL_URI_RE = /^working-memory:\/(session|topic|workstream)\/(.+)\.md$/;

export function parsePanelRevealTarget(
  uri: string | undefined | null,
): PanelRevealTarget | null {
  if (!uri) {
    return null;
  }
  const match = PANEL_REVEAL_URI_RE.exec(uri);
  if (!match || !match[1] || !match[2]) {
    return null;
  }
  let id = match[2];
  try {
    id = decodeURIComponent(id);
  } catch {
    // Keep the raw id when decode fails; we still want best-effort reveal.
  }
  if (!id) {
    return null;
  }
  return {
    kind: match[1] as PanelRevealKind,
    id,
  };
}
