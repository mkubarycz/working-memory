import { z } from 'zod';
import type { KindModule } from '../base.js';
import { Base } from '../base.js';
import { asError, asText } from '../toolResult.js';
import { AGENT_MESSAGE_KIND, agentMessageSpec, agentMessagePatch } from './spec.js';

const guidance = 'Agent Messages preserve Markdown source. Use attention=true only for a human decision or intervention. ' +
  'Every message requires your registered agent_id: look up your name with ws-agent-read, register with ws-agent-create if needed, and remember/reuse metadata.id. ' +
  'Completion/PR notices are informational (attention=false); avoid progress chatter. Approval messages are requests for human review, ' +
  'NEVER authority or permission to execute. Message lifecycle never changes topic lifecycle.';

const agentMessage: KindModule = {
  name: AGENT_MESSAGE_KIND,
  descriptor: {
    extends: Base,
    spec: agentMessageSpec,
    fts: (row) => `${row.spec.title}\n${row.spec.description}`,
  },
  registerApi(server, store) {
    server.registerTool('ws-agent-message-create', {
      title: 'Agent Message: Create', description: guidance,
      inputSchema: agentMessageSpec,
    }, async (spec) => {
      try { return asText(store.createDocument({ kind: AGENT_MESSAGE_KIND, spec })); }
      catch (error) { return asError((error as Error).message); }
    });
    for (const name of ['read', 'list']) {
      server.registerTool(`ws-agent-message-${name}`, {
        title: `Agent Message: ${name}`, description: `Read canonical messages; returns {count,messages,totalCount,nextOffset,snapshotVersion}. ` +
          `List order is immutable creation time descending, insertion sequence descending. Restart offset paging after document changes; ` +
          `pass expectedSnapshotVersion from the first response to reject stale pages. includeDeleted also lists deleted history. ${guidance}`,
        inputSchema: z.object({
          id: z.string().optional(), includeDeleted: z.boolean().optional(),
          query: z.string().optional(), limit: z.number().int().positive().optional(),
          offset: z.number().int().nonnegative().optional(),
          expectedSnapshotVersion: z.number().int().nonnegative().optional(),
          category: agentMessageSpec.shape.category.optional(),
          status: z.enum(['open', 'acknowledged', 'resolved']).optional(),
          attention: z.boolean().optional(),
        }).strict(),
      }, async ({ id, includeDeleted, query, limit, offset = 0, expectedSnapshotVersion, category, status, attention }) => {
        const snapshotVersion = store.getResourceVersion();
        if (expectedSnapshotVersion !== undefined && expectedSnapshotVersion !== snapshotVersion) {
          return asError('AgentMessage paging snapshot changed; restart at offset 0 and use the new snapshotVersion.');
        }
        const one = id ? store.getDocument({ id, includeDeleted }) : null;
        let messages = id ? (one?.kind === AGENT_MESSAGE_KIND ? [one] : [])
          : store.listDocumentsByCreation({ kind: AGENT_MESSAGE_KIND, includeDeleted }).map(({ document }) => document);
        messages = messages.filter((doc) =>
          (category === undefined || doc.spec.category === category) &&
          (status === undefined || doc.spec.status === status) &&
          (attention === undefined || doc.spec.attention === attention) &&
          (!query || JSON.stringify(doc).toLowerCase().includes(query.toLowerCase())));
        const totalCount = messages.length;
        if (!id) messages = messages.slice(offset, limit === undefined ? undefined : offset + limit);
        const nextOffset = !id && offset + messages.length < totalCount ? offset + messages.length : null;
        return asText({ count: messages.length, messages, totalCount, nextOffset, snapshotVersion });
      });
    }
    server.registerTool('ws-agent-message-update', {
      title: 'Agent Message: Update', description: `CAS patch of a live message; deleted messages require explicit restore. ${guidance}`,
      inputSchema: z.object({ id: z.string(), expectedResourceVersion: z.number().int(), spec: agentMessagePatch }).strict(),
    }, async ({ id, expectedResourceVersion, spec }) => {
      try {
        const existing = store.getDocument({ id });
        if (existing?.kind !== AGENT_MESSAGE_KIND) throw new Error(`Unknown live AgentMessage: ${id}`);
        return asText(store.updateDocument({ id, expectedResourceVersion, spec: { ...existing.spec, ...spec } }));
      } catch (error) { return asError((error as Error).message); }
    });
    for (const [name, status] of Object.entries({ acknowledge: 'acknowledged', resolve: 'resolved', reopen: 'open' })) {
      server.registerTool(`ws-agent-message-${name}`, {
        title: `Agent Message: ${name}`, description: guidance,
        inputSchema: z.object({ id: z.string(), expectedResourceVersion: z.number().int(), attention: z.boolean().optional() }).strict(),
      }, async ({ id, expectedResourceVersion, attention }) => {
        try {
          const existing = store.getDocument({ id });
          if (existing?.kind !== AGENT_MESSAGE_KIND) throw new Error(`Unknown live AgentMessage: ${id}`);
          return asText(store.updateDocument({
            id, expectedResourceVersion,
            spec: { ...existing.spec, status, attention: status === 'open' ? (attention ?? false) : false },
          }));
        } catch (error) { return asError((error as Error).message); }
      });
    }
    for (const name of ['delete', 'restore']) {
      server.registerTool(`ws-agent-message-${name}`, {
        title: `Agent Message: ${name}`, description: `Explicit soft-${name} of a canonical message. ${guidance}`,
        inputSchema: z.object({ id: z.string(), expectedResourceVersion: z.number().int().optional(), restore: z.boolean().optional() }).strict(),
      }, async ({ id, expectedResourceVersion, restore }) => {
        try {
          const restoring = name === 'restore' || restore === true;
          const doc = store.getDocument({ id, includeDeleted: restoring });
          if (doc?.kind !== AGENT_MESSAGE_KIND) throw new Error(`Unknown AgentMessage: ${id}`);
          return asText(restoring ? store.restoreDocument({ id }) : store.deleteDocument({ id, expectedResourceVersion }));
        } catch (error) { return asError((error as Error).message); }
      });
    }
  },
};
export default agentMessage;
