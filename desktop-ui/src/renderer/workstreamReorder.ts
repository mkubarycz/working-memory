import type { WorkstreamSection } from '../../../src/panelData';

export interface WorkstreamReorderUpdate {
  slug: string;
  section: WorkstreamSection;
  position: number;
}

export type WorkstreamSectionOrder = Record<WorkstreamSection, string[]>;

export interface WorkstreamDropBoundary {
  top: number;
  height: number;
}

export function workstreamDropIndex(boundaries: WorkstreamDropBoundary[], pointerY: number): number {
  const index = boundaries.findIndex(({ top, height }) => pointerY < top + height / 2);
  return index < 0 ? boundaries.length : index;
}

export function planWorkstreamReorder(
  order: WorkstreamSectionOrder,
  slug: string,
  targetSection: WorkstreamSection,
  targetIndex: number,
): WorkstreamReorderUpdate[] {
  const sourceSection = (Object.keys(order) as WorkstreamSection[])
    .find((section) => order[section].includes(slug));
  if (!sourceSection) return [];

  const sourceIndex = order[sourceSection].indexOf(slug);
  const source = order[sourceSection].filter((candidate) => candidate !== slug);
  const target = sourceSection === targetSection
    ? source
    : order[targetSection].filter((candidate) => candidate !== slug);
  const adjustedTargetIndex = sourceSection === targetSection && sourceIndex < targetIndex
    ? targetIndex - 1
    : targetIndex;
  const insertionIndex = Math.max(0, Math.min(adjustedTargetIndex, target.length));
  target.splice(insertionIndex, 0, slug);

  if (sourceSection === targetSection && target.every((candidate, index) => candidate === order[targetSection][index])) {
    return [];
  }

  const changedSections = sourceSection === targetSection
    ? [targetSection]
    : [sourceSection, targetSection];
  return changedSections.flatMap((section) => {
    const slugs = section === targetSection ? target : source;
    return slugs.map((candidate, position) => ({ slug: candidate, section, position }));
  });
}