import { beforeEach, describe, expect, it, vi } from 'vitest';

const callTool = vi.fn();
vi.mock('@modelcontextprotocol/sdk/client/index.js', () => ({
  Client: class {
    connect = vi.fn().mockResolvedValue(undefined);
    close = vi.fn().mockResolvedValue(undefined);
    callTool = callTool;
  },
}));
vi.mock('@modelcontextprotocol/sdk/client/streamableHttp.js', () => ({
  StreamableHTTPClientTransport: class {
    close = vi.fn().mockResolvedValue(undefined);
  },
}));
import { ControlPlaneClient, ControlPlaneClientError } from '../shared/controlPlaneClient';

const envelope = {
  kind: 'AgentMessage',
  metadata: { id: 'message-1', slug: null, createdAt: 100, updatedAt: 200, resourceVersion: 3 },
  spec: {
    agent_id: '00000000-0000-4000-8000-000000000001', agent_name: 'Test Agent',
    title: 'Review PR', description: '**Human review**', recommended_action: 'Review PR',
    category: 'approval', severity: 'warning', status: 'open', attention: true,
    created_by: 'agent', topics: ['topic-one'], relations: [{ kind: 'Topic', id: 'topic-one-id' }],
    provenance: { pr: 'https://example.test/pr/1' },
  },
};
const text = (value: unknown) => ({ content: [{ type: 'text', text: JSON.stringify(value) }] });
const client = () => new ControlPlaneClient({ resolveUrl: () => 'http://127.0.0.1:9/mcp' });

describe('canonical AgentMessage shared client', () => {
  beforeEach(() => callTool.mockReset());

  it('parses an approval decision as communication with a server epoch-seconds timestamp', async () => {
    const decision = { outcome: 'approved', decided_by: 'Reviewer', reason: '**Reviewed**', decided_at: 300 };
    callTool.mockResolvedValue(text({ count: 1, messages: [{ ...envelope, spec: { ...envelope.spec, decision } }] }));
    expect((await client().agentMessageRead())[0].decision).toEqual(decision);
  });

  it.each([
    { outcome: 'pending', decided_by: 'Reviewer', decided_at: 300 },
    { outcome: 'approved', decided_by: ' ', decided_at: 300 },
    { outcome: 'approved', decided_by: 'Reviewer' },
    { outcome: 'approved', decided_by: 'Reviewer', decided_at: '300' },
    { outcome: 'approved', decided_by: 'Reviewer', decided_at: 300, action: 'execute' },
  ])('rejects malformed or executable approval decision responses', async (decision) => {
    callTool.mockResolvedValue(text({ count: 1, messages: [{ ...envelope, spec: { ...envelope.spec, decision } }] }));
    await expect(client().agentMessageRead()).rejects.toThrow('Malformed');
  });

  it('preserves canonical deletion metadata independently of an open message status', async () => {
    callTool.mockResolvedValue(text({ ...envelope, metadata: { ...envelope.metadata, deletedAt: 300 } }));
    expect(await client().agentMessageDelete({ id: 'message-1' }))
      .toMatchObject({ status: 'open', deleted_at: 300 });
  });

  it.each([
    { ...envelope.metadata, deletedAt: '300' },
    { ...envelope.metadata, deletedAt: -1 },
    { ...envelope.metadata, createdAt: 1.5 },
    { ...envelope.metadata, updatedAt: null },
    { ...envelope.metadata, resourceVersion: Number.MAX_SAFE_INTEGER + 1 },
  ])('rejects invalid timestamp/version metadata without fabricating values', async (metadata) => {
    callTool.mockResolvedValue(text({ ...envelope, metadata }));
    await expect(client().agentMessageDelete({ id: 'message-1' })).rejects.toThrow('Malformed');
  });

  it('exposes exact snapshot paging metadata and forwards offsets and deleted-history filters', async () => {
    callTool.mockResolvedValue(text({
      count: 1, messages: [envelope], totalCount: 3, nextOffset: 2, snapshotVersion: 9,
    }));
    const input = { offset: 1, limit: 1, expectedSnapshotVersion: 9, includeDeleted: true };
    expect(await client().agentMessageReadPage(input)).toMatchObject({
      count: 1, totalCount: 3, nextOffset: 2, snapshotVersion: 9,
      messages: [{ id: 'message-1' }],
    });
    expect(callTool).toHaveBeenCalledWith({ name: 'ws-agent-message-read', arguments: input });
  });

  it.each([
    { count: 0, messages: [] },
    { count: 0, messages: [], totalCount: 0, nextOffset: 0, snapshotVersion: 1 },
    { count: 0, messages: [], totalCount: 0, nextOffset: null, snapshotVersion: -1 },
  ])('rejects malformed snapshot pages without inventing defaults', async (page) => {
    callTool.mockResolvedValue(text(page));
    await expect(client().agentMessageReadPage()).rejects.toThrow('Malformed');
  });

  it('forwards all canonical list filters and validates mapped envelopes', async () => {
    callTool.mockResolvedValue(text({ count: 1, messages: [envelope] }));
    const input = { id: 'message-1', query: 'review', category: 'approval' as const, status: 'open' as const,
      attention: true, limit: 20, includeDeleted: false };
    const messages = await client().agentMessageRead(input);
    expect(callTool).toHaveBeenCalledWith({ name: 'ws-agent-message-read', arguments: input });
    expect(messages).toMatchObject([{
      id: 'message-1', slug: null, description: '**Human review**', category: 'approval',
      created_at: 100, updated_at: 200, resourceVersion: 3, relations: envelope.spec.relations,
      provenance: envelope.spec.provenance,
    }]);
  });

  it('creates through the primary canonical tool, preserving Markdown and explicit attention', async () => {
    callTool.mockResolvedValue(text(envelope));
    const input = { agent_id: envelope.spec.agent_id, title: 'Review PR', category: 'approval' as const, description: '**Human review**', attention: true };
    await client().agentMessageCreate(input);
    expect(callTool).toHaveBeenCalledWith({ name: 'ws-agent-message-create', arguments: input });
  });

  it('reads a CAS version before a lifecycle patch without deleting message or topic history', async () => {
    callTool.mockResolvedValueOnce(text({ count: 1, messages: [envelope] }))
      .mockResolvedValueOnce(text({ ...envelope, spec: { ...envelope.spec, status: 'resolved', attention: false } }));
    const updated = await client().agentMessageUpdate({ id: 'message-1', status: 'resolved' });
    expect(updated.status).toBe('resolved');
    expect(callTool.mock.calls.map(([input]) => input)).toEqual([
      { name: 'ws-agent-message-read', arguments: { id: 'message-1' } },
      { name: 'ws-agent-message-update', arguments: { id: 'message-1', expectedResourceVersion: 3, spec: { status: 'resolved' } } },
    ]);
  });

  it('forwards explicit CAS and separate delete/restore tools', async () => {
    callTool.mockResolvedValue(text(envelope));
    const typed = client();
    await typed.agentMessageUpdate({ id: 'message-1', expectedResourceVersion: 3, status: 'open' });
    await typed.agentMessageDelete({ id: 'message-1', expectedResourceVersion: 3 });
    await typed.agentMessageRestore({ id: 'message-1' });
    expect(callTool.mock.calls.map(([input]) => input.name)).toEqual([
      'ws-agent-message-update', 'ws-agent-message-delete', 'ws-agent-message-restore',
    ]);
  });

  it.each([null, {}, { alerts: [] }, { count: 1, messages: [] }, { count: 1, messages: [envelope.spec] }])(
    'throws on malformed list responses rather than hiding history: %j', async (value) => {
      callTool.mockResolvedValue(text(value));
      await expect(client().agentMessageRead()).rejects.toBeInstanceOf(ControlPlaneClientError);
    });

  it.each(['category', 'status', 'severity', 'attention', 'topics', 'relations', 'created_by', 'agent_id', 'agent_name'])(
    'does not silently default the required %s response field', async (field) => {
      callTool.mockResolvedValue(text({ ...envelope, spec: { ...envelope.spec, [field]: undefined } }));
      await expect(client().agentMessageCreate({ agent_id: envelope.spec.agent_id, title: 'Ready for review', category: 'completion', description: 'Ready' })).rejects.toThrow('Malformed');
    });

  it('propagates authoritative tool errors instead of falling back to deprecated Alert tools', async () => {
    callTool.mockResolvedValue({ isError: true, content: [{ type: 'text', text: 'CAS conflict' }] });
    await expect(client().agentMessageUpdate({ id: 'message-1', expectedResourceVersion: 2, status: 'open' }))
      .rejects.toThrow('CAS conflict');
    expect(callTool).toHaveBeenCalledTimes(1);
  });

  it('fails explicitly on an unavailable control plane', async () => {
    await expect(new ControlPlaneClient({ resolveUrl: () => null }).agentMessageRead()).rejects.toBeInstanceOf(ControlPlaneClientError);
    expect(callTool).not.toHaveBeenCalled();
  });
});
