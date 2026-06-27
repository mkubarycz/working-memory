import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test } from 'vitest';

const panelCssPath = join(process.cwd(), 'media', 'panel', 'panel.css');

test('hides list scrollbar and keeps active cards coast-to-coast', () => {
  const css = readFileSync(panelCssPath, 'utf8');

  expect(css).toMatch(/\.list\s*\{[\s\S]*scrollbar-width:\s*none;/);
  expect(css).toMatch(/\.list::-webkit-scrollbar\s*\{[\s\S]*width:\s*0;[\s\S]*height:\s*0;/);
  expect(css).toMatch(/\.list\.cards\s*\{[\s\S]*padding:\s*6px 0 0;/);
  expect(css).toMatch(/\.ws-card\s*\{[\s\S]*border-left:\s*none;[\s\S]*border-right:\s*none;/);

  // Active tab is a full-height flex column with Backlog pinned to the bottom:
  // the list stops scrolling in cards mode and the In Progress region scrolls.
  expect(css).toMatch(/\.list\.cards\s*\{[\s\S]*display:\s*flex;[\s\S]*flex-direction:\s*column;[\s\S]*overflow:\s*hidden;/);
  expect(css).toMatch(/\.active-sections\s*\{[\s\S]*flex:\s*1 1 auto;[\s\S]*flex-direction:\s*column;/);
  expect(css).toMatch(/\.active-sections\s*>\s*\.ws-shelf\s*\{[\s\S]*flex:\s*0 0 auto;/);
  expect(css).toMatch(/\.active-sections\s*>\s*\.ws-section-cards\s*\{[\s\S]*flex:\s*1 1 auto;[\s\S]*overflow-y:\s*auto;/);
});
