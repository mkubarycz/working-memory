import type { PanelData, PanelWorkstream } from '../src/panelData';

/**
 * Flatten the Active tab's section groups (Queue/Progress/Backlog) back into a
 * single list of workstream items. The Active tab now ships
 * `workstream-section` groups rather than flat workstream items; tests that
 * only care about the workstreams themselves use this to look past the
 * sectioning.
 */
export function activeWorkstreams(active: PanelData): PanelWorkstream[] {
  const out: PanelWorkstream[] = [];
  for (const item of active.items) {
    if (item.kind === 'workstream-section') {
      out.push(...item.workstreams);
    }
  }
  return out;
}
