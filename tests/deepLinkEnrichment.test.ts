import { expect, test } from 'vitest';
import { openJournalStore } from '../src/db';
import { deepLink, enrichDeepLinks } from '../src/virtualFileRenderer';

// ---------------------------------------------------------------------------
// enrichDeepLinks: leading type codicon + meaningful child count
// ---------------------------------------------------------------------------

test('topic link gets its topic_type icon and a child-count', () => {
  const store = openJournalStore({ dbPath: ':memory:' });
  store.createTopic({ slug: 'parent', title: 'Parent', topic_type: 'feature' });
  store.createTopic({ slug: 'kid-a', title: 'Kid A', parent_slug: 'parent' });
  store.createTopic({ slug: 'kid-b', title: 'Kid B', parent_slug: 'parent' });

  const md = `[Parent](${deepLink('topic', 'parent')})`;
  const out = enrichDeepLinks(store, md);

  // 'feature' topic-type icon is 'rocket' (seeded by migration 008)
  expect(out).toContain('<span class="codicon codicon-rocket"></span>');
  expect(out).toBe(
    `[<span class="codicon codicon-rocket"></span> Parent (2)](${deepLink('topic', 'parent')})`,
  );
  store.close();
});

test('topic with no children gets icon but no count', () => {
  const store = openJournalStore({ dbPath: ':memory:' });
  store.createTopic({ slug: 'lonely', title: 'Lonely', topic_type: 'topic' });

  const md = `[Lonely](${deepLink('topic', 'lonely')})`;
  const out = enrichDeepLinks(store, md);

  // 'topic' topic-type icon is 'symbol-misc'
  expect(out).toBe(
    `[<span class="codicon codicon-symbol-misc"></span> Lonely](${deepLink('topic', 'lonely')})`,
  );
  store.close();
});

test('session link gets comment-discussion icon and entry-count', () => {
  const store = openJournalStore({ dbPath: ':memory:' });
  store.createWorkstream({ slug: 'ws', title: 'WS' });
  const session = store.startSession({ workstream_slug: 'ws' });
  store.appendEntry({ session_id: session.session_id, body: 'one', created_by: 'test' });
  store.appendEntry({ session_id: session.session_id, body: 'two', created_by: 'test' });

  const md = `[a session](${deepLink('session', session.session_id)})`;
  const out = enrichDeepLinks(store, md);

  expect(out).toContain('<span class="codicon codicon-comment-discussion"></span>');
  expect(out).toContain('</span> a session (2)]');
  store.close();
});

test('workstream link gets repo icon and linked-topic count', () => {
  const store = openJournalStore({ dbPath: ':memory:' });
  store.createWorkstream({ slug: 'ws', title: 'WS' });
  store.createTopic({ slug: 't1', title: 'T1', workstream_slug: 'ws' });
  store.createTopic({ slug: 't2', title: 'T2', workstream_slug: 'ws' });

  const md = `[WS](${deepLink('workstream', 'ws')})`;
  const out = enrichDeepLinks(store, md);

  expect(out).toContain('<span class="codicon codicon-repo"></span>');
  expect(out).toContain('</span> WS (2)]');
  store.close();
});

test('entry-reference workstream link (#NN) gets icon but suppresses count', () => {
  const store = openJournalStore({ dbPath: ':memory:' });
  store.createWorkstream({ slug: 'ws', title: 'WS' });
  store.createTopic({ slug: 't1', title: 'T1', workstream_slug: 'ws' });

  const md = `[#5](${deepLink('workstream', 'ws')})`;
  const out = enrichDeepLinks(store, md);

  expect(out).toContain('<span class="codicon codicon-repo"></span>');
  expect(out).toContain(`</span> #5](${deepLink('workstream', 'ws')})`);
  expect(out).not.toContain('(1)');
  store.close();
});

test('topic-type link gets tag icon and no count', () => {
  const store = openJournalStore({ dbPath: ':memory:' });

  const md = `[Feature](${deepLink('topic-type', 'feature')})`;
  const out = enrichDeepLinks(store, md);

  expect(out).toBe(
    `[<span class="codicon codicon-tag"></span> Feature](${deepLink('topic-type', 'feature')})`,
  );
  store.close();
});

test('links inside fenced code blocks are left untouched', () => {
  const store = openJournalStore({ dbPath: ':memory:' });
  store.createTopic({ slug: 'parent', title: 'Parent', topic_type: 'feature' });
  store.createTopic({ slug: 'kid', title: 'Kid', parent_slug: 'parent' });

  const link = `[Parent](${deepLink('topic', 'parent')})`;
  const md = ['```', link, '```'].join('\n');
  const out = enrichDeepLinks(store, md);

  expect(out).toBe(md);
  expect(out).not.toContain('codicon');
  store.close();
});

test('unknown / soft-deleted topic falls back to symbol-misc icon', () => {
  const store = openJournalStore({ dbPath: ':memory:' });

  const md = `[Ghost](${deepLink('topic', 'does-not-exist')})`;
  const out = enrichDeepLinks(store, md);

  expect(out).toContain('<span class="codicon codicon-symbol-misc"></span>');
  store.close();
});
