import { test, expect } from 'vitest';
import { openJournalStore } from '../src/db';
import {
  renderSessionDoc,
  renderWorkstreamDoc,
  renderTopicDoc,
} from '../src/renderer';

// Fixed timestamps (Unix seconds) with clear ordering:
// t1 = oldest, t2 = middle, t3 = newest
const t1 = 1_700_000_000; // 2023-11-14 ...
const t2 = 1_700_001_000; // t1 + 1000 s
const t3 = 1_700_002_000; // t1 + 2000 s (newest)

/** Extract every blockquote entry line (`> \`...\``) from a rendered doc. */
function extractEntryLines(rendered: string): string[] {
  return rendered
    .split('\n')
    .filter((line) => /^> `\d{4}-\d{2}-\d{2} \d{2}:\d{2}`/.test(line));
}

test('session doc: 3 entries render newest-first', () => {
  const store = openJournalStore({ dbPath: ':memory:' });

  store.createWorkstream({ slug: 'ws', title: 'WS', status: 'open' });
  const session = store.startSession({ workstream_slug: 'ws' });

  store.appendEntry({
    session_id: session.session_id,
    body: 'chat: oldest',
    timestamp: t1,
    created_by: 'orchestrator',
  });
  store.appendEntry({
    session_id: session.session_id,
    body: 'chat: middle',
    timestamp: t2,
    created_by: 'orchestrator',
  });
  store.appendEntry({
    session_id: session.session_id,
    body: 'chat: newest',
    timestamp: t3,
    created_by: 'orchestrator',
  });

  const rendered = renderSessionDoc(store, session.session_id);

  // Extract entry lines in document order
  const lines = extractEntryLines(rendered);
  expect(lines).toHaveLength(3);

  // Newest entry must appear first
  expect(lines[0]).toContain('chat: newest');
  expect(lines[1]).toContain('chat: middle');
  expect(lines[2]).toContain('chat: oldest');

  store.close();
});

test('workstream doc: multi-entry session renders entries newest-first', () => {
  const store = openJournalStore({ dbPath: ':memory:' });

  store.createWorkstream({ slug: 'ws2', title: 'WS2', status: 'open' });
  const session = store.startSession({ workstream_slug: 'ws2' });

  store.appendEntry({
    session_id: session.session_id,
    body: 'fact: first',
    timestamp: t1,
    created_by: 'orchestrator',
  });
  store.appendEntry({
    session_id: session.session_id,
    body: 'fact: second',
    timestamp: t2,
    created_by: 'orchestrator',
  });
  store.appendEntry({
    session_id: session.session_id,
    body: 'fact: third',
    timestamp: t3,
    created_by: 'orchestrator',
  });

  const rendered = renderWorkstreamDoc(store, 'ws2');

  const lines = extractEntryLines(rendered);
  expect(lines).toHaveLength(3);

  expect(lines[0]).toContain('fact: third');
  expect(lines[1]).toContain('fact: second');
  expect(lines[2]).toContain('fact: first');

  store.close();
});

test('topic doc: linked entries render newest-first', () => {
  const store = openJournalStore({ dbPath: ':memory:' });

  store.createWorkstream({ slug: 'ws3', title: 'WS3', status: 'open' });
  store.createTopic({ slug: 'my-topic', title: 'My Topic', topic_type: 'feature' });
  store.linkWorkstreamTopic({ workstream_slug: 'ws3', topic_slug: 'my-topic' });

  const session = store.startSession({ workstream_slug: 'ws3' });

  const eOld = store.appendEntry({
    session_id: session.session_id,
    body: 'decision: old entry',
    timestamp: t1,
    created_by: 'orchestrator',
  });
  const eMid = store.appendEntry({
    session_id: session.session_id,
    body: 'decision: mid entry',
    timestamp: t2,
    created_by: 'orchestrator',
  });
  const eNew = store.appendEntry({
    session_id: session.session_id,
    body: 'decision: new entry',
    timestamp: t3,
    created_by: 'orchestrator',
  });

  store.linkEntryTopic({ entry_id: eOld.id, topic_slug: 'my-topic' });
  store.linkEntryTopic({ entry_id: eMid.id, topic_slug: 'my-topic' });
  store.linkEntryTopic({ entry_id: eNew.id, topic_slug: 'my-topic' });

  const rendered = renderTopicDoc(store, 'my-topic');

  const lines = extractEntryLines(rendered);
  expect(lines).toHaveLength(3);

  expect(lines[0]).toContain('decision: new entry');
  expect(lines[1]).toContain('decision: mid entry');
  expect(lines[2]).toContain('decision: old entry');

  store.close();
});

test('every rendered entry line begins with blockquote marker `> `', () => {
  const store = openJournalStore({ dbPath: ':memory:' });

  store.createWorkstream({ slug: 'ws4', title: 'WS4', status: 'open' });
  const session = store.startSession({ workstream_slug: 'ws4' });

  store.appendEntry({
    session_id: session.session_id,
    body: 'chat: alpha',
    timestamp: t1,
    created_by: 'orchestrator',
  });
  store.appendEntry({
    session_id: session.session_id,
    body: 'chat: beta',
    timestamp: t2,
    created_by: 'orchestrator',
  });

  const sessionRendered = renderSessionDoc(store, session.session_id);
  const wsRendered = renderWorkstreamDoc(store, 'ws4');

  // All entry lines from session doc start with `> `
  const sessionLines = sessionRendered
    .split('\n')
    .filter((l) => l.includes('chat:'));
  expect(sessionLines.length).toBeGreaterThan(0);
  for (const line of sessionLines) {
    expect(line).toMatch(/^> /);
  }

  // All entry lines from workstream doc start with `> `
  const wsLines = wsRendered.split('\n').filter((l) => l.includes('chat:'));
  expect(wsLines.length).toBeGreaterThan(0);
  for (const line of wsLines) {
    expect(line).toMatch(/^> /);
  }

  store.close();
});

test('entry timestamps use YYYY-MM-DD HH:MM format (full datetime)', () => {
  const store = openJournalStore({ dbPath: ':memory:' });

  store.createWorkstream({ slug: 'ws5', title: 'WS5', status: 'open' });
  const session = store.startSession({ workstream_slug: 'ws5' });

  store.appendEntry({
    session_id: session.session_id,
    body: 'fact: timestamp check',
    timestamp: t1,
    created_by: 'orchestrator',
  });

  const rendered = renderSessionDoc(store, session.session_id);

  // Each rendered entry line must match: > `YYYY-MM-DD HH:MM`
  const entryLines = extractEntryLines(rendered);
  expect(entryLines.length).toBeGreaterThan(0);
  for (const line of entryLines) {
    expect(line).toMatch(/^> `\d{4}-\d{2}-\d{2} \d{2}:\d{2}`/);
  }

  store.close();
});
