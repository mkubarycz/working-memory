export type ActiveSectionBoundary = 'progress';

export interface ActiveSectionHeights {
  queue: number;
  progress: number;
}

export const ACTIVE_SECTION_MIN_HEIGHTS: ActiveSectionHeights = {
  queue: 76,
  progress: 120,
};

export function resizeActiveSections(
  boundary: ActiveSectionBoundary,
  pointerDelta: number,
  initial: ActiveSectionHeights,
): ActiveSectionHeights {
  const before = 'queue';
  const after = boundary;
  const minimumDelta = ACTIVE_SECTION_MIN_HEIGHTS[before] - initial[before];
  const maximumDelta = initial[after] - ACTIVE_SECTION_MIN_HEIGHTS[after];
  const delta = Math.min(Math.max(pointerDelta, minimumDelta), maximumDelta);

  return {
    ...initial,
    [before]: initial[before] + delta,
    [after]: initial[after] - delta,
  };
}