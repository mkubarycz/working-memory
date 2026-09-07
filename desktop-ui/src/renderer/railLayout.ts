export type RailSide = 'active' | 'chat';

export interface RailWidths {
  active: number;
  chat: number;
}

export interface RailCollapseState {
  active: boolean;
  chat: boolean;
}

export const RAIL_LAYOUT = {
  active: { default: 280, min: 220, max: 420 },
  chat: { default: 360, min: 280, max: 520 },
  collapsed: 36,
  centerMin: 320,
  splitter: 6,
} as const;

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

export function parseStoredRailWidth(value: string | null, side: RailSide): number {
  const parsed = value === null ? Number.NaN : Number(value);
  const limits = RAIL_LAYOUT[side];
  return Number.isFinite(parsed)
    ? clamp(parsed, limits.min, limits.max)
    : limits.default;
}

export function resolveRailWidths(
  preferred: RailWidths,
  viewportWidth: number,
  collapsed: RailCollapseState,
): RailWidths {
  let active = collapsed.active
    ? RAIL_LAYOUT.collapsed
    : clamp(preferred.active, RAIL_LAYOUT.active.min, RAIL_LAYOUT.active.max);
  let chat = collapsed.chat
    ? RAIL_LAYOUT.collapsed
    : clamp(preferred.chat, RAIL_LAYOUT.chat.min, RAIL_LAYOUT.chat.max);
  const splitterWidth = Number(!collapsed.active) * RAIL_LAYOUT.splitter
    + Number(!collapsed.chat) * RAIL_LAYOUT.splitter;
  let overflow = Math.max(0, active + chat + splitterWidth + RAIL_LAYOUT.centerMin - viewportWidth);

  if (!collapsed.chat && overflow > 0) {
    const reduction = Math.min(overflow, chat - RAIL_LAYOUT.chat.min);
    chat -= reduction;
    overflow -= reduction;
  }
  if (!collapsed.active && overflow > 0) {
    active -= Math.min(overflow, active - RAIL_LAYOUT.active.min);
  }

  return { active, chat };
}

export function resizeRail(
  side: RailSide,
  pointerDelta: number,
  preferred: RailWidths,
  viewportWidth: number,
  collapsed: RailCollapseState,
): number {
  const current = resolveRailWidths(preferred, viewportWidth, collapsed);
  const otherSide = side === 'active' ? 'chat' : 'active';
  const otherWidth = current[otherSide];
  const splitterWidth = Number(!collapsed.active) * RAIL_LAYOUT.splitter
    + Number(!collapsed.chat) * RAIL_LAYOUT.splitter;
  const viewportMaximum = viewportWidth - RAIL_LAYOUT.centerMin - splitterWidth - otherWidth;
  const limits = RAIL_LAYOUT[side];
  const directionalDelta = side === 'active' ? pointerDelta : -pointerDelta;

  return clamp(current[side] + directionalDelta, limits.min, Math.min(limits.max, viewportMaximum));
}