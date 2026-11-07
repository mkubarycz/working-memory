import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * Unit-tests the canonical-catalog client surface (WM 14.2.1
 * "derive-local-tools-from-canonical-registry") in ISOLATION from a real
 * daemon: the SDK `Client` + transport are mocked so `listTools` / `callTool`
 * return canned MCP results. Pins down how `listTools()` shapes the canonical
 * catalog and how the generic `callTool()` maps success / `isError` / down-daemon
 * into a {@link ToolCallOutcome}.
 */

const listToolsMock = vi.fn();
const callToolMock = vi.fn();
const connectMock = vi.fn();
const clientCloseMock = vi.fn();
const transportCloseMock = vi.fn();

vi.mock('@modelcontextprotocol/sdk/client/index.js', () => ({
  Client: class {
    connect = connectMock;
    close = clientCloseMock;
    listTools = listToolsMock;
    callTool = callToolMock;
  },
}));

vi.mock('@modelcontextprotocol/sdk/client/streamableHttp.js', async importOriginal => ({
  ...await importOriginal<typeof import('@modelcontextprotocol/sdk/client/streamableHttp.js')>(),
  StreamableHTTPClientTransport: class {
    constructor(_url: URL) {}
    close = transportCloseMock;
  },
}));

import { ControlPlaneClient, ControlPlaneClientError } from '../shared/controlPlaneClient';
import { abortable } from '../shared/abort';

const okText = (obj: unknown) => ({ content: [{ type: 'text', text: JSON.stringify(obj) }] });
const errText = (msg: string) => ({ isError: true, content: [{ type: 'text', text: msg }] });

function makeClient(resolveUrl: () => string | null = () => 'http://127.0.0.1:9/mcp') {
  return new ControlPlaneClient({ resolveUrl });
}

describe('ControlPlaneClient catalog surface (mocked listTools/callTool)', () => {
  it('handles a rejected operation even when its cancellation signal was already aborted', async () => {
    const controller = new AbortController();
    controller.abort(new Error('Search cancelled'));
    await expect(abortable(Promise.reject(new Error('Late operation failure')), controller.signal)).rejects.toThrow('Search cancelled');
  });

  beforeEach(() => {
    listToolsMock.mockReset();
    callToolMock.mockReset();
    connectMock.mockReset().mockResolvedValue(undefined);
    clientCloseMock.mockReset().mockResolvedValue(undefined);
    transportCloseMock.mockReset().mockResolvedValue(undefined);
  });

  it('listTools() maps the MCP tools/list into CanonicalToolDef[]', async () => {
    listToolsMock.mockResolvedValueOnce({
      tools: [
        {
          name: 'ws-topic-create',
          description: 'Create a Topic.',
          inputSchema: { type: 'object', properties: { title: { type: 'string' } } },
        },
        { name: 'wm-document-delete', description: 'Delete a doc.', inputSchema: { type: 'object' } },
        { name: '', description: 'nameless → dropped' },
      ],
    });
    const catalog = await makeClient().listTools();
    expect(catalog).toHaveLength(2);
    expect(catalog[0]).toEqual({
      name: 'ws-topic-create',
      description: 'Create a Topic.',
      inputSchema: { type: 'object', properties: { title: { type: 'string' } } },
    });
    expect(catalog[1].name).toBe('wm-document-delete');
  });

  it('listTools() throws ControlPlaneClientError when the daemon is down', async () => {
    await expect(makeClient(() => null).listTools()).rejects.toBeInstanceOf(
      ControlPlaneClientError,
    );
  });

  it('listTools() throws + resets the connection when the request fails', async () => {
    listToolsMock.mockRejectedValueOnce(new Error('transport gone'));
    await expect(makeClient().listTools()).rejects.toThrow('transport gone');
  });

  it('cancels the actual tools/list request without disconnecting other callers', async () => {
    const controller = new AbortController();
    listToolsMock.mockImplementationOnce((_params, options) => new Promise((_resolve, reject) => {
      options.signal.addEventListener('abort', () => reject(options.signal.reason), { once: true });
    })).mockResolvedValue({ tools: [] });
    const client = makeClient();
    const pending = client.listTools(controller.signal);
    await vi.waitFor(() => expect(listToolsMock).toHaveBeenCalledOnce());
    controller.abort(new Error('Search cancelled'));
    await expect(pending).rejects.toThrow('Search cancelled');
    expect(listToolsMock.mock.calls[0][1].signal).toBe(controller.signal);
    expect(clientCloseMock).not.toHaveBeenCalled();
    await expect(client.listTools()).resolves.toEqual([]);
    expect(connectMock).toHaveBeenCalledOnce();
    await client.dispose();
  });

  it('cancels waiting for a shared handshake without closing it or issuing a late catalog request', async () => {
    let connected!: () => void;
    connectMock.mockImplementationOnce(() => new Promise<void>(resolve => { connected = resolve; }));
    listToolsMock.mockResolvedValue({ tools: [] });
    const client = makeClient();
    const controller = new AbortController();
    const pending = client.listTools(controller.signal);
    await vi.waitFor(() => expect(connectMock).toHaveBeenCalledOnce());
    controller.abort(new Error('Search cancelled'));
    await expect(pending).rejects.toThrow('Search cancelled');
    expect(clientCloseMock).not.toHaveBeenCalled();
    connected();
    await expect(client.listTools()).resolves.toEqual([]);
    expect(listToolsMock).toHaveBeenCalledOnce();
    expect(connectMock).toHaveBeenCalledOnce();
    await client.dispose();
  });

  it('passes cancellation into typed app-registry reads and generic Search reads', async () => {
    const client = makeClient();
    const controller = new AbortController();
    callToolMock.mockResolvedValueOnce(okText({ claims: [] })).mockResolvedValueOnce(okText({ total: 0, documents: [] }));
    await client.containerClaimRead({}, controller.signal);
    await client.callTool('wm-document-query', {}, controller.signal);
    for (const call of callToolMock.mock.calls) expect(call[2]?.signal).toBe(controller.signal);
    await client.dispose();
  });
  it('callTool() forwards the name + args and parses the JSON text payload', async () => {
    callToolMock.mockResolvedValueOnce(okText({ ok: true, id: 'roadmap' }));
    const outcome = await makeClient().callTool('ws-topic-create', { title: 'Roadmap' });
    expect(callToolMock).toHaveBeenCalledWith({
      name: 'ws-topic-create',
      arguments: { title: 'Roadmap' },
    });
    expect(outcome).toEqual({ ok: true, result: { ok: true, id: 'roadmap' } });
  });

  it.each([false, true])('allows semantic inference to finish before the client deadline (cancellable=%s)', async cancellable => {
    callToolMock.mockResolvedValueOnce(okText({ count: 0, results: [] }));
    const client = makeClient();
    const signal = cancellable ? new AbortController().signal : undefined;
    await client.callTool('wm-semantic-search', { queries: ['nanites'] }, signal);
    expect(callToolMock).toHaveBeenCalledWith(
      { name: 'wm-semantic-search', arguments: { queries: ['nanites'] } }, undefined,
      { timeout: 70000, ...(signal ? { signal } : {}) },
    );
    await client.dispose();
  });

  it('callTool() maps an isError result to { ok: false, error }', async () => {
    callToolMock.mockResolvedValueOnce(errText('id already exists'));
    const outcome = await makeClient().callTool('ws-topic-create', { id: 'dup' });
    expect(outcome).toEqual({ ok: false, error: 'id already exists' });
  });

  it('callTool() returns { ok: false } when the daemon is down (no throw)', async () => {
    const outcome = await makeClient(() => null).callTool('ws-topic-read', {});
    expect(outcome.ok).toBe(false);
    expect(outcome.error).toContain('not running');
  });
});
