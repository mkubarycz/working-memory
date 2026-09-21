import { beforeEach, describe, expect, it, vi } from 'vitest';

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
    close = transportCloseMock;
  },
}));

import { ControlPlaneClient, type ContainerClaim } from '../src/controlPlaneClient';

const runtime = {
  type: 'docker' as const,
  buildContext: '/repo',
  dockerfile: '/repo/Dockerfile',
  imageName: 'clarinet-hero:local',
  containerName: 'working-memory-clarinet-hero',
  hostPort: 4173,
  containerPort: 80,
  healthPath: '/',
  entryPath: '/',
};
const claim: ContainerClaim = {
  id: 'claim-id',
  slug: 'clarinet-hero',
  title: 'Clarinet Hero',
  repository: '/repo',
  runtime,
  created_at: 1,
  updated_at: 1,
  resourceVersion: 1,
};
const okText = (value: unknown) => ({ content: [{ type: 'text', text: JSON.stringify(value) }] });

describe('ControlPlaneClient ContainerClaim API', () => {
  beforeEach(() => {
    callToolMock.mockReset();
    connectMock.mockReset().mockResolvedValue(undefined);
    clientCloseMock.mockReset().mockResolvedValue(undefined);
    transportCloseMock.mockReset().mockResolvedValue(undefined);
  });

  it('reads, creates, and updates typed Docker claims', async () => {
    const client = new ControlPlaneClient({ resolveUrl: () => 'http://127.0.0.1:9/mcp' });
    callToolMock.mockResolvedValueOnce(okText({ count: 1, claims: [claim] }));
    await expect(client.containerClaimRead({ slug: claim.slug })).resolves.toEqual([claim]);
    expect(callToolMock).toHaveBeenLastCalledWith({
      name: 'ws-containerclaim-read',
      arguments: { slug: claim.slug },
    });

    callToolMock.mockResolvedValueOnce(okText(claim));
    await expect(client.containerClaimCreate({
      slug: claim.slug,
      title: claim.title,
      repository: claim.repository,
      runtime,
    })).resolves.toEqual(claim);
    expect(callToolMock).toHaveBeenLastCalledWith({
      name: 'ws-containerclaim-create',
      arguments: {
        slug: claim.slug,
        title: claim.title,
        repository: claim.repository,
        runtime,
      },
    });

    callToolMock.mockResolvedValueOnce(okText({ ...claim, resourceVersion: 2 }));
    await expect(client.containerClaimUpdate({ slug: claim.slug, runtime }))
      .resolves.toMatchObject({ resourceVersion: 2 });
  });
});
