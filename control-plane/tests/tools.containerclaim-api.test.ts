import { beforeAll, describe, expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '../../tests/authenticatedFixture';
import { clearKinds } from '../src/kinds/registry';
import { loadKinds } from '../src/kinds/loader';
import { startServer } from '../../tests/authenticatedFixture';
import { openStore, type Store } from '../src/store';

let sqliteAvailable = true;
try {
  await import('node:sqlite');
} catch {
  sqliteAvailable = false;
}

function textOf(result: unknown): string {
  const content = (result as { content: { type: string; text?: string }[] }).content;
  return content.find((item) => item.type === 'text')?.text ?? '';
}

function jsonOf<T>(result: unknown): T {
  return JSON.parse(textOf(result)) as T;
}

function isErrorResult(result: unknown): boolean {
  return (result as { isError?: boolean }).isError === true;
}

interface Claim {
  id: string;
  title: string;
  repository: string;
  sourceRevision?: string;
  runtime?: { type: string; volumes?: Array<{ name: string; mountPath: string }> };
  mcp?: { transport: string; url: string };
  desktop?: { icon?: string; embeddable?: boolean };
  application?: {
    id: string;
    contractVersion: string;
    discovery: { toolName: string };
    capabilities: string[];
    dataOwnership: string;
    uiUrl?: string;
    httpUrl?: string;
  };
  resourceVersion: number;
}

let clientSequence = 0;

async function connect(store: Store): Promise<{ client: Client; close: () => Promise<void> }> {
  const server = await startServer({ port: 0, store });
  const client = new Client({
    name: `wm-cp-containerclaim-api-${++clientSequence}`,
    version: '0.0.0',
  });
  const transport = new StreamableHTTPClientTransport(new URL(`${server.url}/mcp`));
  await client.connect(transport);
  return {
    client,
    close: async () => {
      await client.close();
      await server.close();
      store.close();
    },
  };
}

(sqliteAvailable ? describe : describe.skip)('control-plane ContainerClaim API', () => {
  beforeAll(async () => {
    clearKinds();
    await loadKinds();
  });

  it('round-trips explicitly configured LAN TCP/UDP ports and rejects unsafe host addresses', async () => {
    const { client, close } = await connect(openStore(':memory:'));
    const runtime = {
      type: 'docker', buildContext: '/Feedback', dockerfile: '/Feedback/Dockerfile',
      imageName: 'feedback:local', containerName: 'feedback', hostPort: 7722, containerPort: 7722,
      healthPath: '/health', entryPath: '/',
      additionalPorts: [{ hostPort: 7721, containerPort: 7721, protocol: 'udp', hostIp: '0.0.0.0' }],
    };
    try {
      const created = await client.callTool({ name: 'ws-containerclaim-create', arguments: {
        title: 'Feedback', repository: '/Feedback', runtime,
      } });
      expect(isErrorResult(created)).toBe(false);
      expect(jsonOf<{ runtime: typeof runtime }>(created).runtime.additionalPorts).toEqual(runtime.additionalPorts);
      const rejected = await client.callTool({ name: 'ws-containerclaim-update', arguments: {
        id: jsonOf<Claim>(created).id, runtime: { ...runtime, additionalPorts: [{ ...runtime.additionalPorts[0], hostIp: '8.8.8.8' }] },
      } });
      expect(isErrorResult(rejected)).toBe(true);
    } finally { await close(); }
  });

  it('exposes CRUD and round-trips intent without runtime state', async () => {
    const { client, close } = await connect(openStore(':memory:'));
    try {
      const names = (await client.listTools()).tools.map((tool) => tool.name);
      expect(names).toEqual(
        expect.arrayContaining([
          'ws-containerclaim-create',
          'ws-containerclaim-read',
          'ws-containerclaim-update',
          'ws-containerclaim-delete',
        ]),
      );

      const created = jsonOf<Claim>(
        await client.callTool({
          name: 'ws-containerclaim-create',
          arguments: {
            title: 'Working Memory development container',
            repository: 'https://github.com/mkubarycz/working-memory.git',
            runtime: {
              type: 'docker',
              buildContext: '/source',
              dockerfile: '/source/Dockerfile',
              imageName: 'working-memory-dev:local',
              containerName: 'working-memory-dev',
              hostPort: 8080,
              containerPort: 8080,
              healthPath: '/health',
              entryPath: '/',
              volumes: [{ name: 'working-memory-dev-data', mountPath: '/data' }],
            },
            mcp: { transport: 'streamable-http', url: 'http://localhost:8080/mcp' },
            desktop: { icon: 'beaker', embeddable: true },
            application: {
              id: 'working-memory-dev',
              contractVersion: '1.0.0',
              discovery: {
                toolName: 'app-contract-get',
                url: 'http://localhost:8080/.well-known/application-contract',
              },
              capabilities: ['generic-crud'],
              dataOwnership: 'application',
              uiUrl: 'http://localhost:8080/',
              httpUrl: 'http://localhost:8080/api',
            },
          },
        }),
      );
      expect(created.id).toMatch(/^[0-9a-f-]{36}$/);
      expect(created.sourceRevision).toBeUndefined();
      expect(created.resourceVersion).toBe(1);
      expect(created.application).toMatchObject({
        id: 'working-memory-dev',
        discovery: { toolName: 'app-contract-get' },
        dataOwnership: 'application',
      });
      expect(created.runtime?.volumes).toEqual([{ name: 'working-memory-dev-data', mountPath: '/data' }]);
      expect(created.desktop).toEqual({ icon: 'beaker', embeddable: true });
      expect(Object.keys(created).sort()).toEqual(
        [
          'application', 'created_at', 'desktop', 'id', 'mcp', 'repository', 'resourceVersion',
          'runtime', 'title', 'updated_at',
        ].sort(),
      );

      const updated = jsonOf<Claim>(
        await client.callTool({
          name: 'ws-containerclaim-update',
          arguments: {
            id: created.id, sourceRevision: 'feature/container-claims',
            desktop: { icon: 'rocket', embeddable: false },
          },
        }),
      );
      expect(updated.sourceRevision).toBe('feature/container-claims');
      expect(updated.repository).toBe(created.repository);
      expect(updated.application).toEqual(created.application);
      expect(updated.desktop).toEqual({ icon: 'rocket', embeddable: false });
      expect(updated.resourceVersion).toBe(2);

      const resetToDefault = jsonOf<Claim>(
        await client.callTool({
          name: 'ws-containerclaim-update',
          arguments: { id: created.id, sourceRevision: null, desktop: null },
        }),
      );
      expect(resetToDefault.sourceRevision).toBeUndefined();
      expect(resetToDefault.desktop).toBeUndefined();
      expect(resetToDefault.resourceVersion).toBe(3);

      const read = jsonOf<{ count: number; claims: Claim[] }>(
        await client.callTool({
          name: 'ws-containerclaim-read',
          arguments: { id: created.id },
        }),
      );
      expect(read).toMatchObject({ count: 1, claims: [{ id: created.id }] });

      expect(
        jsonOf<{ ok: boolean; id: string }>(
          await client.callTool({
            name: 'ws-containerclaim-delete',
            arguments: { id: created.id },
          }),
        ),
      ).toEqual({ ok: true, id: created.id });
      const afterDelete = jsonOf<{ count: number }>(
        await client.callTool({
          name: 'ws-containerclaim-read',
          arguments: { id: created.id },
        }),
      );
      expect(afterDelete.count).toBe(0);

      const duplicateWhileDeleted = await client.callTool({
        name: 'ws-containerclaim-create',
        arguments: {
          title: 'Replacement claim',
          repository: 'owner/replacement',
        },
      });
      expect(isErrorResult(duplicateWhileDeleted)).toBe(false);
      expect(jsonOf<Claim>(duplicateWhileDeleted).id).not.toBe(created.id);

      const genericDuplicateWhileDeleted = await client.callTool({
        name: 'wm-document-create',
        arguments: {
          kind: 'ContainerClaim',
          spec: { title: 'Generic replacement', repository: 'owner/generic-replacement' },
        },
      });
      expect(isErrorResult(genericDuplicateWhileDeleted)).toBe(false);

      expect(
        jsonOf<{ ok: boolean; id: string }>(
          await client.callTool({
            name: 'ws-containerclaim-delete',
            arguments: { id: created.id, restore: true },
          }),
        ),
      ).toEqual({ ok: true, id: created.id });
      const restored = jsonOf<{ count: number; claims: Claim[] }>(
        await client.callTool({
          name: 'ws-containerclaim-read',
          arguments: { query: created.id },
        }),
      );
      expect(restored).toMatchObject({ count: 1, claims: [{ id: created.id }] });
    } finally {
      await close();
    }
  });

  it('rejects obsolete locators, missing intent fields, and extra fields without restricting duplicate titles', async () => {
    const { client, close } = await connect(openStore(':memory:'));
    try {
      const invalidSlug = await client.callTool({
        name: 'ws-containerclaim-create',
        arguments: { slug: 'Not Valid', title: 'Claim', repository: 'owner/repo' },
      });
      expect(isErrorResult(invalidSlug)).toBe(true);
      expect(textOf(invalidSlug)).toContain('slug');

      const missingRepository = await client.callTool({
        name: 'ws-containerclaim-create',
        arguments: { title: 'Claim' },
      });
      expect(isErrorResult(missingRepository)).toBe(true);

      const blankRepository = await client.callTool({
        name: 'ws-containerclaim-create',
        arguments: { title: 'Claim', repository: '   ' },
      });
      expect(isErrorResult(blankRepository)).toBe(true);

      await client.callTool({
        name: 'ws-containerclaim-create',
        arguments: { title: 'Claim', repository: 'owner/repo' },
      });
      const duplicate = await client.callTool({
        name: 'ws-containerclaim-create',
        arguments: { title: 'Claim', repository: 'other/repo' },
      });
      expect(isErrorResult(duplicate)).toBe(false);

      const runtimeField = await client.callTool({
        name: 'wm-document-create',
        arguments: {
          kind: 'ContainerClaim',
          spec: { title: 'Claim', repository: 'owner/repo', dockerId: 'abc123' },
        },
      });
      expect(isErrorResult(runtimeField)).toBe(true);
      expect(textOf(runtimeField)).toContain('dockerId');

      const invalidApplication = await client.callTool({
        name: 'ws-containerclaim-create',
        arguments: {
          title: 'Invalid application',
          repository: 'owner/repo',
          application: {
            id: 'invalid-application',
            contractVersion: '1',
            discovery: { toolName: 'app-contract-get' },
            capabilities: [],
            dataOwnership: 'working-memory',
          },
        },
      });
      expect(isErrorResult(invalidApplication)).toBe(true);
      expect(textOf(invalidApplication)).toContain('dataOwnership');
      for (const desktop of [
        { icon: 'not a class' },
        { embeddable: 'yes' },
        { unknownField: true },
      ]) {
        const invalidDesktop = await client.callTool({
          name: 'ws-containerclaim-create',
          arguments: { title: 'Invalid desktop', repository: 'owner/repo', desktop },
        });
        expect(isErrorResult(invalidDesktop)).toBe(true);
      }
    } finally {
      await close();
    }
  });
});