/**
 * Shared building blocks for the Workstream kind's domain API
 * (`ws-workstream-*`).
 *
 * This file holds the bits the four tool files (`create` / `read` / `update` /
 * `delete`) and the kind descriptor (`index.ts`) all share: the kind name and
 * the MCP result helpers. The document↔domain projection (`class Workstream`,
 * `IWorkstream`, `WorkstreamLifecycleStatus`) lives in the sibling
 * `workstream.ts` root.
 *
 * Import direction is deliberately ONE-WAY to avoid a cycle: this file imports
 * NOTHING from the kind or tool files. The four tool files and the kind file
 * import FROM here.
 */

/** The Workstream kind name in the control-plane registry. */
export const WORKSTREAM_KIND = 'Workstream';

/** MCP tool result helpers (mirrors the shapes used in server.ts). */
export const asText = (result: unknown) => ({
  content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }],
});
export const asError = (message: string) => ({
  isError: true,
  content: [{ type: 'text' as const, text: message }],
});
