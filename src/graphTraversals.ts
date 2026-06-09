import type { JournalStore, TopicStatus } from './db';

// ---------------------------------------------------------------------------
// Graph context — primitives the walk algorithms need; keeps SQL out of modes
// ---------------------------------------------------------------------------

export interface GraphContext {
  getParents(slug: string): string[];
  getChildren(slug: string): string[];
  getTopicStatus(slug: string): TopicStatus | null;
}

export function makeGraphContext(store: JournalStore): GraphContext {
  return {
    getParents(slug) {
      return store.listTopicParents(slug).map((t) => t.slug);
    },
    getChildren(slug) {
      return store.listTopicChildren(slug).map((t) => t.slug);
    },
    getTopicStatus(slug) {
      const topic = store.getTopic(slug);
      return topic ? topic.status : null;
    },
  };
}

// ---------------------------------------------------------------------------
// Traversal mode registry
// ---------------------------------------------------------------------------

export type TraversalModeId =
  | 'self'
  | 'immediateFamilyOf'
  | 'childrenOf'
  | 'recursiveFamilyOf';

export type TraversalMode = {
  id: TraversalModeId;
  label: string;
  description: string;
  walk: (
    seed: string,
    ctx: GraphContext,
    opts: { includeClosed: boolean },
  ) => Set<string>;
};

export const TRAVERSAL_MODES: Record<TraversalModeId, TraversalMode> = {
  self: {
    id: 'self',
    label: 'Just this topic',
    description: 'Attach only the seed topic. Preserves existing single-topic behaviour.',
    walk(seed) {
      return new Set([seed]);
    },
  },

  childrenOf: {
    id: 'childrenOf',
    label: 'Children only',
    description:
      'Attach the seed topic and its direct children (one level down, no further).',
    walk(seed, ctx, opts) {
      const visited = new Set([seed]);
      for (const child of ctx.getChildren(seed)) {
        if (visited.has(child)) {
          continue;
        }
        if (!opts.includeClosed && ctx.getTopicStatus(child) === 'closed') {
          continue;
        }
        visited.add(child);
      }
      return visited;
    },
  },

  immediateFamilyOf: {
    id: 'immediateFamilyOf',
    label: 'Immediate family',
    description:
      'Attach the seed topic, its direct parents, its direct children, and siblings (other children of each direct parent).',
    walk(seed, ctx, opts) {
      const visited = new Set([seed]);

      const addIfEligible = (slug: string): void => {
        if (visited.has(slug)) {
          return;
        }
        if (!opts.includeClosed && ctx.getTopicStatus(slug) === 'closed') {
          return;
        }
        visited.add(slug);
      };

      // Direct parents and siblings (children of those parents)
      for (const parent of ctx.getParents(seed)) {
        addIfEligible(parent);
        for (const sibling of ctx.getChildren(parent)) {
          addIfEligible(sibling);
        }
      }

      // Direct children
      for (const child of ctx.getChildren(seed)) {
        addIfEligible(child);
      }

      return visited;
    },
  },

  recursiveFamilyOf: {
    id: 'recursiveFamilyOf',
    label: 'Entire family tree',
    description:
      'Attach the seed topic and the full connected subgraph: all ancestors, all descendants, and all their siblings, transitively. Uses a visited set for cycle safety.',
    walk(seed, ctx, opts) {
      const visited = new Set<string>();
      const queue: string[] = [seed];
      let head = 0;

      while (head < queue.length) {
        const slug = queue[head++];
        if (visited.has(slug)) {
          continue;
        }
        // The seed is always included; all other nodes are filtered by status.
        if (slug !== seed) {
          if (!opts.includeClosed && ctx.getTopicStatus(slug) === 'closed') {
            continue;
          }
        }
        visited.add(slug);

        for (const p of ctx.getParents(slug)) {
          if (!visited.has(p)) {
            queue.push(p);
          }
        }
        for (const c of ctx.getChildren(slug)) {
          if (!visited.has(c)) {
            queue.push(c);
          }
        }
      }

      return visited;
    },
  },
};

// ---------------------------------------------------------------------------
// Public dispatcher
// ---------------------------------------------------------------------------

/**
 * Walk the topic graph from `seed` using the given traversal mode and return
 * the set of topic slugs that should be attached to the workstream.
 *
 * - Cycle protection is built in: every walk maintains a visited `Set<string>`
 *   and skips any slug already seen, so diamond-shaped DAGs and (hypothetical)
 *   cycles both terminate safely.
 * - Closed topics are excluded by default; pass `includeClosed: true` to
 *   include them.
 */
export function getTopicNeighborhood(
  seed: string,
  modeId: TraversalModeId,
  ctx: GraphContext,
  opts: { includeClosed: boolean },
): Set<string> {
  const mode = TRAVERSAL_MODES[modeId];
  if (!mode) {
    const valid = Object.keys(TRAVERSAL_MODES).join(', ');
    throw new Error(
      `unknown traversal mode: '${modeId}' (valid: ${valid})`,
    );
  }
  return mode.walk(seed, ctx, opts);
}
