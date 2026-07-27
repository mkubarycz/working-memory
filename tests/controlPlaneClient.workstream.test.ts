import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * Unit-tests the typed `ws-*` client methods (WM 13.0 "ws-consumer-repoint") in
 * ISOLATION from a real daemon: the SDK `Client` + transport are mocked so
 * `callTool` returns canned MCP tool results. This pins down exactly how
 * `wsRead`/`wsCreate`/`wsUpdate`/`wsDelete` forward arguments, parse the JSON
 * text result into the owned `Workstream` shape, and throw
 * `ControlPlaneClientError` on an `isError` result or a down daemon.
 */

// Shared mocks — declared before vi.mock so the hoisted factories can close over
// them. Each `new Client()` / transport gets these same fn references.
const callToolMock = vi.fn();
const connectMock = vi.fn();
const clientCloseMock = vi.fn();
const transportCloseMock = vi.fn();

vi.mock('@modelcontextprotocol/sdk/client/index.js', () => ({
  Client: class {
    connect = connectMock;
    close = clientCloseMock;
    callTool = callToolMock;
  },
}));

vi.mock('@modelcontextprotocol/sdk/client/streamableHttp.js', () => ({
  StreamableHTTPClientTransport: class {
    constructor(_url: URL) {}
    close = transportCloseMock;
  },
}));

import {
  ControlPlaneClient,
  ControlPlaneClientError,
  type Workstream,
} from '../src/controlPlaneClient';

/** A success tool result: a single JSON-encoded text content block. */
const okText = (obj: unknown) => ({ content: [{ type: 'text', text: JSON.stringify(obj) }] });
/** An error tool result: `isError` + a RAW (non-JSON) text message. */
const errText = (msg: string) => ({ isError: true, content: [{ type: 'text', text: msg }] });

const sampleWs: Workstream = {
  id: '11111111-1111-1111-1111-111111111111',
  slug: 'cp',
  title: 'Control Plane',
  status: 'progress',
  closure: null,
  opened_at: 1000,
  updated_at: 2000,
  closed_at: null,
  resourceVersion: 1,
};

function makeClient(): ControlPlaneClient {
  return new ControlPlaneClient({ resolveUrl: () => 'http://127.0.0.1:9/mcp' });
}

describe('ControlPlaneClient ws-* methods (mocked callTool)', () => {
  beforeEach(() => {
    callToolMock.mockReset();
    connectMock.mockReset().mockResolvedValue(undefined);
    clientCloseMock.mockReset().mockResolvedValue(undefined);
    transportCloseMock.mockReset().mockResolvedValue(undefined);
  });

  it('wsRead(list) parses { count, workstreams } into a typed Workstream[]', async () => {
    const second: Workstream = { ...sampleWs, id: '22222222-2222-2222-2222-222222222222', slug: 'b' };
    callToolMock.mockResolvedValueOnce(okText({ count: 2, workstreams: [sampleWs, second] }));
    const client = makeClient();

    const list = await client.wsRead({});

    expect(callToolMock).toHaveBeenCalledWith({ name: 'ws-workstream-read', arguments: {} });
    expect(list).toHaveLength(2);
    expect(list[0]).toEqual(sampleWs);
    expect(list[1]?.slug).toBe('b');
  });

  it('wsRead(by slug/query/limit) forwards only the provided args', async () => {
    callToolMock.mockResolvedValueOnce(okText({ count: 1, workstreams: [sampleWs] }));
    const client = makeClient();

    const list = await client.wsRead({ slug: 'cp', query: 'plane', limit: 5 });

    expect(callToolMock).toHaveBeenCalledWith({
      name: 'ws-workstream-read',
      arguments: { slug: 'cp', query: 'plane', limit: 5 },
    });
    expect(list).toEqual([sampleWs]);
  });

  it('wsCreate forwards args and parses the mapped Workstream', async () => {
    callToolMock.mockResolvedValueOnce(okText(sampleWs));
    const client = makeClient();

    const created = await client.wsCreate({ slug: 'cp', title: 'Control Plane', status: 'progress' });

    expect(callToolMock).toHaveBeenCalledWith({
      name: 'ws-workstream-create',
      arguments: { title: 'Control Plane', slug: 'cp', status: 'progress' },
    });
    expect(created).toEqual(sampleWs);
  });

  it('wsUpdate forwards only changed fields and parses the mapped Workstream', async () => {
    const updated: Workstream = { ...sampleWs, title: 'v2', status: 'closed', closed_at: 3000, resourceVersion: 2 };
    callToolMock.mockResolvedValueOnce(okText(updated));
    const client = makeClient();

    const result = await client.wsUpdate({ slug: 'cp', title: 'v2', status: 'closed' });

    expect(callToolMock).toHaveBeenCalledWith({
      name: 'ws-workstream-update',
      arguments: { slug: 'cp', title: 'v2', status: 'closed' },
    });
    expect(result).toEqual(updated);
  });

  it('wsDelete parses { ok, slug } and forwards restore:true', async () => {
    callToolMock.mockResolvedValueOnce(okText({ ok: true, slug: 'cp' }));
    const client = makeClient();

    const del = await client.wsDelete({ slug: 'cp' });
    expect(callToolMock).toHaveBeenCalledWith({ name: 'ws-workstream-delete', arguments: { slug: 'cp' } });
    expect(del).toEqual({ ok: true, slug: 'cp' });

    callToolMock.mockResolvedValueOnce(okText({ ok: true, slug: 'cp' }));
    await client.wsDelete({ slug: 'cp', restore: true });
    expect(callToolMock).toHaveBeenLastCalledWith({
      name: 'ws-workstream-delete',
      arguments: { slug: 'cp', restore: true },
    });
  });

  it('throws ControlPlaneClientError (with the message) when a tool result isError', async () => {
    callToolMock.mockResolvedValueOnce(errText('Unknown workstream slug: "ghost".'));
    const client = makeClient();

    await expect(client.wsRead({ slug: 'ghost' })).rejects.toBeInstanceOf(ControlPlaneClientError);
    callToolMock.mockResolvedValueOnce(errText('Conflict: workstream "cp" changed.'));
    await expect(client.wsUpdate({ slug: 'cp', title: 'x' })).rejects.toThrow(/Conflict/);
  });

  it('throws ControlPlaneClientError when the daemon is unavailable (no URL), without calling callTool', async () => {
    const client = new ControlPlaneClient({ resolveUrl: () => null });

    await expect(client.wsRead({})).rejects.toBeInstanceOf(ControlPlaneClientError);
    expect(callToolMock).not.toHaveBeenCalled();
  });

  it('throws ControlPlaneClientError on a malformed (non-Workstream) success payload', async () => {
    callToolMock.mockResolvedValueOnce(okText({ nonsense: true }));
    const client = makeClient();

    await expect(client.wsCreate({ title: 'x' })).rejects.toBeInstanceOf(ControlPlaneClientError);
  });
});
