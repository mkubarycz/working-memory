import { z } from 'zod';
import { Base, type KindModule } from '../base.js';
import { asError, asText } from '../toolResult.js';
import { AGENT_KIND, agentSpec } from './spec.js';

const guidance = 'Register a named caller for AgentMessages. First use ws-agent-read with your exact name; ' +
  'if absent, use ws-agent-create. Remember the returned metadata.id and reuse it as agent_id on every message. ' +
  'Registration is attribution only, never authentication or execution authority.';

const agent: KindModule = {
  name: AGENT_KIND,
  descriptor: { extends: Base, spec: agentSpec, fts: (row) => `${row.spec.name}\n${row.spec.description}` },
  registerApi(server, store) {
    server.registerTool('ws-agent-create', {
      title: 'Agent: Register', description: guidance, inputSchema: agentSpec,
    }, async (spec) => {
      try { return asText(store.createDocument({ kind: AGENT_KIND, spec })); }
      catch (error) { return asError((error as Error).message); }
    });
    server.registerTool('ws-agent-read', {
      title: 'Agent: Look up', description: guidance,
      inputSchema: z.object({
        id: z.string().optional(), name: z.string().trim().min(1).optional(),
        includeDeleted: z.boolean().optional(),
      }).strict(),
    }, async ({ id, name, includeDeleted }) => {
      const document = id ? store.getDocument({ id, includeDeleted }) : null;
      let agents = id ? (document?.kind === AGENT_KIND ? [document] : [])
        : store.listDocuments({ kind: AGENT_KIND, includeDeleted });
      if (name !== undefined) agents = agents.filter((item) =>
        String(item.spec.name).toLowerCase() === name.toLowerCase());
      return asText({ count: agents.length, agents });
    });
    server.registerTool('ws-agent-update', {
      title: 'Agent: Update', description: `${guidance} Existing messages retain their send-time caller name.`,
      inputSchema: z.object({
        id: z.string(), expectedResourceVersion: z.number().int(),
        spec: z.object({
          name: agentSpec.shape.name.optional(), description: z.string().optional(),
        }).strict(),
      }).strict(),
    }, async ({ id, expectedResourceVersion, spec }) => {
      try {
        const existing = store.getDocument({ id });
        if (existing?.kind !== AGENT_KIND) throw new Error(`Unknown live Agent: ${id}`);
        return asText(store.updateDocument({ id, expectedResourceVersion, spec: { ...existing.spec, ...spec } }));
      } catch (error) { return asError((error as Error).message); }
    });
    server.registerTool('ws-agent-delete', {
      title: 'Agent: Delete or restore', description: `${guidance} Referenced agents cannot be deleted; message history must retain a valid caller.`,
      inputSchema: z.object({
        id: z.string(), expectedResourceVersion: z.number().int().optional(), restore: z.boolean().optional(),
      }).strict(),
    }, async ({ id, expectedResourceVersion, restore }) => {
      try {
        const existing = store.getDocument({ id, includeDeleted: restore });
        if (existing?.kind !== AGENT_KIND) throw new Error(`Unknown Agent: ${id}`);
        return asText(restore ? store.restoreDocument({ id }) : store.deleteDocument({ id, expectedResourceVersion }));
      } catch (error) { return asError((error as Error).message); }
    });
  },
};
export default agent;
