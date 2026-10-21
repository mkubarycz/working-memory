import { z } from 'zod';

export const AGENT_KIND = 'Agent';
export const SYSTEM_IMPORT_AGENT_ID = '00000000-0000-4000-8000-000000000001';
export const normalizeAgentName = (name: string): string => name.trim().toLowerCase();
export const agentSpec = z.object({
  name: z.string().trim().min(1).max(120).describe('Unique registered caller name, not proof of identity or authorization. Look up your existing name before registering again.'),
  description: z.string().default('').describe('Optional Markdown describing the agent and its role.'),
}).strict();
