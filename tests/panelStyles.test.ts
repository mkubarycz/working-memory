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

test('collapsed peek deck stacks two real rows with slivers fanning below', () => {
  const css = readFileSync(panelCssPath, 'utf8');

  // The two newest rows render in normal flow (flex column, 3px gap like the
  // expanded list) so both are real, clickable shelf rows.
  expect(css).toMatch(/\.ws-shelf-fan\s*\{[\s\S]*display:\s*flex;[\s\S]*flex-direction:\s*column;[\s\S]*gap:\s*3px;/);
  // ws-layers-N reserves room below the bottom row for the peeking slivers.
  expect(css).toMatch(/\.ws-shelf-fan\.ws-layers-1\s*\{[\s\S]*padding-bottom:\s*7px;/);
  expect(css).toMatch(/\.ws-shelf-fan\.ws-layers-2\s*\{[\s\S]*padding-bottom:\s*14px;/);
  // Real rows sit above the decorative slivers.
  expect(css).toMatch(/\.ws-shelf-fan\s*\.ws-shelf-deck-row\s*\{[\s\S]*z-index:\s*3;/);
  // Slivers peek downward from under the lower (47px) row.
  expect(css).toMatch(/\.ws-shelf-deck-down\s*\.ws-shelf-layer-1\s*\{[\s\S]*top:\s*32px;/);
  expect(css).toMatch(/\.ws-shelf-deck-down\s*\.ws-shelf-layer-2\s*\{[\s\S]*top:\s*39px;/);
});

test('shelf-item move-to button is an 18x18 box whose enlarged glyph is the visible circle', () => {
  const css = readFileSync(panelCssPath, 'utf8');

  // 18×18 footprint (matching the .recent-chip bubble) but the visible circle
  // is the codicon glyph's own ring — no translucent rest background.
  expect(css).toMatch(/\.ws-shelf-move\s*\{[\s\S]*width:\s*18px;[\s\S]*height:\s*18px;/);
  expect(css).toMatch(/\.ws-shelf-move\s*\{[\s\S]*border-radius:\s*999px;/);
  expect(css).toMatch(/\.ws-shelf-move\s*\{[\s\S]*background:\s*transparent;/);
  // Blue glyph color (charts-blue with button-background fallback).
  expect(css).toMatch(/\.ws-shelf-move\s*\{[\s\S]*color:\s*var\(--vscode-charts-blue,\s*var\(--vscode-button-background\)\)/);
  // Glyph enlarged to nearly fill the box so the arrow reads bigger.
  expect(css).toMatch(/\.ws-shelf-move \.codicon\s*\{[\s\S]*font-size:\s*17px;/);
  // Inverted hover: the circle fills with solid blue and the glyph flips to
  // near-black, so the arrow reads black on a solid blue button.
  expect(css).toMatch(
    /\.ws-shelf-move:hover\s*\{[\s\S]*background:\s*var\(--vscode-charts-blue,\s*var\(--vscode-button-background\)\)/,
  );
  expect(css).toMatch(/\.ws-shelf-move:hover\s*\{[\s\S]*color:\s*#0a0a0a;/);
  // Old brightness-only hover is gone.
  expect(css).not.toMatch(/\.ws-shelf-move:hover\s*\{[\s\S]*filter:\s*brightness\(1\.25\);/);
  // Hover runs the one-shot directional wipe (shared ws-move-wipe keyframe).
  expect(css).toMatch(
    /\.ws-shelf-move:hover::after\s*\{[\s\S]*animation:\s*ws-move-wipe 0\.5s ease-out 1;/,
  );
  // The wipe is held in its final off-canvas/invisible state so nothing snaps
  // back to center after the animation ends.
  expect(css).toMatch(
    /\.ws-shelf-move:hover::after\s*\{[\s\S]*animation-fill-mode:\s*forwards;/,
  );
  // The band sweeps fully off the right edge and fades out — guaranteeing no
  // lingering centered flash.
  expect(css).toMatch(
    /@keyframes ws-move-wipe\s*\{[\s\S]*to\s*\{[\s\S]*transform:\s*translateX\(110%\);[\s\S]*opacity:\s*0;/,
  );
  // The old centered-band keyframe name is gone everywhere.
  expect(css).not.toMatch(/ws-shelf-move-shine/);
  // Hover wipe is guarded for reduced-motion users (no moving band at all).
  expect(css).toMatch(/@media \(prefers-reduced-motion: reduce\)\s*\{[\s\S]*\.ws-shelf-move:hover::after\s*\{[\s\S]*animation:\s*none;[\s\S]*opacity:\s*0;/);
});

test('empty-shelf notice fills the content column and centers on both axes', () => {
  const css = readFileSync(panelCssPath, 'utf8');

  // The notice grows to fill the content column (right of the rail) and
  // centers its text horizontally and vertically.
  expect(css).toMatch(/\.ws-shelf-empty\s*\{[\s\S]*flex:\s*1 1 auto;/);
  expect(css).toMatch(/\.ws-shelf-empty\s*\{[\s\S]*display:\s*flex;/);
  expect(css).toMatch(/\.ws-shelf-empty\s*\{[\s\S]*align-items:\s*center;/);
  expect(css).toMatch(/\.ws-shelf-empty\s*\{[\s\S]*justify-content:\s*center;/);
  expect(css).toMatch(/\.ws-shelf-empty\s*\{[\s\S]*text-align:\s*center;/);
});

test('shelf-item move-to button leads the row with a right gap before the label', () => {
  const css = readFileSync(panelCssPath, 'utf8');

  // Leading placement: a right gap before the label, and no trailing
  // auto/left margin that would push it to the right edge.
  expect(css).toMatch(/\.ws-shelf-move\s*\{[\s\S]*margin-right:\s*6px;/);
  expect(css).not.toMatch(/\.ws-shelf-move\s*\{[\s\S]*margin-left:\s*auto;/);
  // The label still flexes so the recent-chip stays pinned right.
  expect(css).toMatch(/\.ws-shelf-item \.label\s*\{[\s\S]*flex:\s*1 1 auto;/);
});

test('context-menu move-direction icon is blue and scoped away from the submenu chevron', () => {
  const css = readFileSync(panelCssPath, 'utf8');

  // Leading icon class carries the same charts-blue tint as the shelf move btn.
  expect(css).toMatch(
    /\.context-menu-item \.context-menu-icon\s*\{[\s\S]*color:\s*var\(--vscode-charts-blue,\s*var\(--vscode-button-background\)\)/,
  );
  // The blue tint is scoped to the dedicated leading-icon class, NOT a blanket
  // `.context-menu-item .codicon` rule that would also recolor the chevron.
  expect(css).not.toMatch(/\.context-menu-item \.codicon\s*\{[\s\S]*var\(--vscode-charts-blue/);
  // The label fills the row so the chevron indicator stays right-aligned.
  expect(css).toMatch(/\.context-menu-label\s*\{[\s\S]*margin-right:\s*auto;/);
});

test('context-menu shine sweep is confined to the leading icon, reusing the shelf keyframe', () => {
  const css = readFileSync(panelCssPath, 'utf8');

  // The leading icon is a fixed circular box (the positioning + clipping
  // context for the sweep), mirroring the shelf move button's circle.
  expect(css).toMatch(
    /\.context-menu-item \.context-menu-icon\s*\{[^}]*border-radius:\s*999px;/,
  );
  expect(css).toMatch(
    /\.context-menu-item \.context-menu-icon\s*\{[^}]*position:\s*relative;/,
  );

  // ROW hover inverts the ICON exactly like .ws-shelf-move:hover — solid blue
  // fill, near-black glyph, overflow only on hover so the rest glyph isn't cropped.
  expect(css).toMatch(
    /\.context-menu-item:hover:not\(:disabled\) \.context-menu-icon\s*\{[\s\S]*background:\s*var\(--vscode-charts-blue,\s*var\(--vscode-button-background\)\);[\s\S]*color:\s*#0a0a0a;[\s\S]*overflow:\s*hidden;/,
  );

  // Icon ::after overlay carries the bright near-white leading-edge band that
  // leads the wipe, hidden until hover.
  expect(css).toMatch(
    /\.context-menu-item \.context-menu-icon::after\s*\{[\s\S]*linear-gradient\(\s*115deg,[\s\S]*rgba\(255,\s*255,\s*255,\s*0\.85\)[\s\S]*\}/,
  );
  expect(css).toMatch(/\.context-menu-item \.context-menu-icon::after\s*\{[\s\S]*opacity:\s*0;/);

  // Row hover runs the one-shot wipe across the icon, reusing the shared
  // ws-move-wipe keyframe (not a duplicate), held by fill-mode:forwards.
  expect(css).toMatch(
    /\.context-menu-item:hover:not\(:disabled\) \.context-menu-icon::after\s*\{[\s\S]*opacity:\s*1;[\s\S]*animation:\s*ws-move-wipe 0\.5s ease-out 1;[\s\S]*animation-fill-mode:\s*forwards;/,
  );
  // The wipe keyframe is defined exactly once (shared between shelf + context menu).
  expect((css.match(/@keyframes ws-move-wipe/g) || []).length).toBe(1);
  // Reduced-motion guard disables the icon wipe animation (no moving band).
  expect(css).toMatch(
    /@media \(prefers-reduced-motion: reduce\)\s*\{[\s\S]*\.context-menu-item:hover:not\(:disabled\) \.context-menu-icon::after\s*\{[\s\S]*animation:\s*none;[\s\S]*opacity:\s*0;/,
  );
  // The glyph sits above the sweep so the white gradient never washes it out.
  expect(css).toMatch(
    /\.context-menu-item \.context-menu-icon \.codicon\s*\{[\s\S]*z-index:\s*1;/,
  );

  // The shine must NOT span the whole row: no row-level ::after sweep, and the
  // row keeps no overflow:hidden / position:relative left over from that.
  expect(css).not.toMatch(/\.context-menu-item::after\s*\{/);
  expect(css).not.toMatch(/\.context-menu-item\s*\{[^}]*overflow:\s*hidden;/);

  // The shine is scoped to the leading icon, never to the chevron indicator.
  expect(css).not.toMatch(
    /\.context-submenu-indicator:hover|\.context-menu-item:hover:not\(:disabled\) \.context-submenu-indicator/,
  );
});

test('context-menu row text brightens on hover', () => {
  const css = readFileSync(panelCssPath, 'utf8');

  // Hovered row uses the brighter list hover foreground (falls back to the
  // base foreground), reading brighter than the rest --vscode-menu-foreground.
  expect(css).toMatch(
    /\.context-menu-item:hover:not\(:disabled\)\s*\{[\s\S]*color:\s*var\(--vscode-list-hoverForeground,\s*var\(--vscode-foreground\)\)/,
  );
});

const panelJsPath = join(process.cwd(), 'media', 'panel', 'panel.js');

test('ellipsis and right-click menus surface the same per-action icon', () => {
  const js = readFileSync(panelJsPath, 'utf8');

  // Right-click path: workstreamActionsMenu maps each node.action to a menu
  // item carrying its leading `icon` (the arrow-circle move glyph).
  const rightClick = js.match(
    /function workstreamActionsMenu\([\s\S]*?\n  \}/,
  )?.[0];
  expect(rightClick, 'workstreamActionsMenu body not found').toBeTruthy();
  expect(rightClick).toMatch(/icon:\s*a\.icon/);

  // Ellipsis ("More actions") path: rowContextMenu's updateItems map MUST carry
  // the same `icon` so the two menus render identically for a workstream. This
  // is the regression that dropped the move arrow + hover shine from the
  // ellipsis menu — guard it at the source.
  const updateItems = js.match(
    /const updateItems = node\.actions\.map\([\s\S]*?\}\)\);/,
  )?.[0];
  expect(updateItems, 'rowContextMenu updateItems map not found').toBeTruthy();
  expect(updateItems).toMatch(/icon:\s*action\.icon/);
});

