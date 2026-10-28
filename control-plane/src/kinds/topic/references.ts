import type { Store } from '../../store.js';
import { stringArray, TOPIC_KIND } from './topic.js';

export function topicSpecWithDefaults(store: Store, spec: Record<string, unknown>): Record<string, unknown> {
  if (spec.topicType !== undefined) return spec;
  const defaults = store.listDocuments({ kind: 'TopicType' }).filter((document) => document.spec.label === 'Topic');
  if (defaults.length !== 1) {
    throw new Error('Omit topicType only when exactly one live TopicType has spec.label "Topic". Provide its document ID explicitly otherwise.');
  }
  return { ...spec, topicType: defaults[0].metadata.id };
}

/** Validate resource references without interpreting names as resource identity. */
export function validateTopicReferences(store: Store, spec: Record<string, unknown>): void {
  const type = spec.topicType;
  if (typeof type !== 'string' || !store.getDocument({ id: type, kind: 'TopicType' })) {
    throw new Error(`Unknown TopicType ID: "${String(type)}". Provide a live TopicType document ID.`);
  }
  for (const [field, kind] of [['parents', TOPIC_KIND], ['workstreams', 'Workstream']] as const) {
    const ids = stringArray(spec[field]);
    if (new Set(ids).size !== ids.length) throw new Error(`Duplicate ${field} reference.`);
    for (const id of ids) {
      if (!store.getDocument({ id, kind })) throw new Error(`Unknown ${kind} ID in ${field}: "${id}".`);
    }
  }
  const focused = stringArray(spec.focusedWorkstreams);
  if (new Set(focused).size !== focused.length) throw new Error('Duplicate focusedWorkstreams reference.');
  const workstreams = stringArray(spec.workstreams);
  if (focused.some((id) => !workstreams.includes(id))) {
    throw new Error('focusedWorkstreams must be a subset of workstreams.');
  }
}
