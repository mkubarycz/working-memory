export interface TopicDragSource {
  slug: string;
  sourceWorkstream: string;
}

export interface TopicTransferRequest extends TopicDragSource {
  targetWorkstream: string;
  move: boolean;
}

export interface TopicTransferRefreshCandidate {
  kind: string;
  slug?: string | null;
}

export interface TopicTransferRefreshTarget {
  kind: 'topic' | 'workstream';
  identifier: string;
  key: string;
}

export function planTopicTransfer(
  source: TopicDragSource | null,
  targetWorkstream: string,
  move: boolean,
): TopicTransferRequest | null {
  if (!source?.slug || !source.sourceWorkstream || !targetWorkstream || source.sourceWorkstream === targetWorkstream) {
    return null;
  }
  return { ...source, targetWorkstream, move };
}

export function topicTransferRefreshTargets(
  documents: TopicTransferRefreshCandidate[],
  sourceWorkstream: string,
  targetWorkstream: string,
): TopicTransferRefreshTarget[] {
  const targets: TopicTransferRefreshTarget[] = [];
  for (const document of documents) {
    if (!document.slug) continue;
    if (document.kind === 'topic') {
      targets.push({ kind: 'topic', identifier: document.slug, key: `topic:${document.slug}` });
      continue;
    }
    if (document.kind === 'workstream' &&
      (document.slug === sourceWorkstream || document.slug === targetWorkstream)) {
      targets.push({ kind: 'workstream', identifier: document.slug, key: `workstream:${document.slug}` });
    }
  }
  return targets;
}