import { expect, test } from 'vitest';
import { openJournalStore } from '../src/db';
import { buildTopicBreadcrumb, renderTopicDoc } from '../src/renderer';

// ---------------------------------------------------------------------------
// buildTopicBreadcrumb unit tests
// ---------------------------------------------------------------------------

test('breadcrumb: orphan topic returns "Orphan"', () => {
  const store = openJournalStore({ dbPath: ':memory:' });
  store.createTopic({ slug: 'alone', title: 'Alone' });
  expect(buildTopicBreadcrumb(store, 'alone')).toBe('Orphan');
  store.close();
});

test('breadcrumb: linear family renders full trail', () => {
  const store = openJournalStore({ dbPath: ':memory:' });
  store.createTopic({ slug: 'grand', title: 'Grand Parent' });
  store.createTopic({ slug: 'parent', title: 'Parent' });
  store.createTopic({ slug: 'current', title: 'Current' });
  store.createTopic({ slug: 'child', title: 'Child' });
  store.createTopic({ slug: 'grand-child', title: 'Grandchild' });
  store.addTopicParent('parent', 'grand');
  store.addTopicParent('current', 'parent');
  store.addTopicParent('child', 'current');
  store.addTopicParent('grand-child', 'child');

  const breadcrumb = buildTopicBreadcrumb(store, 'current');

  expect(breadcrumb).toContain('[Grand Parent]');
  expect(breadcrumb).toContain('[Parent]');
  expect(breadcrumb).toContain('**Current**');
  expect(breadcrumb).toContain('[Child]');
  expect(breadcrumb).toContain('[Grandchild]');

  // Order: ancestors > current > descendants
  const parts = breadcrumb.split(' > ');
  expect(parts).toHaveLength(5);
  expect(parts[0]).toContain('Grand Parent');
  expect(parts[1]).toContain('Parent');
  expect(parts[2]).toBe('**Current**');
  expect(parts[3]).toContain('Child');
  expect(parts[4]).toContain('Grandchild');

  store.close();
});

test('breadcrumb: only ancestors (no children)', () => {
  const store = openJournalStore({ dbPath: ':memory:' });
  store.createTopic({ slug: 'root', title: 'Root' });
  store.createTopic({ slug: 'leaf', title: 'Leaf' });
  store.addTopicParent('leaf', 'root');

  const breadcrumb = buildTopicBreadcrumb(store, 'leaf');
  const parts = breadcrumb.split(' > ');
  expect(parts).toHaveLength(2);
  expect(parts[0]).toContain('Root');
  expect(parts[1]).toBe('**Leaf**');

  store.close();
});

test('breadcrumb: only descendants (no parents)', () => {
  const store = openJournalStore({ dbPath: ':memory:' });
  store.createTopic({ slug: 'root', title: 'Root' });
  store.createTopic({ slug: 'child', title: 'Child' });
  store.addTopicParent('child', 'root');

  const breadcrumb = buildTopicBreadcrumb(store, 'root');
  const parts = breadcrumb.split(' > ');
  expect(parts).toHaveLength(2);
  expect(parts[0]).toBe('**Root**');
  expect(parts[1]).toContain('Child');

  store.close();
});

test('breadcrumb: closed topics render with strikethrough', () => {
  const store = openJournalStore({ dbPath: ':memory:' });
  store.createTopic({ slug: 'closed-parent', title: 'Old Parent' });
  store.createTopic({ slug: 'current', title: 'Current' });
  store.createTopic({ slug: 'closed-child', title: 'Done Child' });
  store.updateTopic('closed-parent', { status: 'closed' });
  store.updateTopic('closed-child', { status: 'closed' });
  store.addTopicParent('current', 'closed-parent');
  store.addTopicParent('closed-child', 'current');

  const breadcrumb = buildTopicBreadcrumb(store, 'current');

  // Closed nodes use ~~...~~ strikethrough
  expect(breadcrumb).toContain('~~[Old Parent]');
  expect(breadcrumb).toContain('~~[Done Child]');
  // Current topic is bold and not struck through
  expect(breadcrumb).toContain('**Current**');
  expect(breadcrumb).not.toMatch(/~~\*\*Current\*\*~~/);

  store.close();
});

test('breadcrumb: ancestor links use topic deep-link URI', () => {
  const store = openJournalStore({ dbPath: ':memory:' });
  store.createTopic({ slug: 'epic', title: 'Epic' });
  store.createTopic({ slug: 'task', title: 'Task' });
  store.addTopicParent('task', 'epic');

  const breadcrumb = buildTopicBreadcrumb(store, 'task');
  expect(breadcrumb).toContain('vscode://kubarycz.working-memory/open/topic/epic');

  store.close();
});

// ---------------------------------------------------------------------------
// renderTopicDoc integration: Family line appears in the properties block
// ---------------------------------------------------------------------------

test('renderTopicDoc includes Family line with breadcrumb', () => {
  const store = openJournalStore({ dbPath: ':memory:' });
  store.createTopic({ slug: 'parent', title: 'Parent' });
  store.createTopic({ slug: 'child', title: 'Child' });
  store.addTopicParent('child', 'parent');

  const doc = renderTopicDoc(store, 'child');
  expect(doc).toContain('- **Family:**');
  expect(doc).toContain('**Child**');
  expect(doc).toContain('[Parent]');

  store.close();
});

test('renderTopicDoc shows Orphan when topic has no family', () => {
  const store = openJournalStore({ dbPath: ':memory:' });
  store.createTopic({ slug: 'lone', title: 'Lone Topic' });

  const doc = renderTopicDoc(store, 'lone');
  expect(doc).toContain('- **Family:** Orphan');

  store.close();
});
