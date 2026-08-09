/**
 * Bridges the model's tool calls to Working Memory operations for the right-rail
 * command widget (WM 14.2.1 "poc-right-rail-command-widget").
 *
 * HARD GUARDRAIL: every Working Memory read/write here goes through the
 * {@link ControlPlaneClient} — the control-plane subprocess is the ONLY thing
 * that touches SQLite. This module never imports `node:sqlite` and never opens
 * `journal.sqlite`. Adding a new tool means calling an existing client method
 * (or a thin client wrapper over an existing `ws-*` RPC), never a DB shortcut.
 *
 * Also builds the markdown brief rendered back in the widget: a short summary
 * plus the exact tool-call trail (with destructive deletes clearly flagged).
 */

import type { ControlPlaneClient } from './controlPlaneClient';
import type { ToolCallRecord, ToolExecutor, ToolResult } from './wmToolLoop';

/**
 * Drop nullish / blank-string args before dispatch so the control-plane sees a
 * clean payload (a blank `slug` shouldn't reach a kind's validation as `''`).
 */
function cleanArgs(args: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(args)) {
    if (v === undefined || v === null) {
      continue;
    }
    if (typeof v === 'string' && v.trim().length === 0) {
      continue;
    }
    out[k] = v;
  }
  return out;
}

/** A canonical tool whose name ends in `-delete` mutates the store (soft-delete). */
function isDestructive(canonicalName: string): boolean {
  return /-delete$/.test(canonicalName);
}

/**
 * Build a {@link ToolExecutor} that dispatches GENERICALLY: the model's local
 * tool name is mapped back to its canonical `ws-*`/`wm-*` name via the
 * projection's reverse map and invoked through the control-plane's generic
 * `callTool` (WM 14.2.1 "derive-local-tools-from-canonical-registry"). No
 * per-tool `switch` — adding a control-plane tool exposes it automatically.
 * HARD GUARDRAIL unchanged: every write flows through the {@link
 * ControlPlaneClient}; this module never touches SQLite.
 */
export function createControlPlaneToolExecutor(
  client: ControlPlaneClient,
  localToCanonical: Map<string, string>,
): ToolExecutor {
  return {
    async execute(name: string, args: Record<string, unknown>): Promise<ToolResult> {
      const canonical = localToCanonical.get(name);
      if (!canonical) {
        return { ok: false, error: `unknown tool "${name}"` };
      }
      try {
        const outcome = await client.callTool(canonical, cleanArgs(args));
        if (!outcome.ok) {
          return { ok: false, error: outcome.error ?? 'tool failed' };
        }
        return {
          ok: true,
          result: outcome.result,
          destructive: isDestructive(canonical) ? true : undefined,
        };
      } catch (err) {
        return { ok: false, error: err instanceof Error ? err.message : String(err) };
      }
    },
  };
}

/**
 * Render the loop outcome as a markdown brief for the widget. The widget renders
 * it with markdown-it (`html:false`), so this is plain markdown — no raw HTML.
 * Destructive deletes are called out explicitly per the POC guardrail.
 */
export function buildBrief(input: {
  finalText: string;
  toolCalls: ToolCallRecord[];
  stopReason: 'final' | 'max-iterations' | 'error';
  error?: string;
}): string {
  const lines: string[] = [];
  const summary = stripToolScaffolding(input.finalText);
  lines.push(summary.length > 0 ? summary : defaultSummary(input.stopReason));

  if (input.stopReason === 'error') {
    lines.push('');
    lines.push(`> ⚠️ The local model call failed: ${input.error ?? 'unknown error'}`);
  } else if (input.stopReason === 'max-iterations') {
    lines.push('');
    lines.push(
      '> ⚠️ Stopped after hitting the tool-call limit — the model kept calling tools without finishing.',
    );
  }

  const deletes = input.toolCalls.filter((c) => c.destructive && c.ok);
  if (deletes.length > 0) {
    lines.push('');
    lines.push('**⚠️ Destructive actions (recoverable soft-deletes):**');
    for (const d of deletes) {
      lines.push(`- \`${d.name}\` ${describeArgs(d.args)}`);
    }
  }

  lines.push('');
  if (input.toolCalls.length === 0) {
    lines.push('_No tool calls were made._');
  } else {
    lines.push(`**Tool calls (${input.toolCalls.length}):**`);
    for (const c of input.toolCalls) {
      if (c.deduped) {
        lines.push(`- ⏭️ \`${c.name}\` ${describeArgs(c.args)} — skipped (duplicate)`);
        continue;
      }
      const status = c.ok ? '✅' : '❌';
      const flag = c.destructive ? ' 🗑️' : '';
      const err = c.ok ? '' : ` — ${c.error ?? 'failed'}`;
      lines.push(`- ${status}${flag} \`${c.name}\` ${describeArgs(c.args)}${err}`);
    }
  }

  return lines.join('\n');
}

/**
 * Strip tool-call scaffolding a small local model may leak into its final text:
 * `<tool_call>…</tool_call>` blocks, stray opening/closing tags, and embedded
 * `{"name":…,"arguments":…}` / `{"tool":…,"args":…}` tool JSON. This is
 * belt-and-suspenders behind constrained decoding — the constrained path emits
 * clean text, but a legacy/native response (or a model that ignores the grammar)
 * can still leak. Returns the trimmed remainder; the caller falls back to a
 * default summary when nothing meaningful is left.
 */
export function stripToolScaffolding(text: string): string {
  if (typeof text !== 'string') {
    return '';
  }
  let out = text;
  // Whole <tool_call>…</tool_call> blocks (with or without a closing tag).
  out = out.replace(/<tool_call>[\s\S]*?(?:<\/tool_call>|$)/gi, ' ');
  // Any remaining stray tags (<tool_call>, </tool_call>, <function=…>, etc.).
  out = out.replace(/<\/?(?:tool_call|tool_response|function)[^>]*>/gi, ' ');
  // Embedded tool JSON objects: {"name":…,"arguments":…} or {"tool":…,"args":…}.
  out = out.replace(
    /\{\s*"(?:name|tool)"\s*:[\s\S]*?"(?:arguments|args)"\s*:\s*\{[\s\S]*?\}\s*\}/gi,
    ' ',
  );
  // Collapse the whitespace the removals leave behind.
  return out.replace(/[ \t]{2,}/g, ' ').replace(/\n{3,}/g, '\n\n').trim();
}

function defaultSummary(stopReason: 'final' | 'max-iterations' | 'error'): string {
  switch (stopReason) {
    case 'final':
      return 'Done.';
    case 'max-iterations':
      return 'The command did not complete within the tool-call limit.';
    case 'error':
      return 'The command could not be completed.';
  }
}

/** Compact one-line arg preview, e.g. `{ slug: foo, title: Bar }`. */
function describeArgs(args: Record<string, unknown>): string {
  const parts: string[] = [];
  for (const [k, v] of Object.entries(args)) {
    if (v === undefined || v === null || v === '') {
      continue;
    }
    const val = typeof v === 'string' ? v : JSON.stringify(v);
    parts.push(`${k}: ${val.length > 40 ? `${val.slice(0, 40)}…` : val}`);
  }
  return parts.length > 0 ? `{ ${parts.join(', ')} }` : '';
}
