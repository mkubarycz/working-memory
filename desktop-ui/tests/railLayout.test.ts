import { describe, expect, it } from 'vitest';
import {
  RAIL_LAYOUT,
  parseStoredRailWidth,
  resizeRail,
  resolveRailWidths,
} from '../src/renderer/railLayout';

describe('desktop rail layout', () => {
  it('validates and clamps persisted widths', () => {
    expect(parseStoredRailWidth(null, 'active')).toBe(RAIL_LAYOUT.active.default);
    expect(parseStoredRailWidth('not-a-number', 'chat')).toBe(RAIL_LAYOUT.chat.default);
    expect(parseStoredRailWidth('10', 'active')).toBe(RAIL_LAYOUT.active.min);
    expect(parseStoredRailWidth('900', 'chat')).toBe(RAIL_LAYOUT.chat.max);
  });

  it('uses preferred widths when the normal viewport has room', () => {
    expect(resolveRailWidths(
      { active: 300, chat: 400 },
      1280,
      { active: false, chat: false },
    )).toEqual({ active: 300, chat: 400 });
  });

  it('shrinks expanded rails enough to preserve the center at 900px', () => {
    const widths = resolveRailWidths(
      { active: 280, chat: 360 },
      900,
      { active: false, chat: false },
    );

    expect(widths).toEqual({ active: 280, chat: 288 });
    expect(widths.active + widths.chat + (RAIL_LAYOUT.splitter * 2) + RAIL_LAYOUT.centerMin).toBe(900);
  });

  it('accounts for collapsed rails as exactly 36px', () => {
    expect(resolveRailWidths(
      { active: 420, chat: 520 },
      900,
      { active: true, chat: false },
    )).toEqual({ active: 36, chat: 520 });
    expect(resolveRailWidths(
      { active: 420, chat: 520 },
      900,
      { active: false, chat: true },
    )).toEqual({ active: 420, chat: 36 });
    expect(resolveRailWidths(
      { active: 420, chat: 520 },
      900,
      { active: true, chat: true },
    )).toEqual({ active: 36, chat: 36 });
  });

  it('resizes left and right rails in their natural pointer directions', () => {
    const preferred = { active: 280, chat: 360 };
    const expanded = { active: false, chat: false };

    expect(resizeRail('active', 40, preferred, 1280, expanded)).toBe(320);
    expect(resizeRail('active', -100, preferred, 1280, expanded)).toBe(RAIL_LAYOUT.active.min);
    expect(resizeRail('chat', -40, preferred, 1280, expanded)).toBe(400);
    expect(resizeRail('chat', 100, preferred, 1280, expanded)).toBe(RAIL_LAYOUT.chat.min);
  });

  it('clamps dragging against the minimum center width', () => {
    expect(resizeRail(
      'active',
      200,
      { active: 280, chat: 360 },
      900,
      { active: false, chat: false },
    )).toBe(280);
  });
});