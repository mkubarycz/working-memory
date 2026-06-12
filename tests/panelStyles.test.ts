import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test } from 'vitest';

const panelCssPath = join(process.cwd(), 'media', 'panel', 'panel.css');

test('hides list scrollbar and keeps active cards coast-to-coast', () => {
  const css = readFileSync(panelCssPath, 'utf8');

  expect(css).toMatch(/\.list\s*\{[\s\S]*scrollbar-width:\s*none;/);
  expect(css).toMatch(/\.list::-webkit-scrollbar\s*\{[\s\S]*width:\s*0;[\s\S]*height:\s*0;/);
  expect(css).toMatch(/\.list\.cards\s*\{[\s\S]*padding:\s*6px 0 12px;/);
  expect(css).toMatch(/\.ws-card\s*\{[\s\S]*border-left:\s*none;[\s\S]*border-right:\s*none;/);
});
