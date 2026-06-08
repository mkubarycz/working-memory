import { test, expect } from 'vitest';
import { openJournalStore } from '../src/db';
import { getAllPanelData, type PanelTopic } from '../src/panelData';

test('Active tab nests child topics under their parent within a workstream', () => {
  const store = openJournalStore({ dbPath: ':memory:' });

  // arrange: one workstream, three topics, all linked; B is a child of A.
  store.createWorkstream({ slug: 'demo-ws', title: 'Demo WS', status: 'open' });
  store.createTopic({ slug: 'topic-a', title: 'Topic A', topic_type: 'feature' });
  store.createTopic({ slug: 'topic-b', title: 'Topic B', topic_type: 'feature' });
  store.createTopic({ slug: 'topic-c', title: 'Topic C', topic_type: 'feature' });

  store.linkWorkstreamTopic({ workstream_slug: 'demo-ws', topic_slug: 'topic-a' });
  store.linkWorkstreamTopic({ workstream_slug: 'demo-ws', topic_slug: 'topic-b' });
  store.linkWorkstreamTopic({ workstream_slug: 'demo-ws', topic_slug: 'topic-c' });

  store.addTopicParent('topic-b', 'topic-a');

  // act
  const { active } = getAllPanelData(store);

  // assert
  expect(active.items).toHaveLength(1);
  const ws = active.items[0];
  if (ws.kind !== 'workstream') {
    throw new Error('expected workstream item');
  }

  const topicsGroup = ws.children.find((c) => c.kind === 'topics-group');
  expect(topicsGroup).toBeDefined();
  if (!topicsGroup || topicsGroup.kind !== 'topics-group') {
    throw new Error('expected topics-group');
  }

  // Top level should have exactly A and C (B is nested under A).
  expect(topicsGroup.children).toHaveLength(2);
  const topSlugs = topicsGroup.children.map((c) => c.label).sort();
  expect(topSlugs).toEqual(['Topic A', 'Topic C']);

  const topicA = topicsGroup.children.find((c) => c.label === 'Topic A');
  expect(topicA).toBeDefined();

  // A should have exactly one nested child (B).
  const aChildren = (topicA as PanelTopic & { children?: PanelTopic[] })
    .children;
  expect(aChildren).toBeDefined();
  expect(aChildren).toHaveLength(1);
  expect(aChildren![0].label).toBe('Topic B');

  store.close();
});

test('Active tab nests grandchildren (A → C → D) within a workstream', () => {
  const store = openJournalStore({ dbPath: ':memory:' });

  // arrange: one workstream, four topics, all linked.
  // B is a child of A. D is a child of C. C is a child of A.
  // Resulting tree:
  //   A
  //   ├─ B
  //   └─ C
  //      └─ D
  store.createWorkstream({ slug: 'demo-ws', title: 'Demo WS', status: 'open' });
  store.createTopic({ slug: 'topic-a', title: 'Topic A', topic_type: 'feature' });
  store.createTopic({ slug: 'topic-b', title: 'Topic B', topic_type: 'feature' });
  store.createTopic({ slug: 'topic-c', title: 'Topic C', topic_type: 'feature' });
  store.createTopic({ slug: 'topic-d', title: 'Topic D', topic_type: 'feature' });

  store.linkWorkstreamTopic({ workstream_slug: 'demo-ws', topic_slug: 'topic-a' });
  store.linkWorkstreamTopic({ workstream_slug: 'demo-ws', topic_slug: 'topic-b' });
  store.linkWorkstreamTopic({ workstream_slug: 'demo-ws', topic_slug: 'topic-c' });
  store.linkWorkstreamTopic({ workstream_slug: 'demo-ws', topic_slug: 'topic-d' });

  store.addTopicParent('topic-b', 'topic-a');
  store.addTopicParent('topic-c', 'topic-a');
  store.addTopicParent('topic-d', 'topic-c');

  // act
  const { active } = getAllPanelData(store);

  // assert: walk top-level → A
  const ws = active.items[0];
  if (ws.kind !== 'workstream') {
    throw new Error('expected workstream item');
  }
  const topicsGroup = ws.children.find((c) => c.kind === 'topics-group');
  if (!topicsGroup || topicsGroup.kind !== 'topics-group') {
    throw new Error('expected topics-group');
  }

  // Only A at the top level (B, C, D all have in-set parents).
  expect(topicsGroup.children).toHaveLength(1);
  const topicA = topicsGroup.children[0];
  expect(topicA.label).toBe('Topic A');

  // A → exactly B and C, nothing else.
  const aChildren = (topicA as PanelTopic & { children?: PanelTopic[] })
    .children;
  expect(aChildren).toBeDefined();
  expect(aChildren).toHaveLength(2);
  const aChildLabels = aChildren!.map((c) => c.label).sort();
  expect(aChildLabels).toEqual(['Topic B', 'Topic C']);

  // B → no children.
  const topicB = aChildren!.find((c) => c.label === 'Topic B')!;
  const bChildren = (topicB as PanelTopic & { children?: PanelTopic[] })
    .children;
  expect(bChildren === undefined || bChildren.length === 0).toBe(true);

  // C → exactly D.
  const topicC = aChildren!.find((c) => c.label === 'Topic C')!;
  const cChildren = (topicC as PanelTopic & { children?: PanelTopic[] })
    .children;
  expect(cChildren).toBeDefined();
  expect(cChildren).toHaveLength(1);
  expect(cChildren![0].label).toBe('Topic D');

  // D → no children (leaf of the A → C → D path).
  const topicD = cChildren![0];
  const dChildren = (topicD as PanelTopic & { children?: PanelTopic[] })
    .children;
  expect(dChildren === undefined || dChildren.length === 0).toBe(true);

  store.close();
});
