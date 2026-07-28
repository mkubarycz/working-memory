/**
 * Shared MCP tool-result helpers for kind domain APIs.
 *
 * `asText` wraps a JSON-serializable result as an MCP text content block;
 * `asError` wraps a message as an error result. These mirror the shapes used in
 * `server.ts` and the Workstream/Topic kinds — extracted here so the TopicType
 * and Alert kinds share ONE copy instead of duplicating them a fourth time.
 *
 * This file is a ROOT of the import graph: it imports NOTHING, so any kind file
 * can depend on it without risking a cycle.
 */

/** Wrap a JSON-serializable result as an MCP text content block. */
export const asText = (result: unknown) => ({
  content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }],
});

/** Wrap a message as an MCP error result. */
export const asError = (message: string) => ({
  isError: true,
  content: [{ type: 'text' as const, text: message }],
});
