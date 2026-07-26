import { describe, it, expect, afterEach, beforeAll } from 'vitest';
import { startServer, type RunningServer } from '../control-plane/src/server';
import { clearKinds } from '../control-plane/src/kinds/registry';
import { loadKinds } from '../control-plane/src/kinds/loader';
import { ControlPlaneClient } from '../src/controlPlaneClient';
import {
  listWorkstreams,
  createWorkstream,
  updateWorkstream,
  getWorkstream,
  deleteWorkstream,
  restoreWorkstream,
  WorkstreamDomainError,
} from '../src/domain/workstreams';

/**
 * Proves the workstream DOMAIN LAYER on top of the control-plane document CRUD
 * tools. Stands up an ephemeral in-process server (port 0, `:memory:` store),
 * loads the kind registry, points a `ControlPlaneClient` at it, and drives the
 * domain functions — mapping a `Workstream` document ↔ the legacy shape.
 */
describe('workstream domain layer', () => {
  let server: RunningServer | null = null;

  beforeAll(async () => {
    clearKinds();
    await loadKinds();
  });

  afterEach(async () => {
    await server?.close();
    server = null;
  });

  async function connect(): Promise<{ client: ControlPlaneClient; url: string }> {
    server = await startServer({ port: 0 });
    const url = `${server.url}/mcp`;
    return { client: new ControlPlaneClient({ resolveUrl: () => url }), url };
  }

  it('createWorkstream then listWorkstreams returns it with mapped fields', async () => {
    const { client } = await connect();
    try {
      const created = await createWorkstream(client, {
        slug: 'my-ws',
        title: 'My Workstream',
      });
      expect(created.slug).toBe('my-ws');
      expect(created.title).toBe('My Workstream');
      // Kind default lifecycle status.
      expect(created.status).toBe('progress');
      expect(created.closure).toBeNull();
      expect(created.closed_at).toBeNull();
      // opened_at/updated_at map to envelope timestamps (numbers).
      expect(typeof created.opened_at).toBe('number');
      expect(typeof created.updated_at).toBe('number');

      const list = await listWorkstreams(client);
      expect(list.map((w) => w.slug)).toContain('my-ws');
      const found = list.find((w) => w.slug === 'my-ws');
      expect(found?.title).toBe('My Workstream');
      expect(found?.status).toBe('progress');
    } finally {
      await client.dispose();
    }
  });

  it('honors an explicit lifecycle status and closure at create', async () => {
    const { client } = await connect();
    try {
      const created = await createWorkstream(client, {
        slug: 'closed-ws',
        title: 'Done',
        status: 'closed',
        closure: 'wrapped up',
      });
      expect(created.status).toBe('closed');
      expect(created.closure).toBe('wrapped up');
      // closed_at is derived from updatedAt when status is 'closed'.
      expect(created.closed_at).toBe(created.updated_at);
    } finally {
      await client.dispose();
    }
  });

  it('updateWorkstream changes status + title and it is reflected', async () => {
    const { client } = await connect();
    try {
      await createWorkstream(client, { slug: 'evolve', title: 'Old Title' });
      const updated = await updateWorkstream(client, {
        slug: 'evolve',
        title: 'New Title',
        status: 'backlog',
      });
      expect(updated.title).toBe('New Title');
      expect(updated.status).toBe('backlog');
      expect(updated.resourceVersion).toBe(2);

      const list = await listWorkstreams(client);
      const found = list.find((w) => w.slug === 'evolve');
      expect(found?.title).toBe('New Title');
      expect(found?.status).toBe('backlog');
    } finally {
      await client.dispose();
    }
  });

  it('errors when updating a missing slug', async () => {
    const { client } = await connect();
    try {
      await expect(
        updateWorkstream(client, { slug: 'ghost', title: 'x' }),
      ).rejects.toBeInstanceOf(WorkstreamDomainError);
    } finally {
      await client.dispose();
    }
  });

  it('rejects an invalid lifecycle status value', async () => {
    const { client } = await connect();
    try {
      await expect(
        createWorkstream(client, {
          slug: 'bad-status',
          title: 'x',
          // Force an out-of-enum value past the TS type.
          status: 'nonsense' as unknown as 'queue',
        }),
      ).rejects.toBeInstanceOf(WorkstreamDomainError);
    } finally {
      await client.dispose();
    }
  });

  it('throws a domain error when the daemon is unavailable', async () => {
    const client = new ControlPlaneClient({ resolveUrl: () => null });
    await expect(listWorkstreams(client)).rejects.toBeInstanceOf(
      WorkstreamDomainError,
    );
    await client.dispose();
  });

  it('getWorkstream returns the mapped workstream, or null for a missing slug', async () => {
    const { client } = await connect();
    try {
      await createWorkstream(client, { slug: 'gettable', title: 'Gettable' });
      const found = await getWorkstream(client, 'gettable');
      expect(found?.slug).toBe('gettable');
      expect(found?.title).toBe('Gettable');
      expect(found?.status).toBe('progress');

      expect(await getWorkstream(client, 'nope')).toBeNull();
    } finally {
      await client.dispose();
    }
  });

  it('deleteWorkstream soft-deletes so it drops out of list + get', async () => {
    const { client } = await connect();
    try {
      await createWorkstream(client, { slug: 'trash-me', title: 'Trash Me' });
      await deleteWorkstream(client, 'trash-me');

      const list = await listWorkstreams(client);
      expect(list.map((w) => w.slug)).not.toContain('trash-me');
      // A live-only read no longer finds it.
      expect(await getWorkstream(client, 'trash-me')).toBeNull();
    } finally {
      await client.dispose();
    }
  });

  it('deleteWorkstream on a missing slug throws a domain error', async () => {
    const { client } = await connect();
    try {
      await expect(deleteWorkstream(client, 'ghost')).rejects.toBeInstanceOf(
        WorkstreamDomainError,
      );
    } finally {
      await client.dispose();
    }
  });

  it('restoreWorkstream undeletes a soft-deleted workstream by slug', async () => {
    const { client } = await connect();
    try {
      await createWorkstream(client, { slug: 'phoenix', title: 'Phoenix' });
      await deleteWorkstream(client, 'phoenix');
      expect((await listWorkstreams(client)).map((w) => w.slug)).not.toContain(
        'phoenix',
      );

      const restored = await restoreWorkstream(client, 'phoenix');
      expect(restored.slug).toBe('phoenix');
      // Back in the live list + readable again.
      expect((await listWorkstreams(client)).map((w) => w.slug)).toContain(
        'phoenix',
      );
      expect((await getWorkstream(client, 'phoenix'))?.title).toBe('Phoenix');
    } finally {
      await client.dispose();
    }
  });

  it('restoreWorkstream throws when there is no soft-deleted document for the slug', async () => {
    const { client } = await connect();
    try {
      await expect(
        restoreWorkstream(client, 'never-existed'),
      ).rejects.toBeInstanceOf(WorkstreamDomainError);
    } finally {
      await client.dispose();
    }
  });
});
