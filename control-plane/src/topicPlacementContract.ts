import { z } from 'zod';
import { matchConfidenceSchema } from './embeddingContract.js';

const referenceSchema = z.object({
  id: z.string().min(1), title: z.string(), resourceVersion: z.number().int().nonnegative(),
}).strict();
export const topicPlacementInputSchema = z.object({
  id: z.string().min(1).max(256),
  limit: z.number().int().min(1).max(10).default(6),
}).strict();
export const topicPlacementSuggestionSchema = z.object({
  parent: referenceSchema.nullable(), workstream: referenceSchema,
  similarity: z.number(), confidence: matchConfidenceSchema, excerpt: z.string(),
  evidence: z.enum(['parent-membership', 'workstream-semantic']),
}).strict();
export const topicPlacementSchema = z.object({
  state: z.enum(['disabled', 'pending', 'ready']),
  sourceVersion: z.number().int().nonnegative(),
  limited: z.boolean(), suggestions: z.array(topicPlacementSuggestionSchema),
}).strict();
export const topicPlacementApplySchema = z.object({
  id: z.string().min(1).max(256),
  expectedResourceVersion: z.number().int().nonnegative(),
  parent: z.object({ id: z.string().min(1), resourceVersion: z.number().int().nonnegative() }).strict().nullable(),
  workstream: z.object({ id: z.string().min(1), resourceVersion: z.number().int().nonnegative() }).strict(),
}).strict();
export type TopicPlacement = z.infer<typeof topicPlacementSchema>;
export type TopicPlacementSuggestion = z.infer<typeof topicPlacementSuggestionSchema>;
export type TopicPlacementApply = z.infer<typeof topicPlacementApplySchema>;
