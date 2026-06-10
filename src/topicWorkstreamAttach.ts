import { type JournalStore, type LinkWorkstreamTopicResult } from './db';
import {
  getTopicNeighborhood,
  makeGraphContext,
  TRAVERSAL_MODES,
  type TraversalModeId,
} from './graphTraversals';

export type LinkWorkstreamTopicTraversalInput = {
  workstream_slug: string;
  topic_slug: string;
  focused?: boolean;
  traversal?: TraversalModeId;
  includeClosed?: boolean;
};

export type LinkWorkstreamTopicTraversalResult = {
  traversal: TraversalModeId;
  linked: Pick<
    LinkWorkstreamTopicResult,
    'topic_slug' | 'link_created' | 'link_restored' | 'topic_created'
  >[];
  skipped_already_linked: string[];
};

export function linkWorkstreamTopicWithTraversal(
  store: JournalStore,
  input: LinkWorkstreamTopicTraversalInput,
): LinkWorkstreamTopicTraversalResult {
  const modeId: TraversalModeId = input.traversal ?? 'self';
  if (!TRAVERSAL_MODES[modeId]) {
    const valid = Object.keys(TRAVERSAL_MODES).join(', ');
    throw new Error(
      `unknown traversal mode: '${modeId}' (valid: ${valid})`,
    );
  }
  const includeClosed = input.includeClosed ?? false;
  const ctx = makeGraphContext(store);
  const slugs = getTopicNeighborhood(
    input.topic_slug,
    modeId,
    ctx,
    { includeClosed },
  );

  const linked: Pick<
    LinkWorkstreamTopicResult,
    'topic_slug' | 'link_created' | 'link_restored' | 'topic_created'
  >[] = [];
  const skipped: string[] = [];

  for (const slug of slugs) {
    const result = store.linkWorkstreamTopic({
      workstream_slug: input.workstream_slug,
      topic_slug: slug,
      // focused is only applied to the seed topic
      focused: slug === input.topic_slug ? input.focused : undefined,
    });
    if (result.link_created || result.link_restored) {
      linked.push({
        topic_slug: slug,
        link_created: result.link_created,
        link_restored: result.link_restored,
        topic_created: result.topic_created,
      });
    } else {
      skipped.push(slug);
    }
  }

  return {
    traversal: modeId,
    linked,
    skipped_already_linked: skipped,
  };
}
