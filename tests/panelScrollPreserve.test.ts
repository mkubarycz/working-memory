import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test } from 'vitest';

// Regression guard for the "Active workstreams scroll resets to top" bug.
// The panel webview rebuilds its list DOM (`listEl.replaceChildren()`) on every
// data/auto refresh, which recreates the Active "In Progress" scroll region
// (`.active-sections > .ws-section-cards`). Without preserving the scroll
// position, an overflowing Active stage snapped back to the top mid-scroll.
// These assertions lock the capture-before / restore-after contract in
// `render()` so a future refactor can't silently drop it.

const panelJsPath = join(process.cwd(), 'media', 'panel', 'panel.js');

function panelJs(): string {
  return readFileSync(panelJsPath, 'utf8');
}

test('scroll container resolves the Active In Progress region, else the list', () => {
  const js = panelJs();
  // The scrollable element for the Active tab is the internally-scrolling
  // In Progress region; every other tab scrolls the list element itself.
  expect(js).toMatch(
    /function getScrollContainer\(\)\s*\{[\s\S]*state\.activeTab === 'active'[\s\S]*\.active-sections > \.ws-section-cards[\s\S]*return listEl;/,
  );
});

test('render captures scroll before rebuild, only for a same-tab refresh', () => {
  const js = panelJs();
  // Same-tab guard: a tab switch intentionally starts at the top (0), while a
  // refresh of the SAME tab captures the current scrollTop to restore later.
  expect(js).toMatch(/const sameTab = lastRenderedTab === state\.activeTab;/);
  expect(js).toMatch(
    /const prevScrollTop = sameTab\s*\?\s*\(getScrollContainer\(\)\?\.scrollTop \?\? 0\)\s*:\s*0;/,
  );

  // Capture must happen BEFORE the DOM is torn down by replaceChildren.
  const captureIdx = js.indexOf('const prevScrollTop = sameTab');
  const replaceIdx = js.indexOf('listEl.replaceChildren()');
  expect(captureIdx).toBeGreaterThan(-1);
  expect(replaceIdx).toBeGreaterThan(captureIdx);
});

test('render restores the captured scroll on the rebuilt container', () => {
  const js = panelJs();
  expect(js).toMatch(
    /if \(prevScrollTop > 0\)\s*\{\s*const nextScrollEl = getScrollContainer\(\);\s*if \(nextScrollEl\)\s*\{\s*nextScrollEl\.scrollTop = prevScrollTop;/,
  );

  // Restore must happen AFTER the new DOM is appended.
  const appendIdx = js.lastIndexOf('listEl.appendChild(frag)');
  const restoreIdx = js.indexOf('nextScrollEl.scrollTop = prevScrollTop');
  expect(appendIdx).toBeGreaterThan(-1);
  expect(restoreIdx).toBeGreaterThan(appendIdx);
});
