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
