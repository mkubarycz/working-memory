/**
 * VS Code-free tool-name matching for the nanite runner. Kept out of
 * `vscodeBridge.ts` (which imports `vscode`) so it can be unit-tested directly.
 */

/**
 * Whether a registered `vscode.lm` tool name satisfies an allow-list entry.
 * VS Code surfaces MCP-server tools under a prefixed name (e.g.
 * `mcp_working-memor_ws-topic-read`), so a clean entry like `ws-topic-read`
 * matches the exact name OR any server-prefixed form ending in `_<entry>`.
 */
export function matchesToolName(registeredName: string, entry: string): boolean {
  return registeredName === entry || registeredName.endsWith(`_${entry}`);
}

/** The allow-list entry `*` grants every available tool (auditable opt-in). */
export const ALLOW_ALL = '*';

/** One granted tool: the clean name shown to the model + the name to invoke. */
export interface GrantedTool {
  /** The name the model is offered (clean allow-list entry, or the registered
   *  name when granted via `*`). Also what the runner enforces against. */
  offer: string;
  /** The actual registered `vscode.lm` tool name to invoke. */
  registered: string;
}

/** The resolved tool policy for one run. */
export interface ToolPlan {
  /** Tools the run may use (allow-list ∩ available − deny-list). */
  granted: GrantedTool[];
  /** Allow-list entries that matched NO available tool (typo / not installed
   *  / MCP server down) — surfaced so a degraded run explains itself. */
  missing: string[];
}

/**
 * Resolve a template's tool policy against the tools actually registered at
 * run time. Pure so it can be unit-tested without `vscode`.
 *
 *   candidate = allow-list has `*` ? ALL available : (available ∩ allow-list)
 *   granted   = candidate − deny-list
 *   missing   = allow-list entries (excluding `*`) with no available match
 *
 * Deny always wins. An empty allow-list grants nothing (safe default): a run
 * must opt in explicitly, either by listing tools or with `*`.
 */
export function resolveToolPlan(
  availableNames: string[],
  allowlist: string[],
  denylist: string[],
): ToolPlan {
  const isDenied = (registered: string): boolean =>
    denylist.some((d) => matchesToolName(registered, d));
  const granted: GrantedTool[] = [];

  if (allowlist.includes(ALLOW_ALL)) {
    for (const registered of availableNames) {
      if (!isDenied(registered)) {
        granted.push({ offer: registered, registered });
      }
    }
  } else {
    for (const entry of allowlist) {
      const registered = availableNames.find((a) => matchesToolName(a, entry));
      if (registered && !isDenied(registered)) {
        granted.push({ offer: entry, registered });
      }
    }
  }

  const missing = allowlist.filter(
    (entry) =>
      entry !== ALLOW_ALL && !availableNames.some((a) => matchesToolName(a, entry)),
  );
  return { granted, missing };
}

