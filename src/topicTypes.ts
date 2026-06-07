// src/topicTypes.ts
// Canonical registry of TopicType ids. The full registry (label, plural, icon,
// description) is added in task-topic-type-config — for now we just need the
// id list so the data layer can validate input and default unknown values.

export const TOPIC_TYPE_IDS = ['topic', 'feature', 'task'] as const;
export type TopicTypeId = (typeof TOPIC_TYPE_IDS)[number];
export const DEFAULT_TOPIC_TYPE: TopicTypeId = 'topic';

export function isTopicTypeId(value: unknown): value is TopicTypeId {
  return typeof value === 'string' && (TOPIC_TYPE_IDS as readonly string[]).includes(value);
}
