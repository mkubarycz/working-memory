import { beforeEach, expect, test, vi } from 'vitest';
import { openJournalStore } from '../src/db';
import { renderTopicTypeDoc } from '../src/renderer';

// ---------------------------------------------------------------------------
// Mock vscode
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// Mock reshapeTopicBody so tests run without a real LLM
// ---------------------------------------------------------------------------

vi.mock('../src/topicReshape', () => ({
  reshapeTopicBody: vi.fn(),
}));

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function parseToolResult(result: unknown): Record<string, unknown> {
  const payload = (result as { content: Array<{ value: string }> }).content[0]?.value;
  return JSON.parse(payload ?? '{}') as Record<string, unknown>;
}

beforeEach(async () => {
  const vscode = await import('vscode');
  (vscode as unknown as { __clearRegisteredTools: () => void }).__clearRegisteredTools();
  // Reset mock call state between tests
  const { reshapeTopicBody } = await import('../src/topicReshape');
  vi.mocked(reshapeTopicBody).mockReset();
});

// ---------------------------------------------------------------------------
// DB-layer tests
// ---------------------------------------------------------------------------

test('db updateTopicType accepts body_template, persists it, and bumps updated_at', () => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));

  const store = openJournalStore({ dbPath: ':memory:' });
  store.createTopicType({
    id: 'initiative',
    label: 'Initiative',
    icon: 'target',
    description: 'A large effort.',
  });

  const before = store.getTopicType('initiative')!;
  expect(before.body_template).toBe('');

  // Advance time so updated_at changes
  vi.setSystemTime(new Date('2026-01-01T00:01:00Z'));

  const template = '## User story\n\nDescribe the story.\n\n## Acceptance criteria\n\nList conditions.';
  const updated = store.updateTopicType('initiative', { body_template: template });

  expect(updated.body_template).toBe(template);
  expect(updated.updated_at).toBeGreaterThan(before.updated_at);

  // Verify it round-trips through getTopicType
  const fetched = store.getTopicType('initiative')!;
  expect(fetched.body_template).toBe(template);

  // Verify empty string is valid (removes template)
  const cleared = store.updateTopicType('initiative', { body_template: '' });
  expect(cleared.body_template).toBe('');

  store.close();
  vi.useRealTimers();
});

test('db listTopicTypes returns body_template field', () => {
  const store = openJournalStore({ dbPath: ':memory:' });
  store.createTopicType({
    id: 'bug',
    label: 'Bug',
    icon: 'bug',
    description: 'A defect.',
  });
  store.updateTopicType('bug', { body_template: '## Steps\n\nRepro steps.' });
  const types = store.listTopicTypes();
  const bug = types.find((t) => t.id === 'bug');
  expect(bug?.body_template).toBe('## Steps\n\nRepro steps.');
  store.close();
});

// ---------------------------------------------------------------------------
// Tool-layer tests
// ---------------------------------------------------------------------------

test('wm_get_topic_type includes body_template field', async () => {
  const store = openJournalStore({ dbPath: ':memory:' });
  store.createTopicType({
    id: 'feat',
    label: 'Feature',
    icon: 'star',
    description: 'A feature.',
  });
  store.updateTopicType('feat', { body_template: '## Summary\n\nDescribe.' });

  const refresh = vi.fn();
  const { registerTools } = await import('../src/tools');
  const vscode = await import('vscode');
  registerTools(
    { subscriptions: [] } as unknown as { subscriptions: Array<{ dispose: () => void }> },
    store,
    { refresh },
  );
  const getTool = (name: string) =>
    (vscode as unknown as {
      __getRegisteredTool: (n: string) => { invoke: (o: unknown) => Promise<unknown> };
    }).__getRegisteredTool(name);

  const result = parseToolResult(
    await getTool('wm_get_topic_type').invoke({ input: { id: 'feat' } }),
  );
  expect(result.ok).toBe(true);
  const topicType = result.topic_type as Record<string, unknown>;
  expect(topicType.body_template).toBe('## Summary\n\nDescribe.');
  store.close();
});

test('wm_update_topic_type round-trips body_template', async () => {
  const store = openJournalStore({ dbPath: ':memory:' });
  store.createTopicType({
    id: 'prj',
    label: 'Project',
    icon: 'folder',
    description: 'A project.',
  });

  const refresh = vi.fn();
  const { registerTools } = await import('../src/tools');
  const vscode = await import('vscode');
  registerTools(
    { subscriptions: [] } as unknown as { subscriptions: Array<{ dispose: () => void }> },
    store,
    { refresh },
  );
  const getTool = (name: string) =>
    (vscode as unknown as {
      __getRegisteredTool: (n: string) => { invoke: (o: unknown) => Promise<unknown> };
    }).__getRegisteredTool(name);

  const template = '## Goal\n\nWhat we want.\n\n## Scope\n\nWhat is in/out.';
  const result = parseToolResult(
    await getTool('wm_update_topic_type').invoke({
      input: { id: 'prj', body_template: template },
    }),
  );
  expect(result.ok).toBe(true);
  const topicType = result.topic_type as Record<string, unknown>;
  expect(topicType.body_template).toBe(template);

  // Clear the template
  const cleared = parseToolResult(
    await getTool('wm_update_topic_type').invoke({
      input: { id: 'prj', body_template: '' },
    }),
  );
  expect(cleared.ok).toBe(true);
  expect((cleared.topic_type as Record<string, unknown>).body_template).toBe('');

  store.close();
});

test('wm_create_topic with empty template stores body verbatim (no LLM call)', async () => {
  const store = openJournalStore({ dbPath: ':memory:' });
  // topic type has no body_template by default
  const { reshapeTopicBody } = await import('../src/topicReshape');

  const refresh = vi.fn();
  const { registerTools } = await import('../src/tools');
  const vscode = await import('vscode');
  registerTools(
    { subscriptions: [] } as unknown as { subscriptions: Array<{ dispose: () => void }> },
    store,
    { refresh },
  );
  const getTool = (name: string) =>
    (vscode as unknown as {
      __getRegisteredTool: (n: string) => { invoke: (o: unknown) => Promise<unknown> };
    }).__getRegisteredTool(name);

  const result = parseToolResult(
    await getTool('wm_create_topic').invoke({
      input: {
        slug: 'my-task',
        title: 'My Task',
        body: 'Some raw body text.',
        topic_type: 'task',
      },
    }),
  );
  expect(result.ok).toBe(true);
  const topic = result.topic as Record<string, unknown>;
  expect(topic.body).toBe('Some raw body text.');
  expect(vi.mocked(reshapeTopicBody)).not.toHaveBeenCalled();
  store.close();
});

test('wm_create_topic with non-empty template and non-empty body invokes reshapeTopicBody and stores result', async () => {
  const store = openJournalStore({ dbPath: ':memory:' });
  const template = '## User story\n\nDescribe.\n\n## Acceptance criteria\n\nList conditions.';
  store.updateTopicType('task', { body_template: template });

  const { reshapeTopicBody } = await import('../src/topicReshape');
  vi.mocked(reshapeTopicBody).mockResolvedValue('## User story\n\nReShaped.\n\n## Acceptance criteria\n\n- Done.');

  const refresh = vi.fn();
  const { registerTools } = await import('../src/tools');
  const vscode = await import('vscode');
  registerTools(
    { subscriptions: [] } as unknown as { subscriptions: Array<{ dispose: () => void }> },
    store,
    { refresh },
  );
  const getTool = (name: string) =>
    (vscode as unknown as {
      __getRegisteredTool: (n: string) => { invoke: (o: unknown) => Promise<unknown> };
    }).__getRegisteredTool(name);

  const result = parseToolResult(
    await getTool('wm_create_topic').invoke({
      input: {
        slug: 'task-1',
        title: 'Task One',
        body: 'Do the thing.',
        topic_type: 'task',
      },
    }),
  );
  expect(result.ok).toBe(true);
  const topic = result.topic as Record<string, unknown>;
  expect(topic.body).toBe('## User story\n\nReShaped.\n\n## Acceptance criteria\n\n- Done.');
  expect(vi.mocked(reshapeTopicBody)).toHaveBeenCalledOnce();
  expect(vi.mocked(reshapeTopicBody)).toHaveBeenCalledWith(
    expect.objectContaining({ template, body: 'Do the thing.', title: 'Task One' }),
  );
  // No reshape_warning on success
  expect(result.reshape_warning).toBeUndefined();
  store.close();
});

test('wm_create_topic with non-empty template and empty body stores template verbatim (no LLM call)', async () => {
  const store = openJournalStore({ dbPath: ':memory:' });
  const template = '## User story\n\nDescribe.\n\n## Acceptance criteria\n\nList conditions.';
  store.updateTopicType('task', { body_template: template });

  const { reshapeTopicBody } = await import('../src/topicReshape');

  const refresh = vi.fn();
  const { registerTools } = await import('../src/tools');
  const vscode = await import('vscode');
  registerTools(
    { subscriptions: [] } as unknown as { subscriptions: Array<{ dispose: () => void }> },
    store,
    { refresh },
  );
  const getTool = (name: string) =>
    (vscode as unknown as {
      __getRegisteredTool: (n: string) => { invoke: (o: unknown) => Promise<unknown> };
    }).__getRegisteredTool(name);

  // Call with no body (omitted)
  const result = parseToolResult(
    await getTool('wm_create_topic').invoke({
      input: { slug: 'task-empty', title: 'Task Empty', topic_type: 'task' },
    }),
  );
  expect(result.ok).toBe(true);
  const topic = result.topic as Record<string, unknown>;
  expect(topic.body).toBe(template);
  expect(vi.mocked(reshapeTopicBody)).not.toHaveBeenCalled();
  store.close();
});

test('wm_create_topic falls back and surfaces reshape_warning when reshapeTopicBody rejects', async () => {
  const store = openJournalStore({ dbPath: ':memory:' });
  const template = '## Steps\n\nRepro.\n\n## Expected\n\nExpected behaviour.';
  store.updateTopicType('task', { body_template: template });

  const { reshapeTopicBody } = await import('../src/topicReshape');
  vi.mocked(reshapeTopicBody).mockRejectedValue(new Error('LLM unavailable'));

  const refresh = vi.fn();
  const { registerTools } = await import('../src/tools');
  const vscode = await import('vscode');
  registerTools(
    { subscriptions: [] } as unknown as { subscriptions: Array<{ dispose: () => void }> },
    store,
    { refresh },
  );
  const getTool = (name: string) =>
    (vscode as unknown as {
      __getRegisteredTool: (n: string) => { invoke: (o: unknown) => Promise<unknown> };
    }).__getRegisteredTool(name);

  const rawBody = 'It crashes on startup.';
  const result = parseToolResult(
    await getTool('wm_create_topic').invoke({
      input: { slug: 'bug-1', title: 'Bug One', body: rawBody, topic_type: 'task' },
    }),
  );
  expect(result.ok).toBe(true);
  // Body must be the safe fallback: template + ## Original input + raw body
  const topic = result.topic as Record<string, unknown>;
  expect(topic.body).toBe(`${template}\n\n## Original input\n\n${rawBody}`);
  // reshape_warning must be present
  expect(typeof result.reshape_warning).toBe('string');
  expect(String(result.reshape_warning)).toMatch(/LLM unavailable/i);
  store.close();
});

// ---------------------------------------------------------------------------
// Renderer tests
// ---------------------------------------------------------------------------

test('renderer topic-type doc renders body_template in a fenced code block', () => {
  const store = openJournalStore({ dbPath: ':memory:' });
  store.createTopicType({
    id: 'story',
    label: 'Story',
    icon: 'book',
    description: 'A user story.',
  });
  const template = '## User story\n\nDescribe.\n\n## Acceptance criteria\n\nList.';
  store.updateTopicType('story', { body_template: template });

  const rendered = renderTopicTypeDoc(store, 'story');
  expect(rendered).toContain('## Body template');
  expect(rendered).toContain('```markdown\n' + template + '\n```');
  // Should NOT show the placeholder when a template exists
  expect(rendered).not.toContain('No body template');
  store.close();
});

test('renderer topic-type doc shows placeholder with edit link when body_template is empty', () => {
  const store = openJournalStore({ dbPath: ':memory:' });
  store.createTopicType({
    id: 'note',
    label: 'Note',
    icon: 'note',
    description: 'A note.',
  });

  const rendered = renderTopicTypeDoc(store, 'note');
  expect(rendered).toContain('## Body template');
  expect(rendered).toContain('_No body template');
  expect(rendered).toContain('[Edit]');
  expect(rendered).toContain('working-memory.editTopicTypeBodyTemplate');
  // Should NOT show a fenced block
  expect(rendered).not.toContain('```markdown');
  store.close();
});
