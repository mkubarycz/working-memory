import { test, expect } from 'vitest';
import {
  parsePanelRevealTarget,
  parseDocumentRevealId,
  resolveRevealFromTabs,
  resolveDocumentIdFromTabs,
  WM_DOCUMENT_EDITOR_VIEW_TYPE,
  type TabDescriptor,
} from '../src/panelReveal';

// --- parsePanelRevealTarget ------------------------------------------------

test('parses a topic doc URI', () => {
  expect(
    parsePanelRevealTarget('working-memory:/topic/reveal-active-in-panel.working-memory'),
  ).toEqual({ kind: 'topic', id: 'reveal-active-in-panel' });
});

test('parses a session doc URI (uuid id)', () => {
  const uuid = '6ab6a0b9-4f7b-4600-ae1b-45c7ee42fc4a';
  expect(
    parsePanelRevealTarget(`working-memory:/session/${uuid}.working-memory`),
  ).toEqual({ kind: 'session', id: uuid });
});

test('parses a workstream doc URI', () => {
  expect(
    parsePanelRevealTarget('working-memory:/workstream/memory-system.working-memory'),
  ).toEqual({ kind: 'workstream', id: 'memory-system' });
});

test('parses a topic-type doc URI', () => {
  expect(
    parsePanelRevealTarget('working-memory:/topic-type/feature.working-memory'),
  ).toEqual({ kind: 'topic-type', id: 'feature' });
});

test('decodes percent-encoded ids', () => {
  expect(
    parsePanelRevealTarget('working-memory:/topic/a%2Fb.working-memory'),
  ).toEqual({ kind: 'topic', id: 'a/b' });
});

test('returns null for non-WM and malformed URIs', () => {
  expect(parsePanelRevealTarget('file:///tmp/foo.working-memory')).toBeNull();
  expect(parsePanelRevealTarget('working-memory:/topic/.working-memory')).toBeNull();
  expect(parsePanelRevealTarget('working-memory:/topic/foo')).toBeNull();
  // Legacy markdown URIs are no longer revealable.
  expect(parsePanelRevealTarget('working-memory:/topic/foo.md')).toBeNull();
  expect(parsePanelRevealTarget('')).toBeNull();
});

// --- resolveRevealFromTabs -------------------------------------------------

const customTab = (path: string): TabDescriptor => ({
  kind: 'custom',
  scheme: 'working-memory',
  path,
  viewType: WM_DOCUMENT_EDITOR_VIEW_TYPE,
});
const otherTab = (): TabDescriptor => ({ kind: 'other' });

test('reveals an active WM custom-editor tab for each revealable kind', () => {
  expect(resolveRevealFromTabs(customTab('/topic/reveal-active-in-panel.working-memory'))).toEqual({
    kind: 'topic',
    id: 'reveal-active-in-panel',
  });
  expect(resolveRevealFromTabs(customTab('/workstream/memory-system.working-memory'))).toEqual({
    kind: 'workstream',
    id: 'memory-system',
  });
  expect(resolveRevealFromTabs(customTab('/session/6ab6a0b9.working-memory'))).toEqual({
    kind: 'session',
    id: '6ab6a0b9',
  });
  expect(resolveRevealFromTabs(customTab('/topic-type/feature.working-memory'))).toEqual({
    kind: 'topic-type',
    id: 'feature',
  });
});

test('clears for a custom-editor tab with a foreign viewType', () => {
  expect(
    resolveRevealFromTabs({
      kind: 'custom',
      scheme: 'working-memory',
      path: '/topic/reveal-active-in-panel.working-memory',
      viewType: 'some.other.editor',
    }),
  ).toBeNull();
});

test('clears for a custom-editor tab with a non-WM scheme', () => {
  expect(
    resolveRevealFromTabs({
      kind: 'custom',
      scheme: 'file',
      path: '/tmp/notes.working-memory',
      viewType: WM_DOCUMENT_EDITOR_VIEW_TYPE,
    }),
  ).toBeNull();
});

test('clears for a non-revealable custom-editor kind (e.g. document/alert)', () => {
  expect(resolveRevealFromTabs(customTab('/document/abc.working-memory'))).toBeNull();
  expect(resolveRevealFromTabs(customTab('/alert/abc.working-memory'))).toBeNull();
});

test('other/unknown active tab or none → null', () => {
  expect(resolveRevealFromTabs(otherTab())).toBeNull();
  expect(resolveRevealFromTabs(null)).toBeNull();
});

// --- parseDocumentRevealId / resolveDocumentIdFromTabs ---------------------

test('parses the generic by-id document route into an id', () => {
  const id = '6ab6a0b9-4f7b-4600-ae1b-45c7ee42fc4a';
  expect(parseDocumentRevealId(`working-memory:/document/${id}.working-memory`)).toBe(id);
});

test('decodes percent-encoded document ids', () => {
  expect(parseDocumentRevealId('working-memory:/document/a%2Fb.working-memory')).toBe('a/b');
});

test('document-id parser returns null for non-document routes and junk', () => {
  expect(parseDocumentRevealId('working-memory:/topic/foo.working-memory')).toBeNull();
  expect(parseDocumentRevealId('working-memory:/document/.working-memory')).toBeNull();
  expect(parseDocumentRevealId('file:///tmp/document/abc.working-memory')).toBeNull();
  expect(parseDocumentRevealId('')).toBeNull();
});

test('resolves the active WM document tab to its id (nanite/agent scope)', () => {
  const id = '6ab6a0b9-4f7b-4600-ae1b-45c7ee42fc4a';
  expect(resolveDocumentIdFromTabs(customTab(`/document/${id}.working-memory`))).toBe(id);
});

test('document-id tab resolver ignores kinded, foreign, and non-WM tabs', () => {
  expect(resolveDocumentIdFromTabs(customTab('/topic/foo.working-memory'))).toBeNull();
  expect(
    resolveDocumentIdFromTabs({
      kind: 'custom',
      scheme: 'working-memory',
      path: '/document/abc.working-memory',
      viewType: 'some.other.editor',
    }),
  ).toBeNull();
  expect(
    resolveDocumentIdFromTabs({
      kind: 'custom',
      scheme: 'file',
      path: '/tmp/document/abc.working-memory',
      viewType: WM_DOCUMENT_EDITOR_VIEW_TYPE,
    }),
  ).toBeNull();
  expect(resolveDocumentIdFromTabs(otherTab())).toBeNull();
  expect(resolveDocumentIdFromTabs(null)).toBeNull();
});
