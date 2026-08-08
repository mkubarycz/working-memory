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

/** Coerce a tool arg to a trimmed string, or undefined when absent/blank. */
function s(args: Record<string, unknown>, key: string): string | undefined {
  const v = args[key];
  if (typeof v !== 'string') {
    return undefined;
  }
  const t = v.trim();
  return t.length > 0 ? t : undefined;
}

/** Coerce a tool arg to a string array (dropping non-strings), or undefined. */
function sa(args: Record<string, unknown>, key: string): string[] | undefined {
  const v = args[key];
  if (!Array.isArray(v)) {
    return undefined;
  }
  const out = v.filter((x): x is string => typeof x === 'string' && x.trim().length > 0);
  return out.length > 0 ? out : undefined;
}

function required(value: string | undefined, name: string): string {
  if (value === undefined) {
    throw new Error(`missing required argument "${name}"`);
  }
  return value;
}

/**
 * Build a {@link ToolExecutor} whose named tools map onto the control-plane
 * client's `ws-*` domain methods. Tool names mirror `wmToolLoop.WM_TOOLS`.
 */
export function createControlPlaneToolExecutor(
  client: ControlPlaneClient,
): ToolExecutor {
  return {
    async execute(name: string, args: Record<string, unknown>): Promise<ToolResult> {
      try {
        switch (name) {
          case 'topic_read': {
            const topics = await client.topicRead({
              slug: s(args, 'slug'),
              query: s(args, 'query'),
              workstream: s(args, 'workstream'),
            });
            return { ok: true, result: topics };
          }
          case 'topic_create': {
            const topic = await client.topicCreate({
              title: required(s(args, 'title'), 'title'),
              body: s(args, 'body'),
              topicType: s(args, 'topicType'),
              workstreams: sa(args, 'workstreams'),
            });
            return { ok: true, result: topic };
          }
          case 'topic_update': {
            const topic = await client.topicUpdate({
              slug: required(s(args, 'slug'), 'slug'),
              title: s(args, 'title'),
              body: s(args, 'body'),
              status: s(args, 'status'),
            });
            return { ok: true, result: topic };
          }
          case 'topic_delete': {
            const res = await client.topicDelete({ slug: required(s(args, 'slug'), 'slug') });
            return { ok: res.ok, result: res, destructive: true };
          }
          case 'workstream_read': {
            const rows = await client.wsRead({ slug: s(args, 'slug'), query: s(args, 'query') });
            return { ok: true, result: rows };
          }
          case 'workstream_create': {
            const ws = await client.wsCreate({
              title: required(s(args, 'title'), 'title'),
              status: s(args, 'status'),
            });
            return { ok: true, result: ws };
          }
          case 'workstream_update': {
            const ws = await client.wsUpdate({
              slug: required(s(args, 'slug'), 'slug'),
              title: s(args, 'title'),
              status: s(args, 'status'),
            });
            return { ok: true, result: ws };
          }
          case 'workstream_delete': {
            const res = await client.wsDelete({ slug: required(s(args, 'slug'), 'slug') });
            return { ok: res.ok, result: res, destructive: true };
          }
          case 'alert_read': {
            const alerts = await client.alertRead({ query: s(args, 'query') });
            return { ok: true, result: alerts };
          }
          case 'alert_create': {
            const alert = await client.alertCreate({
              description: required(s(args, 'description'), 'description'),
              title: s(args, 'title'),
              recommended_action: s(args, 'recommended_action'),
              topics: sa(args, 'topics'),
            });
            return { ok: true, result: alert };
          }
          case 'alert_update': {
            const status = s(args, 'status');
            const alert = await client.alertUpdate({
              id: required(s(args, 'id'), 'id'),
              status:
                status === 'alert' || status === 'informational' || status === 'closed'
                  ? status
                  : undefined,
            });
            return { ok: true, result: alert };
          }
          default:
            return { ok: false, error: `unknown tool "${name}"` };
        }
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
  const summary = input.finalText.trim();
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
