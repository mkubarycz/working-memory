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

vi.mock('@modelcontextprotocol/sdk/client/streamableHttp.js', () => ({
  StreamableHTTPClientTransport: class {
    constructor(_url: URL) {}
    close = transportCloseMock;
  },
}));

import { ControlPlaneClient, ControlPlaneClientError } from '../src/controlPlaneClient';

const okText = (obj: unknown) => ({ content: [{ type: 'text', text: JSON.stringify(obj) }] });
const errText = (msg: string) => ({ isError: true, content: [{ type: 'text', text: msg }] });

function makeClient(resolveUrl: () => string | null = () => 'http://127.0.0.1:9/mcp') {
  return new ControlPlaneClient({ resolveUrl });
}

describe('ControlPlaneClient catalog surface (mocked listTools/callTool)', () => {
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

  it('callTool() forwards the name + args and parses the JSON text payload', async () => {
    callToolMock.mockResolvedValueOnce(okText({ ok: true, slug: 'roadmap' }));
    const outcome = await makeClient().callTool('ws-topic-create', { title: 'Roadmap' });
    expect(callToolMock).toHaveBeenCalledWith({
      name: 'ws-topic-create',
      arguments: { title: 'Roadmap' },
    });
    expect(outcome).toEqual({ ok: true, result: { ok: true, slug: 'roadmap' } });
  });

  it('callTool() maps an isError result to { ok: false, error }', async () => {
    callToolMock.mockResolvedValueOnce(errText('slug already exists'));
    const outcome = await makeClient().callTool('ws-topic-create', { slug: 'dup' });
    expect(outcome).toEqual({ ok: false, error: 'slug already exists' });
  });

  it('callTool() returns { ok: false } when the daemon is down (no throw)', async () => {
    const outcome = await makeClient(() => null).callTool('ws-topic-read', {});
    expect(outcome.ok).toBe(false);
    expect(outcome.error).toContain('not running');
  });
});
