import { test, expect, describe } from 'vitest';
import { openJournalStore } from '../src/db';
import {
  makeGraphContext,
  getTopicNeighborhood,
  TRAVERSAL_MODES,
  type TraversalModeId,
} from '../src/graphTraversals';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function setup() {
  const store = openJournalStore({ dbPath: ':memory:' });
  store.createWorkstream({ slug: 'ws', title: 'Test WS', status: 'open' });
  return store;
}

/** Create a topic and return its slug. */
function makeTopic(
  store: ReturnType<typeof setup>,
  slug: string,
  status: 'open' | 'closed' = 'open',
) {
  store.createTopic({ slug, title: slug, status });
  return slug;
}

/** Link parent → child in the topic DAG. */
function link(
  store: ReturnType<typeof setup>,
  childSlug: string,
  parentSlug: string,
) {
  store.addTopicParent(childSlug, parentSlug);
}

// ---------------------------------------------------------------------------
// TRAVERSAL_MODES registry
// ---------------------------------------------------------------------------

describe('TRAVERSAL_MODES registry', () => {
  test('all four modes are present', () => {
    const ids: TraversalModeId[] = [
      'self',
      'childrenOf',
      'immediateFamilyOf',
      'recursiveFamilyOf',
    ];
    for (const id of ids) {
      expect(TRAVERSAL_MODES[id]).toBeDefined();
      expect(TRAVERSAL_MODES[id].id).toBe(id);
      expect(typeof TRAVERSAL_MODES[id].label).toBe('string');
      expect(typeof TRAVERSAL_MODES[id].description).toBe('string');
      expect(typeof TRAVERSAL_MODES[id].walk).toBe('function');
    }
  });
});

// ---------------------------------------------------------------------------
// 'self' mode
// ---------------------------------------------------------------------------

describe("traversal mode 'self'", () => {
  test('returns only the seed', () => {
    const store = setup();
    makeTopic(store, 'a');
    makeTopic(store, 'b');
    link(store, 'b', 'a');

    const ctx = makeGraphContext(store);
    const result = getTopicNeighborhood('a', 'self', ctx, { includeClosed: false });
    expect([...result]).toEqual(['a']);

    store.close();
  });
});

// ---------------------------------------------------------------------------
// 'childrenOf' mode
// ---------------------------------------------------------------------------

describe("traversal mode 'childrenOf'", () => {
  test('returns seed + direct children', () => {
    const store = setup();
    makeTopic(store, 'parent');
    makeTopic(store, 'child-1');
    makeTopic(store, 'child-2');
    link(store, 'child-1', 'parent');
    link(store, 'child-2', 'parent');

    const ctx = makeGraphContext(store);
    const result = getTopicNeighborhood('parent', 'childrenOf', ctx, {
      includeClosed: false,
    });
    expect(result).toContain('parent');
    expect(result).toContain('child-1');
    expect(result).toContain('child-2');
    expect(result.size).toBe(3);

    store.close();
  });

  test('excludes closed children by default', () => {
    const store = setup();
    makeTopic(store, 'p');
    makeTopic(store, 'c-open');
    makeTopic(store, 'c-closed', 'closed');
    link(store, 'c-open', 'p');
    link(store, 'c-closed', 'p');

    const ctx = makeGraphContext(store);
    const result = getTopicNeighborhood('p', 'childrenOf', ctx, {
      includeClosed: false,
    });
    expect(result).toContain('p');
    expect(result).toContain('c-open');
    expect(result).not.toContain('c-closed');

    store.close();
  });

  test('includes closed children when includeClosed is true', () => {
    const store = setup();
    makeTopic(store, 'p');
    makeTopic(store, 'c-closed', 'closed');
    link(store, 'c-closed', 'p');

    const ctx = makeGraphContext(store);
    const result = getTopicNeighborhood('p', 'childrenOf', ctx, {
      includeClosed: true,
    });
    expect(result).toContain('c-closed');

    store.close();
  });

  test('does not recurse into grandchildren', () => {
    const store = setup();
    makeTopic(store, 'gp');
    makeTopic(store, 'p');
    makeTopic(store, 'c');
    link(store, 'p', 'gp');
    link(store, 'c', 'p');

    const ctx = makeGraphContext(store);
    const result = getTopicNeighborhood('gp', 'childrenOf', ctx, {
      includeClosed: false,
    });
    // Only gp + its direct children (p); grandchild c should not appear.
    expect(result).toContain('gp');
    expect(result).toContain('p');
    expect(result).not.toContain('c');

    store.close();
  });
});

// ---------------------------------------------------------------------------
// 'immediateFamilyOf' mode
// ---------------------------------------------------------------------------

describe("traversal mode 'immediateFamilyOf'", () => {
  test('returns seed, direct parents, direct children, and siblings', () => {
    const store = setup();
    //  grandparent
    //      |
    //   parent
    //   /    \
    // seed  sibling
    //   |
    // child
    makeTopic(store, 'grandparent');
    makeTopic(store, 'parent');
    makeTopic(store, 'seed');
    makeTopic(store, 'sibling');
    makeTopic(store, 'child');
    link(store, 'parent', 'grandparent');
    link(store, 'seed', 'parent');
    link(store, 'sibling', 'parent');
    link(store, 'child', 'seed');

    const ctx = makeGraphContext(store);
    const result = getTopicNeighborhood('seed', 'immediateFamilyOf', ctx, {
      includeClosed: false,
    });

    expect(result).toContain('seed');     // self
    expect(result).toContain('parent');   // direct parent
    expect(result).toContain('sibling');  // sibling (child of parent)
    expect(result).toContain('child');    // direct child
    expect(result).not.toContain('grandparent'); // one hop too far

    store.close();
  });

  test('excludes closed relatives by default', () => {
    const store = setup();
    makeTopic(store, 'p');
    makeTopic(store, 's');
    makeTopic(store, 'c-closed', 'closed');
    link(store, 's', 'p');
    link(store, 'c-closed', 'p');

    const ctx = makeGraphContext(store);
    const result = getTopicNeighborhood('s', 'immediateFamilyOf', ctx, {
      includeClosed: false,
    });
    expect(result).toContain('p');
    expect(result).toContain('s');
    expect(result).not.toContain('c-closed');

    store.close();
  });

  test('includes closed relatives when includeClosed is true', () => {
    const store = setup();
    makeTopic(store, 'p', 'closed');
    makeTopic(store, 's');
    link(store, 's', 'p');

    const ctx = makeGraphContext(store);
    const result = getTopicNeighborhood('s', 'immediateFamilyOf', ctx, {
      includeClosed: true,
    });
    expect(result).toContain('p');

    store.close();
  });
});

// ---------------------------------------------------------------------------
// 'recursiveFamilyOf' mode
// ---------------------------------------------------------------------------

describe("traversal mode 'recursiveFamilyOf'", () => {
  test('walks all ancestors and descendants', () => {
    const store = setup();
    // root → mid → leaf
    makeTopic(store, 'root');
    makeTopic(store, 'mid');
    makeTopic(store, 'leaf');
    link(store, 'mid', 'root');
    link(store, 'leaf', 'mid');

    const ctx = makeGraphContext(store);
    const result = getTopicNeighborhood('mid', 'recursiveFamilyOf', ctx, {
      includeClosed: false,
    });
    expect(result).toContain('root');
    expect(result).toContain('mid');
    expect(result).toContain('leaf');

    store.close();
  });

  test('handles diamond shapes without duplicates', () => {
    const store = setup();
    // a → b, a → c, b → d, c → d  (diamond)
    makeTopic(store, 'a');
    makeTopic(store, 'b');
    makeTopic(store, 'c');
    makeTopic(store, 'd');
    link(store, 'b', 'a');
    link(store, 'c', 'a');
    link(store, 'd', 'b');
    link(store, 'd', 'c');

    const ctx = makeGraphContext(store);
    const result = getTopicNeighborhood('a', 'recursiveFamilyOf', ctx, {
      includeClosed: false,
    });
    expect(result.size).toBe(4);
    expect(result).toContain('a');
    expect(result).toContain('b');
    expect(result).toContain('c');
    expect(result).toContain('d');

    store.close();
  });

  test('excludes closed topics by default', () => {
    const store = setup();
    makeTopic(store, 'r');
    makeTopic(store, 'm-closed', 'closed');
    makeTopic(store, 'leaf-under-closed');
    link(store, 'm-closed', 'r');
    link(store, 'leaf-under-closed', 'm-closed');

    const ctx = makeGraphContext(store);
    const result = getTopicNeighborhood('r', 'recursiveFamilyOf', ctx, {
      includeClosed: false,
    });
    // m-closed is skipped, so leaf-under-closed is never enqueued.
    expect(result).toContain('r');
    expect(result).not.toContain('m-closed');
    expect(result).not.toContain('leaf-under-closed');

    store.close();
  });

  test('seed is always included even if closed', () => {
    const store = setup();
    makeTopic(store, 'closed-seed', 'closed');

    const ctx = makeGraphContext(store);
    const result = getTopicNeighborhood('closed-seed', 'recursiveFamilyOf', ctx, {
      includeClosed: false,
    });
    expect(result).toContain('closed-seed');

    store.close();
  });

  test('includes closed topics when includeClosed is true', () => {
    const store = setup();
    makeTopic(store, 'r');
    makeTopic(store, 'c', 'closed');
    link(store, 'c', 'r');

    const ctx = makeGraphContext(store);
    const result = getTopicNeighborhood('r', 'recursiveFamilyOf', ctx, {
      includeClosed: true,
    });
    expect(result).toContain('c');

    store.close();
  });
});

// ---------------------------------------------------------------------------
// getTopicNeighborhood — validation
// ---------------------------------------------------------------------------

describe('getTopicNeighborhood', () => {
  test('throws for unknown mode', () => {
    const store = setup();
    makeTopic(store, 'x');
    const ctx = makeGraphContext(store);

    expect(() =>
      getTopicNeighborhood('x', 'nonexistent' as TraversalModeId, ctx, {
        includeClosed: false,
      }),
    ).toThrow(/unknown traversal mode/);

    store.close();
  });
});

// ---------------------------------------------------------------------------
// Integration: wm_link_workstream_topic with traversal via JournalStore
// ---------------------------------------------------------------------------

describe('linkWorkstreamTopic with traversal (integration)', () => {
  test('self traversal attaches only the seed', () => {
    const store = setup();
    makeTopic(store, 'seed-t');
    makeTopic(store, 'child-t');
    link(store, 'child-t', 'seed-t');

    const ctx = makeGraphContext(store);
    const slugs = getTopicNeighborhood('seed-t', 'self', ctx, {
      includeClosed: false,
    });

    for (const slug of slugs) {
      store.linkWorkstreamTopic({ workstream_slug: 'ws', topic_slug: slug });
    }

    const ws = store.getWorkstreamBySlug('ws')!;
    const linked = store.listTopicsForWorkstream(ws.id);
    expect(linked.map((t) => t.slug)).toEqual(['seed-t']);

    store.close();
  });

  test('childrenOf traversal attaches seed and its children', () => {
    const store = setup();
    makeTopic(store, 'p');
    makeTopic(store, 'c1');
    makeTopic(store, 'c2');
    link(store, 'c1', 'p');
    link(store, 'c2', 'p');

    const ctx = makeGraphContext(store);
    const slugs = getTopicNeighborhood('p', 'childrenOf', ctx, {
      includeClosed: false,
    });
    for (const slug of slugs) {
      store.linkWorkstreamTopic({ workstream_slug: 'ws', topic_slug: slug });
    }

    const ws = store.getWorkstreamBySlug('ws')!;
    const linked = store.listTopicsForWorkstream(ws.id).map((t) => t.slug);
    expect(linked).toContain('p');
    expect(linked).toContain('c1');
    expect(linked).toContain('c2');
    expect(linked).toHaveLength(3);

    store.close();
  });

  test('re-running the same traversal is idempotent (no-op for already-linked)', () => {
    const store = setup();
    makeTopic(store, 'r');
    makeTopic(store, 'ch');
    link(store, 'ch', 'r');

    const ctx = makeGraphContext(store);
    const slugs = getTopicNeighborhood('r', 'childrenOf', ctx, {
      includeClosed: false,
    });

    // First attach
    for (const slug of slugs) {
      store.linkWorkstreamTopic({ workstream_slug: 'ws', topic_slug: slug });
    }
    // Second attach — should not create new rows
    for (const slug of slugs) {
      const res = store.linkWorkstreamTopic({
        workstream_slug: 'ws',
        topic_slug: slug,
      });
      expect(res.link_created).toBe(false);
      expect(res.link_restored).toBe(false);
    }

    store.close();
  });
});
