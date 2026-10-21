import type { AgentMessageDecisionInput, AgentMessageStatus, ControlPlaneClient } from '../../../shared/controlPlaneClient';
import { toAgentMessageVM, type AgentMessageVM } from '../../../shared/viewModels/agentMessageVms';

export async function listAgentMessages(
  client: ControlPlaneClient,
): Promise<AgentMessageVM[]> {
  return (await client.agentMessageRead())
    .sort((a, b) => a.created_at - b.created_at || a.id.localeCompare(b.id))
    .map(toAgentMessageVM);
}

export async function updateAgentMessageStatus(
  client: ControlPlaneClient,
  id: unknown,
  status: unknown,
): Promise<void> {
  if (typeof id !== 'string' || !id.trim()
    || typeof status !== 'string' || !['open', 'acknowledged', 'resolved'].includes(status)) {
    throw new Error('Invalid agent message lifecycle request.');
  }

  await client.agentMessageUpdate({
    id,
    status: status as AgentMessageStatus,
    ...(status !== 'open' ? { attention: false } : {}),
  });
}

/** Record communication only; this path has no access to chat confirmation authority. */
export async function recordAgentMessageDecision(
  client: ControlPlaneClient,
  id: unknown,
  decision: unknown,
): Promise<void> {
  if (typeof id !== 'string' || !id.trim() || !decision || typeof decision !== 'object'
    || Array.isArray(decision)) throw new Error('Invalid agent message decision.');
  const input = decision as Record<string, unknown>;
  if (!['approved', 'rejected'].includes(input.outcome as string)
    || typeof input.decided_by !== 'string' || !input.decided_by.trim()
    || (input.reason !== undefined && typeof input.reason !== 'string')
    || Object.keys(input).some((key) => !['outcome', 'decided_by', 'reason'].includes(key))) {
    throw new Error('Invalid agent message decision.');
  }
  await client.agentMessageUpdate({ id, decision: input as unknown as AgentMessageDecisionInput });
}
