import type { DesktopApi } from '../shared/contracts';
import type { DocumentVM, TopicCreateDraftVM } from './documents/types';

export async function createTopicFromDraft(
  draft: TopicCreateDraftVM,
  api: Pick<DesktopApi, 'createWorkstream' | 'createTopic'>,
): Promise<DocumentVM> {
  if (draft.newWorkstreamTitle !== undefined && !draft.workstream) {
    const created = await api.createWorkstream(draft.newWorkstreamTitle);
    // Retain the new id so retrying a failed topic save reuses this workstream.
    draft.workstream = created.id;
    draft.workstreamTitle = created.title;
  }
  try {
    return await api.createTopic({
      title: draft.title,
      body: draft.body,
      topicType: draft.topicType,
      workstream: draft.workstream,
      ...(draft.parent ? { parent: draft.parent } : {}),
    });
  } catch (reason) {
    if (draft.newWorkstreamTitle === undefined) throw reason;
    throw new Error(
      `Workstream "${draft.workstreamTitle}" was created, but its first topic could not be saved. ` +
      `Retry to save the topic in the same workstream. ${reason instanceof Error ? reason.message : String(reason)}`,
    );
  }
}
