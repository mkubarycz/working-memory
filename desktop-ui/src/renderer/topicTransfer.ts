import type { DesktopApi } from '../shared/contracts';

export interface TopicDragSource {
  id: string;
  sourceWorkstream: string;
}

export interface TopicTransferRequest extends TopicDragSource {
  targetWorkstream: string;
  move: boolean;
}

export interface NewWorkstreamMoveDraft extends TopicDragSource {
  title: string;
  targetWorkstream: string;
}

export async function moveTopicToNewWorkstream(
  draft: NewWorkstreamMoveDraft,
  api: Pick<DesktopApi, 'createWorkstream'>,
  transfer: (request: TopicTransferRequest) => Promise<void>,
): Promise<void> {
  if (!draft.targetWorkstream) {
    const workstream = await api.createWorkstream(draft.title);
    draft.targetWorkstream = workstream.id;
    draft.title = workstream.title;
  }
  try {
    await transfer({
      id: draft.id,
      sourceWorkstream: draft.sourceWorkstream,
      targetWorkstream: draft.targetWorkstream,
      move: true,
    });
  } catch (reason) {
    throw new Error(
      `Workstream "${draft.title}" was created, but the topic could not be moved. ` +
      `Retry to move it to the same workstream. ${reason instanceof Error ? reason.message : String(reason)}`,
    );
  }
}

export interface TopicTransferRefreshCandidate {
  kind: string;
  id?: string | null;
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
  if (!source?.id || !source.sourceWorkstream || !targetWorkstream || source.sourceWorkstream === targetWorkstream) {
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
    if (!document.id) continue;
    if (document.kind === 'topic') {
      targets.push({ kind: 'topic', identifier: document.id, key: `topic:${document.id}` });
      continue;
    }
    if (document.kind === 'workstream' &&
      (document.id === sourceWorkstream || document.id === targetWorkstream)) {
      targets.push({ kind: 'workstream', identifier: document.id, key: `workstream:${document.id}` });
    }
  }
  return targets;
}
