import { beforeAll, describe, expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { clearKinds } from '../src/kinds/registry';
import { loadKinds } from '../src/kinds/loader';
import { startServer } from '../src/server';
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
  slug: string;
  title: string;
  repository: string;
  sourceRevision?: string;
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
            slug: 'working-memory-dev',
            title: 'Working Memory development container',
            repository: 'https://github.com/mkubarycz/working-memory.git',
          },
        }),
      );
      expect(created.id).toMatch(/^[0-9a-f-]{36}$/);
      expect(created.sourceRevision).toBeUndefined();
      expect(created.resourceVersion).toBe(1);
      expect(Object.keys(created).sort()).toEqual(
        ['created_at', 'id', 'repository', 'resourceVersion', 'slug', 'title', 'updated_at'].sort(),
      );

      const updated = jsonOf<Claim>(
        await client.callTool({
          name: 'ws-containerclaim-update',
          arguments: { slug: created.slug, sourceRevision: 'feature/container-claims' },
        }),
      );
      expect(updated.sourceRevision).toBe('feature/container-claims');
      expect(updated.repository).toBe(created.repository);
      expect(updated.resourceVersion).toBe(2);

      const resetToDefault = jsonOf<Claim>(
        await client.callTool({
          name: 'ws-containerclaim-update',
          arguments: { slug: created.slug, sourceRevision: null },
        }),
      );
      expect(resetToDefault.sourceRevision).toBeUndefined();
      expect(resetToDefault.resourceVersion).toBe(3);

      const read = jsonOf<{ count: number; claims: Claim[] }>(
        await client.callTool({
          name: 'ws-containerclaim-read',
          arguments: { id: created.id },
        }),
      );
      expect(read).toMatchObject({ count: 1, claims: [{ slug: created.slug }] });

      expect(
        jsonOf<{ ok: boolean; slug: string }>(
          await client.callTool({
            name: 'ws-containerclaim-delete',
            arguments: { slug: created.slug },
          }),
        ),
      ).toEqual({ ok: true, slug: created.slug });
      const afterDelete = jsonOf<{ count: number }>(
        await client.callTool({
          name: 'ws-containerclaim-read',
          arguments: { slug: created.slug },
        }),
      );
      expect(afterDelete.count).toBe(0);

      const duplicateWhileDeleted = await client.callTool({
        name: 'ws-containerclaim-create',
        arguments: {
          slug: created.slug,
          title: 'Replacement claim',
          repository: 'owner/replacement',
        },
      });
      expect(isErrorResult(duplicateWhileDeleted)).toBe(true);
      expect(textOf(duplicateWhileDeleted)).toContain('already in use');

      const genericDuplicateWhileDeleted = await client.callTool({
        name: 'wm-document-create',
        arguments: {
          kind: 'ContainerClaim',
          slug: created.slug,
          spec: { title: 'Generic replacement', repository: 'owner/generic-replacement' },
        },
      });
      expect(isErrorResult(genericDuplicateWhileDeleted)).toBe(true);
      expect(textOf(genericDuplicateWhileDeleted)).toContain('already in use');

      expect(
        jsonOf<{ ok: boolean; slug: string }>(
          await client.callTool({
            name: 'ws-containerclaim-delete',
            arguments: { slug: created.slug, restore: true },
          }),
        ),
      ).toEqual({ ok: true, slug: created.slug });
      const restored = jsonOf<{ count: number; claims: Claim[] }>(
        await client.callTool({
          name: 'ws-containerclaim-read',
          arguments: { query: created.slug },
        }),
      );
      expect(restored).toMatchObject({ count: 1, claims: [{ id: created.id }] });
    } finally {
      await close();
    }
  });

  it('rejects invalid identity, missing intent fields, duplicate slugs, and extra fields', async () => {
    const { client, close } = await connect(openStore(':memory:'));
    try {
      const invalidSlug = await client.callTool({
        name: 'ws-containerclaim-create',
        arguments: { slug: 'Not Valid', title: 'Claim', repository: 'owner/repo' },
      });
      expect(isErrorResult(invalidSlug)).toBe(true);
      expect(textOf(invalidSlug)).toContain('lowercase words separated with dashes');

      const missingRepository = await client.callTool({
        name: 'ws-containerclaim-create',
        arguments: { slug: 'missing-source', title: 'Claim' },
      });
      expect(isErrorResult(missingRepository)).toBe(true);

      const blankRepository = await client.callTool({
        name: 'ws-containerclaim-create',
        arguments: { slug: 'blank-source', title: 'Claim', repository: '   ' },
      });
      expect(isErrorResult(blankRepository)).toBe(true);

      await client.callTool({
        name: 'ws-containerclaim-create',
        arguments: { slug: 'one-claim', title: 'Claim', repository: 'owner/repo' },
      });
      const duplicate = await client.callTool({
        name: 'ws-containerclaim-create',
        arguments: { slug: 'one-claim', title: 'Other', repository: 'other/repo' },
      });
      expect(isErrorResult(duplicate)).toBe(true);
      expect(textOf(duplicate)).toContain('already in use');

      const runtimeField = await client.callTool({
        name: 'wm-document-create',
        arguments: {
          kind: 'ContainerClaim',
          slug: 'runtime-field',
          spec: { title: 'Claim', repository: 'owner/repo', dockerId: 'abc123' },
        },
      });
      expect(isErrorResult(runtimeField)).toBe(true);
      expect(textOf(runtimeField)).toContain('dockerId');
    } finally {
      await close();
    }
  });
});