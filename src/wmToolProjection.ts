/**
 * Projects the control-plane's CANONICAL tool registry (MCP `tools/list`) into
 * the flat `LlamaToolDef[]` catalog the LOCAL command-widget model consumes
 * (WM 14.2.1 "derive-local-tools-from-canonical-registry").
 *
 * The control-plane kind files (`control-plane/src/kinds/**`) are the SINGLE
 * source of truth: each `server.registerTool('ws-…', { description, inputSchema })`
 * is fetched at runtime and mapped here — a description/field edit in a kind file
 * now reaches the local model with no duplicated table to keep in sync. This is
 * a data-driven PROJECTION, not a redefinition: names are derived by rule, and
 * each tool's canonical `description` + JSON-Schema `inputSchema` pass through
 * (the MCP `inputSchema` IS JSON Schema, so it maps almost directly onto
 * `LlamaToolDef.function.parameters`). The reverse `local → canonical` map lets
 * {@link module:wmToolExecutor} dispatch generically via `callTool`.
 *
 * VS Code-free so the whole projection is unit-testable.
 */

import type { LlamaToolDef } from './llamaClient';
import type { CanonicalToolDef } from './controlPlaneClient';

/**
 * Explicit local-name overrides keyed by canonical tool name. EMPTY by default:
 * the deterministic rule already yields the historical names
 * (`ws-topic-create` → `topic_create`, `wm-document-delete` → `document_delete`).
 * Add an entry only to pin a name the rule can't derive.
 */
export const NAME_OVERRIDES: Readonly<Record<string, string>> = {};

/**
 * Canonical tool names to HIDE from the local model. Empty by default — the
 * requirement is to EXPOSE ALL Working Memory tools (incl. the generic
 * `wm-document-*` surface, esp. delete). Add a name here to narrow the surface
 * (e.g. infra tools) without touching the mapping rule.
 */
export const TOOL_DENYLIST: ReadonlySet<string> = new Set<string>();

/**
 * Canonical tool names to EXPOSE. `null` means "all tools" (the default). Set to
 * a concrete set to restrict the surface to exactly those tools.
 */
export const TOOL_ALLOWLIST: ReadonlySet<string> | null = null;

/**
 * Per-LOCAL-tool field-drop map: property names to strip from a tool's
 * `parameters` (both `properties` and `required`). EMPTY by default — the
 * canonical inputSchema passes through untouched. Populate to trim optional args
 * later if the small local model struggles with a fuller schema.
 */
export const FIELD_DROP: Readonly<Record<string, ReadonlyArray<string>>> = {};

/** The projected catalog plus the reverse map the executor dispatches through. */
export interface ProjectedCatalog {
  /** The local-model tool catalog (drives the constrained envelope grammar). */
  tools: LlamaToolDef[];
  /** local tool name → canonical `ws-*`/`wm-*` name (for generic dispatch). */
  localToCanonical: Map<string, string>;
}

/**
 * Derive a canonical tool name's LOCAL name: honor an explicit override, else
 * strip the `ws-`/`wm-` namespace prefix and replace dashes with underscores
 * (underscores = broadest cross-model tool-name compatibility). Deterministic
 * and reversible via the {@link ProjectedCatalog.localToCanonical} map.
 */
export function canonicalToLocalName(canonical: string): string {
  const override = NAME_OVERRIDES[canonical];
  if (override) {
    return override;
  }
  return canonical.replace(/^(?:ws|wm)-/, '').replace(/-/g, '_');
}

/**
 * Normalize a canonical MCP `inputSchema` into a JSON-Schema object suitable for
 * `LlamaToolDef.function.parameters`: default a missing/blank schema to an empty
 * object schema, drop the `$schema` dialect marker the SDK's zod→JSON-Schema
 * conversion adds (Ollama's grammar compiler wants a plain object schema), and
 * apply the optional per-tool field drop.
 */
function toParameters(
  inputSchema: Record<string, unknown> | undefined,
  drop: ReadonlyArray<string>,
): Record<string, unknown> {
  const base: Record<string, unknown> =
    inputSchema && typeof inputSchema === 'object' ? { ...inputSchema } : {};
  delete base.$schema;
  if (base.type === undefined) {
    base.type = 'object';
  }
  if (base.properties === undefined || typeof base.properties !== 'object') {
    base.properties = {};
  }
  if (drop.length > 0) {
    const props = { ...(base.properties as Record<string, unknown>) };
    for (const field of drop) {
      delete props[field];
    }
    base.properties = props;
    if (Array.isArray(base.required)) {
      base.required = (base.required as string[]).filter((r) => !drop.includes(r));
    }
  }
  return base;
}

/**
 * Turn the canonical `{ name, description, inputSchema }[]` from the
 * control-plane into a {@link ProjectedCatalog}. Applies the allow/deny lists,
 * maps each name to its local form, and carries the canonical description +
 * (normalized) inputSchema verbatim. On a local-name collision the FIRST tool
 * wins and later ones are skipped (deterministic). The allow/deny lists default
 * to the module constants; callers (and tests) may override them.
 */
export function projectCatalog(
  canonical: CanonicalToolDef[],
  options: {
    allowlist?: ReadonlySet<string> | null;
    denylist?: ReadonlySet<string>;
  } = {},
): ProjectedCatalog {
  const allowlist = options.allowlist === undefined ? TOOL_ALLOWLIST : options.allowlist;
  const denylist = options.denylist ?? TOOL_DENYLIST;
  const tools: LlamaToolDef[] = [];
  const localToCanonical = new Map<string, string>();
  for (const tool of canonical) {
    if (!tool.name) {
      continue;
    }
    if (allowlist && !allowlist.has(tool.name)) {
      continue;
    }
    if (denylist.has(tool.name)) {
      continue;
    }
    const local = canonicalToLocalName(tool.name);
    if (localToCanonical.has(local)) {
      continue; // first wins on collision
    }
    localToCanonical.set(local, tool.name);
    tools.push({
      type: 'function',
      function: {
        name: local,
        description: tool.description ?? '',
        parameters: toParameters(tool.inputSchema, FIELD_DROP[local] ?? []),
      },
    });
  }
  return { tools, localToCanonical };
}
