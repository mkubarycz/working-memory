import { beforeEach, expect, test, vi } from 'vitest';
import { openJournalStore } from '../src/db';
import { getAllPanelData, getPanelData } from '../src/panelData';
import { renderTopicDoc, renderTopicTypeDoc } from '../src/renderer';

vi.mock('vscode', () => {
  const tools = new Map<string, { invoke: (options: unknown) => Promise<unknown> }>();
  class LanguageModelTextPart {
    constructor(public value: string) {}
  }
  class LanguageModelToolResult {
    constructor(public content: LanguageModelTextPart[]) {}
  }
  class Disposable {
    constructor(private readonly disposeFn: () => void) {}
    dispose(): void {
      this.disposeFn();
    }
  }
  return {
    lm: {
      registerTool: (
        name: string,
        impl: { invoke: (options: unknown) => Promise<unknown> },
      ) => {
        tools.set(name, impl);
        return new Disposable(() => tools.delete(name));
      },
    },
    LanguageModelTextPart,
    LanguageModelToolResult,
    Disposable,
    __getRegisteredTool: (name: string) => tools.get(name),
    __clearRegisteredTools: () => tools.clear(),
  };
});

function parseToolResult(result: unknown): Record<string, unknown> {
  const payload = (result as { content: Array<{ value: string }> }).content[0]?.value;
  return JSON.parse(payload ?? '{}') as Record<string, unknown>;
}

beforeEach(async () => {
  const vscode = await import('vscode');
  (vscode as unknown as { __clearRegisteredTools: () => void }).__clearRegisteredTools();
});

test('db topic-type CRUD supports create/get/update/delete with blocker checks', () => {
  const store = openJournalStore({ dbPath: ':memory:' });
  const created = store.createTopicType({
    id: 'initiative',
    label: 'Initiative',
    icon: 'target',
    description: 'Large multi-workstream effort.',
  });
  expect(created.id).toBe('initiative');

  store.createTopic({
    slug: 'initiative-top',
    topic_type: 'initiative',
    title: 'Initiative Topic',
  });

  const fetched = store.getTopicType('initiative');
  expect(fetched?.topic_count).toBe(1);

  const updated = store.updateTopicType('initiative', {
    label: 'Initiative Updated',
    description: 'Updated description.',
  });
  expect(updated.label).toBe('Initiative Updated');

  expect(() => store.deleteTopicType('initiative')).toThrow(
    /1 topic\(s\) still reference/i,
  );

  store.createTopicType({
    id: 'deletable',
    label: 'Deletable',
    icon: 'trash',
    description: 'Can be deleted.',
  });
  const del = store.deleteTopicType('deletable');
  expect(del.deleted).toBe(1);
  expect(store.getTopicType('deletable')).toBeNull();
  store.close();
});

test('db createTopicType rejects duplicate ids', () => {
  const store = openJournalStore({ dbPath: ':memory:' });
  store.createTopicType({
    id: 'initiative',
    label: 'Initiative',
    icon: 'target',
    description: 'Large effort.',
  });
  expect(() =>
    store.createTopicType({
      id: 'initiative',
      label: 'Initiative 2',
      icon: 'target',
      description: 'Duplicate.',
    }),
  ).toThrow(/already exists/i);
  store.close();
});

test('renderer topic doc links Type line to topic-type deep link', () => {
  const store = openJournalStore({ dbPath: ':memory:' });
  store.createTopic({ slug: 'feat-1', title: 'Feat 1', topic_type: 'feature' });
  const doc = renderTopicDoc(store, 'feat-1');
  expect(doc).toContain(
    '- **Type:** [Feature](vscode://kubarycz.working-memory/open/topic-type/feature)',
  );
  store.close();
});

test('renderer topic-type doc renders metadata and recent topic links', () => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));
  const store = openJournalStore({ dbPath: ':memory:' });
  store.createTopicType({
    id: 'initiative',
    label: 'Initiative',
    icon: 'target',
    description: 'Large effort.',
  });
  for (let i = 0; i < 30; i++) {
    store.createTopic({
      slug: `initiative-${String(i).padStart(2, '0')}`,
      title: `Initiative ${i}`,
      topic_type: 'initiative',
    });
    vi.setSystemTime(new Date(Date.now() + 1000));
    store.updateTopic(`initiative-${String(i).padStart(2, '0')}`, {
      body: `updated ${i}`,
    });
    vi.setSystemTime(new Date(Date.now() + 1000));
  }
  const rendered = renderTopicTypeDoc(store, 'initiative');
  expect(rendered).toContain('# Initiative `initiative`');
  expect(rendered).toContain('- **Icon:** `target`');
  expect(rendered).toContain('- **Topics using this type:** 30');
  expect(rendered).toContain('## Recent topics');
  const lines = rendered.split('\n').filter((line) => line.startsWith('- [Initiative '));
  expect(lines).toHaveLength(25);
  expect(lines[0]).toContain(
    'vscode://kubarycz.working-memory/open/topic/initiative-29',
  );
  store.close();
  vi.useRealTimers();
});

test('panel data exposes topic-types tab and all.topicTypes payload', () => {
  const store = openJournalStore({ dbPath: ':memory:' });
  store.createTopicType({
    id: 'initiative',
    label: 'Initiative',
    icon: 'target',
    description: 'Large effort.',
  });
  store.createTopic({
    slug: 'initiative-1',
    title: 'Initiative 1',
    topic_type: 'initiative',
  });

  const topicTypes = getPanelData(store, 'topic-types');
  expect(topicTypes.tab).toBe('topic-types');
  const initiative = topicTypes.items.find(
    (item) => item.kind === 'topic-type' && item.id === 'topic-types:type:initiative',
  );
  expect(initiative?.kind).toBe('topic-type');
  if (!initiative || initiative.kind !== 'topic-type') {
    throw new Error('expected topic-type row');
  }
  expect(initiative.topicCount).toBe(1);

  const all = getAllPanelData(store);
  expect(all.topicTypes.tab).toBe('topic-types');
  store.close();
});

test('topic-type tools support happy path and key error paths', async () => {
  const store = openJournalStore({ dbPath: ':memory:' });
  const refresh = vi.fn();
  const { registerTools } = await import('../src/tools');
  const vscode = await import('vscode');
  registerTools(
    { subscriptions: [] } as unknown as { subscriptions: Array<{ dispose: () => void }> },
    store,
    { refresh },
  );
  const getTool = (name: string) =>
    (vscode as unknown as { __getRegisteredTool: (n: string) => { invoke: (o: unknown) => Promise<unknown> } }).__getRegisteredTool(
      name,
    );

  const created = parseToolResult(
    await getTool('wm_create_topic_type').invoke({
      input: {
        id: 'initiative',
        label: 'Initiative',
        icon: 'target',
        description: 'Large effort.',
      },
    }),
  );
  expect(created.ok).toBe(true);

  const dup = parseToolResult(
    await getTool('wm_create_topic_type').invoke({
      input: {
        id: 'initiative',
        label: 'Initiative',
        icon: 'target',
        description: 'Large effort.',
      },
    }),
  );
  expect(dup.ok).toBe(false);
  expect(String(dup.error)).toMatch(/already exists/i);

  const missing = parseToolResult(
    await getTool('wm_get_topic_type').invoke({ input: {} }),
  );
  expect(missing.ok).toBe(false);
  expect(String(missing.error)).toMatch(/id is required/i);

  store.createTopic({
    slug: 'initiative-1',
    title: 'Initiative 1',
    topic_type: 'initiative',
  });
  const blocked = parseToolResult(
    await getTool('wm_delete_topic_type').invoke({ input: { id: 'initiative' } }),
  );
  expect(blocked.ok).toBe(false);
  expect(String(blocked.error)).toMatch(/still reference/i);

  const seeded = parseToolResult(
    await getTool('wm_delete_topic_type').invoke({ input: { id: 'topic' } }),
  );
  expect(seeded.ok).toBe(false);
  expect(String(seeded.error)).toMatch(/seeded topic type/i);

  const updated = parseToolResult(
    await getTool('wm_update_topic_type').invoke({
      input: { id: 'initiative', icon: 'flame', description: 'Updated description.' },
    }),
  );
  expect(updated.ok).toBe(true);
  expect((updated.topic_type as { icon: string }).icon).toBe('flame');
  expect((updated.topic_type as { description: string }).description).toBe(
    'Updated description.',
  );

  const labelUpdated = parseToolResult(
    await getTool('wm_update_topic_type').invoke({
      input: { id: 'initiative', label: 'Defect Demo' },
    }),
  );
  expect(labelUpdated.ok).toBe(true);
  expect((labelUpdated.topic_type as { label: string }).label).toBe('Defect Demo');

  const emptyLabel = parseToolResult(
    await getTool('wm_update_topic_type').invoke({
      input: { id: 'initiative', label: '' },
    }),
  );
  expect(emptyLabel.ok).toBe(false);
  expect(String(emptyLabel.error)).toMatch(/label must not be empty/i);

  expect(refresh).toHaveBeenCalled();
  store.close();
});
