import { describe, expect, it, vi } from 'vitest';
import { ControlPlaneClient } from '../../shared/controlPlaneClient';

const envelope = {
  kind: 'AgentMessage',
  metadata: { id: 'message-1', slug: null, createdAt: 1, updatedAt: 2, resourceVersion: 3 },
  spec: {
    title: 'Review PR', description: 'Review **authored Markdown**', recommended_action: 'Review',
    category: 'approval', severity: 'warning', status: 'open', attention: true,
    topics: ['topic-one'], relations: [{ kind: 'Topic', id: 'topic-1' }], created_by: 'agent',
    provenance: { pr: 'https://example.test/pr/1' },
  },
};
const result = (value: unknown) => ({ content: [{ type: 'text', text: JSON.stringify(value) }] });
function clientWith(value: unknown) {
  const client = new ControlPlaneClient({ resolveUrl: () => null });
  const call = vi.spyOn(client as unknown as { callDomainTool(name: string, args: unknown): Promise<unknown> }, 'callDomainTool')
    .mockResolvedValue(result(value));
  return { client, call };
}

describe('canonical AgentMessage client', () => {
  it('reads strict envelopes via the canonical tool and preserves source and relations', async () => {
    const { client, call } = clientWith({ count: 1, messages: [envelope] });
    expect(await client.agentMessageRead({ attention: true, status: 'open' })).toMatchObject([{
      id: 'message-1', category: 'approval', description: 'Review **authored Markdown**',
      relations: envelope.spec.relations, provenance: envelope.spec.provenance, resourceVersion: 3,
    }]);
    expect(call).toHaveBeenCalledWith('ws-agent-message-read', { attention: true, status: 'open' });
  });

  it('creates canonical messages without translating categories or granting approval', async () => {
    const { client, call } = clientWith(envelope);
    const input = { title: 'Review PR', description: '**review**', category: 'approval' as const, attention: true };
    expect((await client.agentMessageCreate(input)).category).toBe('approval');
    expect(call).toHaveBeenCalledWith('ws-agent-message-create', input);
  });

  it('sends an explicit CAS patch and never changes a topic or deletes history', async () => {
    const { client, call } = clientWith({ ...envelope, spec: { ...envelope.spec, status: 'resolved', attention: false } });
    await client.agentMessageUpdate({ id: 'message-1', expectedResourceVersion: 3, status: 'resolved' });
    expect(call.mock.calls).toEqual([['ws-agent-message-update', {
      id: 'message-1', expectedResourceVersion: 3, spec: { status: 'resolved' },
    }]]);
  });

  it('obtains the canonical resource version when the caller omits it', async () => {
    const { client, call } = clientWith(envelope);
    call.mockResolvedValueOnce(result({ count: 1, messages: [envelope] }));
    await client.agentMessageUpdate({ id: 'message-1', status: 'acknowledged' });
    expect(call.mock.calls[1]).toEqual(['ws-agent-message-update', {
      id: 'message-1', expectedResourceVersion: 3, spec: { status: 'acknowledged' },
    }]);
  });

  it('does not update an unknown message', async () => {
    const { client, call } = clientWith({ count: 0, messages: [] });
    await expect(client.agentMessageUpdate({ id: 'missing', status: 'open' })).rejects.toThrow('Unknown AgentMessage');
    expect(call).toHaveBeenCalledTimes(1);
  });

  it('deletes and restores through separate canonical tools', async () => {
    const { client, call } = clientWith(envelope);
    await client.agentMessageDelete({ id: 'message-1', expectedResourceVersion: 3 });
    await client.agentMessageRestore({ id: 'message-1' });
    expect(call.mock.calls.map(([name]) => name)).toEqual(['ws-agent-message-delete', 'ws-agent-message-restore']);
  });

  it.each([null, {}, { alerts: [] }, { count: 1, messages: [] }, { count: '0', messages: [] },
    { count: 1, messages: [{}] }])('rejects malformed lists instead of silently returning no messages: %j', async (value) => {
    const { client } = clientWith(value);
    await expect(client.agentMessageRead()).rejects.toThrow(/Malformed control-plane AgentMessage/);
  });

  it.each([
    { ...envelope, kind: 'Alert' },
    { ...envelope, spec: { ...envelope.spec, status: 'closed' } },
    { ...envelope, spec: { ...envelope.spec, attention: 'true' } },
    { ...envelope, spec: { ...envelope.spec, relations: [{ kind: 'Topic' }] } },
    { ...envelope, spec: { ...envelope.spec, severity: undefined } },
    { ...envelope, spec: { ...envelope.spec, provenance: [] } },
    { ...envelope, spec: { ...envelope.spec, title: '  ' } },
    { ...envelope, spec: { ...envelope.spec, provenance: { source: 4 } } },
    { ...envelope, spec: { ...envelope.spec, provenance: { unexpected: 'value' } } },
    { ...envelope, metadata: { ...envelope.metadata, resourceVersion: 0 } },
    { ...envelope, metadata: { ...envelope.metadata, resourceVersion: 1.5 } },
    { ...envelope, metadata: { ...envelope.metadata, resourceVersion: Number.MAX_SAFE_INTEGER + 1 } },
    { ...envelope, metadata: { ...envelope.metadata, createdAt: '1' } },
    { ...envelope, metadata: { ...envelope.metadata, updatedAt: -1 } },
    { ...envelope, metadata: { ...envelope.metadata, deletedAt: 'now' } },
    { ...envelope, metadata: { ...envelope.metadata, deletedAt: -1 } },
  ])('rejects malformed CRUD responses without defaulting required fields', async (value) => {
    const { client } = clientWith(value);
    await expect(client.agentMessageCreate({ title: 'Test', description: 'test', category: 'completion' })).rejects.toThrow(/Malformed/);
    await expect(client.agentMessageUpdate({ id: 'message-1', expectedResourceVersion: 3, status: 'open' })).rejects.toThrow(/Malformed/);
    await expect(client.agentMessageDelete({ id: 'message-1' })).rejects.toThrow(/Malformed/);
  });
});
