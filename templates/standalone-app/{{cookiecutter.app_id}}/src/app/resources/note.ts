import { z } from 'zod';
import type { ResourceDefinition } from '../../framework/types.js';

const NoteSpec = z.object({
  title: z.string().trim().min(1).max(200),
  body: z.string().max(20_000).default(''),
  tags: z.array(z.string().trim().min(1).max(50)).default([]),
}).strict();

const NoteStatus = z.object({
  state: z.enum(['active', 'archived']).default('active'),
}).strict();

const NoteRelationships = z.object({
  relatedNotes: z.array(z.string().uuid()).default([]),
}).strict();

export const noteResource: ResourceDefinition = {
  kind: 'Note',
  description: 'Starter app-owned resource; replace or extend it with your domain.',
  spec: NoteSpec,
  status: NoteStatus,
  relationships: NoteRelationships,
  relationshipDescriptors: [{
    field: 'relatedNotes',
    targetKind: 'Note',
    cardinality: 'many',
  }],
  businessRules: [
    'A note cannot relate to itself.',
    'Every relatedNotes identifier must refer to an existing Note.',
  ],
  validate(candidate, context) {
    const relatedNotes = candidate.relationships.relatedNotes as string[];
    if (relatedNotes.includes(candidate.metadata.id)) {
      throw new Error('A note cannot relate to itself.');
    }
    for (const id of relatedNotes) {
      if (!context.get('Note', id)) throw new Error(`Related Note "${id}" was not found.`);
    }
  },
};
