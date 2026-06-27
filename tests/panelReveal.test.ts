import { test, expect } from 'vitest';
import {
  parsePanelRevealTarget,
  isMarkdownPreviewViewType,
  resolveRevealFromTabs,
  basenameFromPath,
  previewSourceBasename,
  slugFromLabel,
  type TabDescriptor,
} from '../src/panelReveal';

test('parses a topic doc URI', () => {
  expect(parsePanelRevealTarget('working-memory:/topic/reveal-active-in-panel.md')).toEqual({
    kind: 'topic',
    id: 'reveal-active-in-panel',
  });
});

test('parses a session doc URI (uuid id)', () => {
  const uuid = '6ab6a0b9-4f7b-4600-ae1b-45c7ee42fc4a';
  expect(parsePanelRevealTarget(`working-memory:/session/${uuid}.md`)).toEqual({
    kind: 'session',
    id: uuid,
  });
});

test('parses a workstream doc URI', () => {
  expect(parsePanelRevealTarget('working-memory:/workstream/memory-system.md')).toEqual({
    kind: 'workstream',
    id: 'memory-system',
  });
});

test('reveals an active WM topic-type text tab directly', () => {
  const topicTypeDoc = wmTextTab('/topic-type/test-1.md');
  expect(resolveRevealFromTabs([topicTypeDoc], topicTypeDoc)).toEqual({
    kind: 'topic-type',
    id: 'test-1',
  });
});

test('decodes percent-encoded ids', () => {
  expect(parsePanelRevealTarget('working-memory:/topic/a%2Fb.md')).toEqual({
    kind: 'topic',
    id: 'a/b',
  });
});

test('parses a topic-type doc URI', () => {
  expect(parsePanelRevealTarget('working-memory:/topic-type/test-1.md')).toEqual({
    kind: 'topic-type',
    id: 'test-1',
  });
});

test('parses a topic-type doc URI (feature)', () => {
  expect(parsePanelRevealTarget('working-memory:/topic-type/feature.md')).toEqual({
    kind: 'topic-type',
    id: 'feature',
  });
});

test('returns null for non-WM and malformed URIs', () => {
  expect(parsePanelRevealTarget('file:///tmp/foo.md')).toBeNull();
  expect(parsePanelRevealTarget('working-memory:/topic/.md')).toBeNull();
  expect(parsePanelRevealTarget('working-memory:/topic/foo')).toBeNull();
  expect(parsePanelRevealTarget('')).toBeNull();
});

test('isMarkdownPreviewViewType matches the built-in preview view type', () => {
  // The exact runtime value seen on TabInputWebview.viewType.
  expect(isMarkdownPreviewViewType('mainThreadWebview-markdown.preview')).toBe(true);
  // Defensive substring match survives prefix/casing changes.
  expect(isMarkdownPreviewViewType('markdown.preview')).toBe(true);
  expect(isMarkdownPreviewViewType('MainThreadWebview-Markdown.Preview')).toBe(true);
});

test('isMarkdownPreviewViewType rejects other webviews', () => {
  expect(isMarkdownPreviewViewType('mainThreadWebview-kubarycz.workingMemoryPanel')).toBe(false);
  expect(isMarkdownPreviewViewType('jupyter.notebook.ipynb')).toBe(false);
  expect(isMarkdownPreviewViewType(undefined)).toBe(false);
  expect(isMarkdownPreviewViewType('')).toBe(false);
});

test('basenameFromPath returns the last path segment', () => {
  expect(basenameFromPath('/topic/reveal-active-in-panel.md')).toBe('reveal-active-in-panel.md');
  expect(basenameFromPath('foo.md')).toBe('foo.md');
});

test('previewSourceBasename strips the "Preview " prefix', () => {
  expect(previewSourceBasename('Preview reveal-active-in-panel.md')).toBe('reveal-active-in-panel.md');
  expect(previewSourceBasename('Preview reveal-active-in-panel')).toBe('reveal-active-in-panel');
  expect(previewSourceBasename(undefined)).toBe('');
});

// --- resolveRevealFromTabs -------------------------------------------------

const topicTarget = { kind: 'topic' as const, id: 'reveal-active-in-panel' };
const wsTarget = { kind: 'workstream' as const, id: 'memory-system' };

const wmTextTab = (path: string, label?: string): TabDescriptor => ({
  kind: 'text',
  scheme: 'working-memory',
  path,
  label: label ?? path.slice(path.lastIndexOf('/') + 1),
});
const fileTextTab = (path: string): TabDescriptor => ({
  kind: 'text',
  scheme: 'file',
  path,
  label: path.slice(path.lastIndexOf('/') + 1),
});
const previewTab = (label: string): TabDescriptor => ({ kind: 'preview', label });
const otherTab = (label?: string): TabDescriptor => ({ kind: 'other', label });

test('reveals a WM text doc when it is the active tab', () => {
  const topicDoc = wmTextTab('/topic/reveal-active-in-panel.md');
  expect(resolveRevealFromTabs([topicDoc], topicDoc)).toEqual(topicTarget);
});

test('clears for a non-WM text doc active', () => {
  const fileDoc = fileTextTab('/tmp/notes.md');
  expect(resolveRevealFromTabs([fileDoc], fileDoc)).toBeNull();
});

test('preview active + single WM text tab open → reveals that source', () => {
  const topicDoc = wmTextTab('/topic/reveal-active-in-panel.md');
  const preview = previewTab('Preview reveal-active-in-panel.md');
  // Source text tab lives in another group; preview is the active tab.
  expect(resolveRevealFromTabs([topicDoc, preview], preview)).toEqual(topicTarget);
});

test('preview active + multiple WM text tabs → label disambiguates', () => {
  const topicDoc = wmTextTab('/topic/reveal-active-in-panel.md');
  const wsDoc = wmTextTab('/workstream/memory-system.md');
  const preview = previewTab('Preview memory-system.md');
  expect(resolveRevealFromTabs([topicDoc, wsDoc, preview], preview)).toEqual(wsTarget);
});

test('preview active + multiple WM tabs, label lacks .md → still disambiguates', () => {
  const topicDoc = wmTextTab('/topic/reveal-active-in-panel.md');
  const wsDoc = wmTextTab('/workstream/memory-system.md');
  const preview = previewTab('Preview reveal-active-in-panel');
  expect(resolveRevealFromTabs([topicDoc, wsDoc, preview], preview)).toEqual(topicTarget);
});

test('preview active + multiple WM tabs, no label match → null (host may fall back)', () => {
  const topicDoc = wmTextTab('/topic/reveal-active-in-panel.md');
  const wsDoc = wmTextTab('/workstream/memory-system.md');
  const preview = previewTab('Preview something-else.md');
  expect(resolveRevealFromTabs([topicDoc, wsDoc, preview], preview)).toBeNull();
});

test('preview active + no WM text tab open → null (clear)', () => {
  const fileDoc = fileTextTab('/tmp/readme.md');
  const preview = previewTab('Preview readme.md');
  expect(resolveRevealFromTabs([fileDoc, preview], preview)).toBeNull();
});

test('preview active + a WM topic-type text tab → reveals it (topic-type is revealable)', () => {
  const topicTypeDoc = wmTextTab('/topic-type/test-1.md');
  const preview = previewTab('Preview test-1.md');
  expect(resolveRevealFromTabs([topicTypeDoc, preview], preview)).toEqual({
    kind: 'topic-type',
    id: 'test-1',
  });
});

test('other/unknown active tab → null', () => {
  const topicDoc = wmTextTab('/topic/reveal-active-in-panel.md');
  expect(resolveRevealFromTabs([topicDoc], otherTab('Some Panel'))).toBeNull();
  expect(resolveRevealFromTabs([topicDoc], null)).toBeNull();
});

// --- slugFromLabel ---------------------------------------------------------

test('slugFromLabel strips a trailing .md', () => {
  expect(slugFromLabel('sandbox-setup.md')).toBe('sandbox-setup');
  expect(slugFromLabel('Reveal-Active.MD')).toBe('Reveal-Active');
});

test('slugFromLabel strips a "Preview " prefix (no extension)', () => {
  expect(slugFromLabel('Preview sandbox-setup')).toBe('sandbox-setup');
  expect(slugFromLabel('Preview sandbox-setup.md')).toBe('sandbox-setup');
});

test('slugFromLabel returns "" for empty or non-WM-looking labels', () => {
  expect(slugFromLabel(undefined)).toBe('');
  expect(slugFromLabel('')).toBe('');
  // No ".md" extension and no "Preview " prefix → not a WM doc basename.
  expect(slugFromLabel('Some Panel')).toBe('');
  expect(slugFromLabel('sandbox-setup')).toBe('');
});

// --- label-based reveal (preview / custom-editor as kind 'other') ----------

test('other tab labeled "<slug>.md" + matching WM text tab → resolves kind from source', () => {
  // Real runtime: a WM doc in Markdown Preview classifies as 'other' with a
  // bare "<slug>.md" label and no source URI. The still-open source text tab
  // hands us the kind.
  const sourceText = wmTextTab('/topic/sandbox-setup.md');
  const previewOther = otherTab('sandbox-setup.md');
  expect(resolveRevealFromTabs([sourceText, previewOther], previewOther)).toEqual({
    kind: 'topic',
    id: 'sandbox-setup',
  });
});

test('other tab labeled "<slug>.md" + NO matching WM text tab → kind-null slug target', () => {
  const previewOther = otherTab('sandbox-setup.md');
  expect(resolveRevealFromTabs([previewOther], previewOther)).toEqual({
    kind: null,
    id: 'sandbox-setup',
  });
});

test('other tab labeled "Preview <slug>" (prefixed, no .md) → slug recovered', () => {
  const previewOther = otherTab('Preview sandbox-setup');
  // No matching source text tab → kind-null fallback by the recovered slug.
  expect(resolveRevealFromTabs([previewOther], previewOther)).toEqual({
    kind: null,
    id: 'sandbox-setup',
  });
});

test('other tab with a non-WM-looking label → null (does not reveal arbitrary tabs)', () => {
  const topicDoc = wmTextTab('/topic/reveal-active-in-panel.md');
  expect(resolveRevealFromTabs([topicDoc], otherTab('Settings'))).toBeNull();
});
