import { z } from 'zod';

export const AGENT_MESSAGE_KIND = 'AgentMessage';
export const agentMessageProvenance = z.object({
  agent: z.string().optional(),
  journal_id: z.string().optional(),
  run_id: z.string().optional(),
  session_id: z.string().optional(),
  url: z.string().optional(),
  pr: z.string().optional(),
  source: z.string().optional(),
}).strict();
export const agentMessageDecision = z.object({
  outcome: z.enum(['approved', 'rejected']),
  decided_by: z.string().refine((value) => value.trim().length > 0, 'Decision attribution is required.'),
  reason: z.string().optional(),
  decided_at: z.number().int().nonnegative().optional().describe('Server-recorded Unix seconds. Omit when recording a decision; never authorization or proof of identity.'),
}).strict();
export const agentMessageSpec = z.object({
  title: z.string().refine((value) => value.trim().length > 0, 'A meaningful nonblank title is required.').describe('Required meaningful Markdown title; preserved as authored source.'),
  description: z.string().refine((value) => value.trim().length > 0, 'A meaningful nonblank body is required.').describe('Required Markdown body; never rewritten by rendering or migration.'),
  category: z.enum(['request', 'approval', 'error', 'completion']).describe('Purpose: request for a human decision; approval request for human review (NEVER execution authority); error explaining a failure; completion/PR information without attention.'),
  severity: z.enum(['info', 'warning', 'error']).default('info'),
  status: z.enum(['open', 'acknowledged', 'resolved']).default('open'),
  attention: z.boolean().default(false).describe('Opt in only for an open message needing a human decision/intervention. Completion and PR notices normally remain false.'),
  recommended_action: z.string().default('').describe('Suggested human next step; informational, never an executable authorization.'),
  topics: z.array(z.string().min(1)).default([]).describe('Distinct Topic slugs, not document IDs. New/changed links must be live; unchanged migrated historical links are retained even if their Topic is gone. Does not change topic lifecycle.'),
  relations: z.array(z.object({ kind: z.string().min(1), id: z.string().min(1) }).strict()).default([]).describe('Distinct live document references by exact kind and document ID; not slugs.'),
  dedupe_key: z.string().min(1).optional().describe('Stable retry identity among live unresolved messages. Same authored content reuses the active record; changed content conflicts. Resolved/deleted history never revives: a recurrence creates a new ID.'),
  created_by: z.string().default('system'),
  provenance: agentMessageProvenance.optional().describe('Optional origin identifiers/links: agent, journal_id, run_id, session_id, url, pr, source. Timestamps are server-owned metadata.createdAt/updatedAt in Unix seconds.'),
  decision: agentMessageDecision.optional().describe('Approval-category communication only: records an attributed approved/rejected decision. NEVER an authorization grant, executable action, or tool-confirmation response. Recording it does not change message/topic lifecycle or run any action.'),
  legacy_source: z.record(z.string(), z.unknown()).optional(),
}).strict();

// Zod optional(default(...)) still materializes defaults on omitted patch keys.
// Remove creation defaults before making fields optional, so edits stay partial.
export const agentMessagePatch = z.object({
  ...agentMessageSpec.shape,
  severity: agentMessageSpec.shape.severity.removeDefault(),
  status: agentMessageSpec.shape.status.removeDefault(),
  attention: agentMessageSpec.shape.attention.removeDefault(),
  recommended_action: agentMessageSpec.shape.recommended_action.removeDefault(),
  topics: agentMessageSpec.shape.topics.removeDefault(),
  relations: agentMessageSpec.shape.relations.removeDefault(),
  created_by: agentMessageSpec.shape.created_by.removeDefault(),
}).partial().strict();

export type AgentMessageSpec = z.infer<typeof agentMessageSpec>;

export function legacyToMessage(input: Record<string, unknown>): AgentMessageSpec {
  const { status = 'alert', ...rest } = input;
  const mapping = {
    alert: { category: 'request', status: 'open', attention: true },
    informational: { category: 'completion', status: 'open', attention: false },
    closed: { category: 'request', status: 'resolved', attention: false },
  } as const;
  if (typeof status !== 'string' || !(status in mapping)) {
    throw new Error(`Unsupported legacy Alert status: ${String(status)}`);
  }
  if (rest.title !== undefined && typeof rest.title !== 'string') {
    throw new Error('Legacy Alert title must be a string when present.');
  }
  const mapped = mapping[status as keyof typeof mapping];
  const title = typeof rest.title === 'string' && rest.title.trim()
    ? rest.title
    : typeof rest.description === 'string'
      ? rest.description.split(/\r?\n/).find((line) => line.trim())?.trim() ?? 'Legacy agent message'
      : 'Legacy agent message';
  const action = rest.recommended_action ?? '';
  const recommended_action = mapped.attention && typeof action === 'string' && !action.trim()
    ? `Review the message "${title}" and decide the next step.`
    : action;
  return agentMessageSpec.parse({ ...rest, title, recommended_action, ...mapped });
}

export function messageToLegacyStatus(spec: Record<string, unknown>): 'alert' | 'informational' | 'closed' {
  if (spec.category === 'request' && spec.status === 'open' && spec.attention === true) return 'alert';
  if (spec.category === 'completion' && spec.status === 'open' && spec.attention === false) return 'informational';
  if ((spec.category === 'request' || spec.category === 'completion') && spec.status === 'resolved' && spec.attention === false) return 'closed';
  throw new Error('AgentMessage cannot be represented losslessly as a legacy Alert; use ws-agent-message-*.');
}
