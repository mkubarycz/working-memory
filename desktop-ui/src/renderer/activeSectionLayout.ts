export type ActiveSectionBoundary = 'progress' | 'backlog';

export interface ActiveSectionHeights {
  queue: number;
  progress: number;
  backlog: number;
}

export const ACTIVE_SECTION_MIN_HEIGHTS: ActiveSectionHeights = {
  queue: 76,
  progress: 120,
  backlog: 76,
};

export function resizeActiveSections(
  boundary: ActiveSectionBoundary,
  pointerDelta: number,
  initial: ActiveSectionHeights,
): ActiveSectionHeights {
  const before = boundary === 'progress' ? 'queue' : 'progress';
  const after = boundary === 'progress' ? 'progress' : 'backlog';
  const minimumDelta = ACTIVE_SECTION_MIN_HEIGHTS[before] - initial[before];
  const maximumDelta = initial[after] - ACTIVE_SECTION_MIN_HEIGHTS[after];
  const delta = Math.min(Math.max(pointerDelta, minimumDelta), maximumDelta);

  return {
    ...initial,
    [before]: initial[before] + delta,
    [after]: initial[after] - delta,
  };
}