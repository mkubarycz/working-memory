import { describe, expect, it, vi } from 'vitest';
import type { ContainerClaim } from '../../shared/controlPlaneClient';
import { SearchAppTools } from '../src/main/searchAppTools';

const endpoint = { transport: 'streamable-http' as const, url: 'http://localhost:4174/mcp' };
const claim: ContainerClaim = {
  id: 'queries', title: 'Query store', repository: 'owner/queries', mcp: endpoint,
  runtime: { image: 'queries', containerName: 'queries', containerPort: 4174, hostPort: 4174, entryPath: '/' },
  opened_at: 1, updated_at: 1, closed_at: null, resourceVersion: 1,
};
const read = { name: 'query-read', inputSchema: { type: 'object', properties: {} }, annotations: { readOnlyHint: true } };
function fixture() {
  const client = { containerClaimRead: vi.fn(async () => [claim]) };
  const listing = { endpoint, connectionId: 1, tools: [{ ...read, annotations: { ...read.annotations } },
    { ...read, name: 'write', annotations: { readOnlyHint: false } },
    { ...read, name: 'destructive', annotations: { readOnlyHint: true, destructiveHint: true } },
    { name: 'unannotated', inputSchema: read.inputSchema },
  ] };
  const mcp = { connect: vi.fn(), listToolsForRoute: vi.fn(async () => listing), callTool: vi.fn(async () => ({ content: [] })) };
  const inspect = vi.fn(async () => ({ ready: true, state: 'healthy', error: null }));
  const assertCurrent = vi.fn();
  return { client, mcp, listing, inspect, assertCurrent, tools: new SearchAppTools({ client, mcp, inspect, assertCurrent }) };
}

describe('search application tools', () => {
  it('exposes only registered app metadata and explicitly read-only schemas', async () => {
    const f = fixture();
    expect((await f.tools.list())[0]).toMatchObject({ id: claim.id, title: claim.title, mcpAvailable: true });
    const discovery = await f.tools.discover(claim.id);
    expect(discovery.tools.map(tool => tool.name)).toEqual(['app__queries__query-read']);
    await f.tools.call(discovery.tools[0].name, { query: 'capacity' });
    expect(f.mcp.callTool).toHaveBeenCalledWith(claim.id, read.name, { query: 'capacity' }, expect.objectContaining({ connectionId: 1, endpoint }), undefined);
    expect(f.mcp.listToolsForRoute).toHaveBeenCalledTimes(2);
  });

  it('rejects unlisted tools without calling the application', async () => {
    const f = fixture();
    await expect(f.tools.call('app__queries__write', {})).rejects.toThrow('mutating');
    expect(f.mcp.callTool).not.toHaveBeenCalled();
  });

  it.each(['route', 'connection', 'annotation'])('rejects changed %s before execution', async change => {
    const f = fixture();
    const { tools } = await f.tools.discover(claim.id);
    if (change === 'route') f.client.containerClaimRead.mockResolvedValue([{ ...claim, mcp: { ...endpoint, url: 'http://localhost:9000/mcp' } }]);
    if (change === 'connection') f.listing.connectionId = 2;
    if (change === 'annotation') f.listing.tools[0].annotations = { readOnlyHint: false };
    await expect(f.tools.call(tools[0].name, {})).rejects.toThrow('changed');
    expect(f.mcp.callTool).not.toHaveBeenCalled();
  });

  it('does not start stopped/unregistered apps or discover arbitrary endpoints', async () => {
    const f = fixture();
    f.inspect.mockResolvedValue({ ready: false, state: 'stopped', error: null });
    await expect(f.tools.discover(claim.id)).rejects.toThrow('not ready');
    expect(f.mcp.connect).not.toHaveBeenCalled();
    f.client.containerClaimRead.mockResolvedValue([]);
    await expect(f.tools.discover('http://attacker.example/mcp')).rejects.toThrow('not a registered');
    expect(f.mcp.connect).not.toHaveBeenCalled();
  });

  it('rechecks environment identity after each asynchronous boundary', async () => {
    const f = fixture();
    f.client.containerClaimRead.mockImplementation(async () => {
      f.assertCurrent.mockImplementation(() => { throw new Error('Environment changed'); });
      return [claim];
    });
    await expect(f.tools.discover(claim.id)).rejects.toThrow('Environment changed');
    expect(f.mcp.connect).not.toHaveBeenCalled();
  });

  it('propagates cancellation through registry discovery, connection, schema listing and execution', async () => {
    const f = fixture();
    const controller = new AbortController();
    await f.tools.list(controller.signal);
    const { tools } = await f.tools.discover(claim.id, controller.signal);
    await f.tools.call(tools[0].name, {}, controller.signal);
    expect(f.client.containerClaimRead).toHaveBeenCalledWith({}, controller.signal);
    expect(f.mcp.connect).toHaveBeenCalledWith(claim.id, endpoint, controller.signal);
    expect(f.mcp.listToolsForRoute).toHaveBeenCalledWith(claim.id, endpoint, controller.signal);
    expect(f.mcp.callTool).toHaveBeenCalledWith(claim.id, read.name, {}, expect.any(Object), controller.signal);
    controller.abort(new Error('Search cancelled'));
    const reads = f.client.containerClaimRead.mock.calls.length;
    await expect(f.tools.list(controller.signal)).rejects.toThrow('Search cancelled');
    await expect(f.tools.discover(claim.id, controller.signal)).rejects.toThrow('Search cancelled');
    await expect(f.tools.call(tools[0].name, {}, controller.signal)).rejects.toThrow('Search cancelled');
    expect(f.client.containerClaimRead).toHaveBeenCalledTimes(reads);
  });
});
