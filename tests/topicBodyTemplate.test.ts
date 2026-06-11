/**
 * Tests for the topic-type body-template feature:
 *   - schema migration (db layer)
 *   - wm_get_topic_type / wm_update_topic_type (tools layer)
 *   - wm_create_topic reshape behavior (mocked reshapeTopicBody)
 *   - renderTopicTypeDoc content-provider render
 */

import { beforeEach, expect, test, vi } from 'vitest';
import { openJournalStore } from '../src/db';
import { renderTopicTypeDoc, extractTopicTypeBodyTemplate, EDITABLE_DIV_OPEN, EDITABLE_DIV_CLOSE, EDITABLE_COMMENT_START, EDITABLE_COMMENT_END } from '../src/renderer';

// ---------------------------------------------------------------------------
// Mock vscode — same shape as other test files
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
// Mock reshapeTopicBody so tests never hit the real VS Code LM API
// ---------------------------------------------------------------------------
const mockReshapeTopicBody = vi.fn<() => Promise<string>>();
vi.mock('../src/topicReshape', async (importActual) => {
  const actual = await importActual<typeof import('../src/topicReshape')>();
  return {
    ...actual,
    reshapeTopicBody: (...args: unknown[]) => mockReshapeTopicBody(...args),
  };
});

function parseToolResult(result: unknown): Record<string, unknown> {
  const payload = (result as { content: Array<{ value: string }> }).content[0]?.value;
  return JSON.parse(payload ?? '{}') as Record<string, unknown>;
}

beforeEach(async () => {
  const vscode = await import('vscode');
  (vscode as unknown as { __clearRegisteredTools: () => void }).__clearRegisteredTools();
  mockReshapeTopicBody.mockReset();
});

// ---------------------------------------------------------------------------
// DB layer
// ---------------------------------------------------------------------------

test('db: TopicType includes body_template (defaults to empty string)', () => {
  const store = openJournalStore({ dbPath: ':memory:' });
  store.createTopicType({
    id: 'prd',
    label: 'PRD',
    icon: 'file-text',
    description: 'Product requirements.',
  });
  const fetched = store.getTopicType('prd');
  expect(fetched).not.toBeNull();
  expect(fetched?.body_template).toBe('');
  store.close();
});

test('db: updateTopicType accepts body_template and bumps updated_at', () => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));
  const store = openJournalStore({ dbPath: ':memory:' });
  store.createTopicType({
    id: 'prd',
    label: 'PRD',
    icon: 'file-text',
    description: 'Product requirements.',
  });
  const before = store.getTopicType('prd')!;

  vi.setSystemTime(new Date('2026-01-01T00:01:00Z'));
  const template = '## User story\nOne sentence.\n\n## Acceptance criteria\nBulleted list.';
  const updated = store.updateTopicType('prd', { body_template: template });

  expect(updated.body_template).toBe(template);
  expect(updated.updated_at).toBeGreaterThan(before.updated_at);
  store.close();
  vi.useRealTimers();
});

test('db: updateTopicType allows empty string body_template (clears it)', () => {
  const store = openJournalStore({ dbPath: ':memory:' });
  store.createTopicType({
    id: 'prd',
    label: 'PRD',
    icon: 'file-text',
    description: 'Product requirements.',
  });
  store.updateTopicType('prd', { body_template: '## Section\nContent.' });
  const cleared = store.updateTopicType('prd', { body_template: '' });
  expect(cleared.body_template).toBe('');
  store.close();
});

test('db: listTopicTypes includes body_template field', () => {
  const store = openJournalStore({ dbPath: ':memory:' });
  const types = store.listTopicTypes();
  // seeded types should all have body_template
  for (const t of types) {
    expect('body_template' in t).toBe(true);
    expect(typeof t.body_template).toBe('string');
  }
  store.close();
});

// ---------------------------------------------------------------------------
// Tools layer
// ---------------------------------------------------------------------------

async function setupTools() {
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
    (
      vscode as unknown as {
        __getRegisteredTool: (n: string) => { invoke: (o: unknown) => Promise<unknown> };
      }
    ).__getRegisteredTool(name);
  return { store, refresh, getTool };
}

test('tools: wm_get_topic_type returns body_template field', async () => {
  const { store, getTool } = await setupTools();

  store.updateTopicType('task', {
    body_template: '## User story\nDetails.',
  });

  const result = parseToolResult(
    await getTool('wm_get_topic_type').invoke({ input: { id: 'task' } }),
  );
  expect(result.ok).toBe(true);
  const tt = result.topic_type as Record<string, unknown>;
  expect(tt.body_template).toBe('## User story\nDetails.');
  store.close();
});

test('tools: wm_update_topic_type round-trips body_template', async () => {
  const { store, getTool } = await setupTools();

  const template = '## Steps to reproduce\nList them.\n\n## Expected\nWhat should happen.';
  const result = parseToolResult(
    await getTool('wm_update_topic_type').invoke({
      input: { id: 'feature', body_template: template },
    }),
  );
  expect(result.ok).toBe(true);
  const tt = result.topic_type as Record<string, unknown>;
  expect(tt.body_template).toBe(template);

  // Verify it persists via get
  const get = parseToolResult(
    await getTool('wm_get_topic_type').invoke({ input: { id: 'feature' } }),
  );
  expect((get.topic_type as Record<string, unknown>).body_template).toBe(template);
  store.close();
});

test('tools: wm_create_topic with empty template stores body verbatim', async () => {
  const { store, getTool } = await setupTools();

  // 'task' has no body_template by default
  const result = parseToolResult(
    await getTool('wm_create_topic').invoke({
      input: { slug: 'my-task', title: 'My Task', body: 'Do the thing.', topic_type: 'task' },
    }),
  );
  expect(result.ok).toBe(true);
  const topic = result.topic as Record<string, unknown>;
  expect(topic.body).toBe('Do the thing.');
  expect(mockReshapeTopicBody).not.toHaveBeenCalled();
  store.close();
});

test('tools: wm_create_topic with non-empty template and non-empty body invokes reshapeTopicBody', async () => {
  const { store, getTool } = await setupTools();

  const template = '## User story\nWrite as "As Michael…".\n\n## Acceptance criteria\nBulleted list.';
  store.updateTopicType('task', { body_template: template });

  mockReshapeTopicBody.mockResolvedValue(
    '## User story\n\nAs Michael, I want to test.\n\n## Acceptance criteria\n\n- Works correctly.',
  );

  const result = parseToolResult(
    await getTool('wm_create_topic').invoke({
      input: {
        slug: 'my-task',
        title: 'My Task',
        body: 'I want to test that it works.',
        topic_type: 'task',
      },
    }),
  );
  expect(result.ok).toBe(true);
  expect(mockReshapeTopicBody).toHaveBeenCalledOnce();
  const topic = result.topic as Record<string, unknown>;
  expect(topic.body).toBe(
    '## User story\n\nAs Michael, I want to test.\n\n## Acceptance criteria\n\n- Works correctly.',
  );
  expect(result.reshape_warning).toBeUndefined();
  store.close();
});

test('tools: wm_create_topic with non-empty template and empty body stores template literally', async () => {
  const { store, getTool } = await setupTools();

  const template = '## User story\nOne sentence.\n\n## Acceptance criteria\nBulleted list.';
  store.updateTopicType('task', { body_template: template });

  const result = parseToolResult(
    await getTool('wm_create_topic').invoke({
      input: { slug: 'my-task', title: 'My Task', topic_type: 'task' },
    }),
  );
  expect(result.ok).toBe(true);
  expect(mockReshapeTopicBody).not.toHaveBeenCalled();
  const topic = result.topic as Record<string, unknown>;
  expect(topic.body).toBe(template);
  store.close();
});

test('tools: wm_create_topic falls back with reshape_warning when reshapeTopicBody rejects', async () => {
  const { store, getTool } = await setupTools();

  const template = '## User story\nOne sentence.\n\n## Acceptance criteria\nBulleted list.';
  store.updateTopicType('task', { body_template: template });

  mockReshapeTopicBody.mockRejectedValue(new Error('LLM unavailable'));

  const result = parseToolResult(
    await getTool('wm_create_topic').invoke({
      input: {
        slug: 'my-task',
        title: 'My Task',
        body: 'Raw body text.',
        topic_type: 'task',
      },
    }),
  );
  expect(result.ok).toBe(true);
  expect(typeof result.reshape_warning).toBe('string');
  expect(String(result.reshape_warning)).toMatch(/LLM unavailable/);
  const topic = result.topic as Record<string, unknown>;
  expect(String(topic.body)).toBe(`${template}\n\n## Original input\n\nRaw body text.`);
  store.close();
});

test('tools: wm_create_topic falls back when reshaped body drops too many template sections', async () => {
  const { store, getTool } = await setupTools();

  // Template with 4 sections
  const template =
    '## Section one\nDesc.\n\n## Section two\nDesc.\n\n## Section three\nDesc.\n\n## Section four\nDesc.';
  store.updateTopicType('task', { body_template: template });

  // LLM only preserves 1 out of 4 sections (> half missing → fallback)
  mockReshapeTopicBody.mockResolvedValue('## Section one\n\nContent only here.');

  const result = parseToolResult(
    await getTool('wm_create_topic').invoke({
      input: {
        slug: 'my-task',
        title: 'My Task',
        body: 'Some body.',
        topic_type: 'task',
      },
    }),
  );
  expect(result.ok).toBe(true);
  expect(typeof result.reshape_warning).toBe('string');
  expect(String(result.reshape_warning)).toMatch(/dropped 3\/4/);
  const topic = result.topic as Record<string, unknown>;
  expect(String(topic.body)).toBe(`${template}\n\n## Original input\n\nSome body.`);
  store.close();
});

// ---------------------------------------------------------------------------
// Content provider / renderer
// ---------------------------------------------------------------------------

test('renderer: renderTopicTypeDoc shows body_template inside editable div when set', () => {
  const store = openJournalStore({ dbPath: ':memory:' });
  const template = '## User story\nWrite as "As Michael…".\n\n## Acceptance criteria\nBulleted list.';
  store.updateTopicType('task', { body_template: template });

  const doc = renderTopicTypeDoc(store, 'task');
  // Template content should appear inside the editable div with HTML comment markers
  expect(doc).toContain(EDITABLE_COMMENT_START);
  expect(doc).toContain(EDITABLE_DIV_OPEN);
  expect(doc).toContain(EDITABLE_DIV_CLOSE);
  expect(doc).toContain(EDITABLE_COMMENT_END);
  expect(doc).toContain(template);
  // Div should wrap the comment markers
  expect(doc.indexOf(EDITABLE_DIV_OPEN)).toBeLessThan(doc.indexOf(EDITABLE_COMMENT_START));
  expect(doc.indexOf(EDITABLE_COMMENT_END)).toBeLessThan(doc.indexOf(EDITABLE_DIV_CLOSE));
  // No command: links or fenced code block
  expect(doc).not.toContain('command:working-memory.editTopicTypeBodyTemplate');
  expect(doc).not.toContain('```markdown');
  store.close();
});

test('renderer: renderTopicTypeDoc shows placeholder inside editable div when body_template is empty', () => {
  const store = openJournalStore({ dbPath: ':memory:' });
  // 'feature' has empty body_template by default
  const doc = renderTopicTypeDoc(store, 'feature');
  // Placeholder should appear inside the editable div with HTML comment markers
  expect(doc).toContain(EDITABLE_COMMENT_START);
  expect(doc).toContain(EDITABLE_DIV_OPEN);
  expect(doc).toContain(EDITABLE_DIV_CLOSE);
  expect(doc).toContain(EDITABLE_COMMENT_END);
  expect(doc).toContain('_No body template — add one here, then save (⌘S)._');
  expect(doc).not.toContain('command:working-memory.editTopicTypeBodyTemplate');
  expect(doc).not.toContain('```markdown');
  store.close();
});

// ---------------------------------------------------------------------------
// extractTopicTypeBodyTemplate parser
// ---------------------------------------------------------------------------

test('extractTopicTypeBodyTemplate: returns template content between fences', () => {
  const store = openJournalStore({ dbPath: ':memory:' });
  const template = '## User story\nOne sentence.\n\n## Acceptance criteria\nBulleted list.';
  store.updateTopicType('task', { body_template: template });
  const doc = renderTopicTypeDoc(store, 'task');
  const extracted = extractTopicTypeBodyTemplate(doc);
  expect(extracted).toBe(template);
  store.close();
});

test('extractTopicTypeBodyTemplate: placeholder → empty string', () => {
  const store = openJournalStore({ dbPath: ':memory:' });
  // 'feature' has empty body_template; doc contains placeholder between fences
  const doc = renderTopicTypeDoc(store, 'feature');
  const extracted = extractTopicTypeBodyTemplate(doc);
  expect(extracted).toBe('');
  store.close();
});

test('extractTopicTypeBodyTemplate: throws when editable comment markers are missing', () => {
  expect(() => extractTopicTypeBodyTemplate('# Topic type\n\nNo fences here.')).toThrow(
    /topic-type doc is missing the editable comment markers/,
  );
});
