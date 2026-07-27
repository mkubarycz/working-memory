import { describe, it, expect } from 'vitest';
import {
  buildWorkstreamPanels,
  type PanelWorkstream,
  type PanelWorkstreamSection,
} from '../src/panelData';
import type { Workstream } from '../src/controlPlaneClient';

/**
 * Unit-tests the PURE control-plane Active/Archive builder (WM 13.0
 * "ws-consumer-repoint"). No store, no VS Code, no daemon — it only shapes
 * already-fetched control-plane workstreams (the shape `client.wsRead` returns)
 * into the panel structures, so the per-workstream extras that need the
 * topic/entry/session domain layers are deliberately stubbed (empty children,
 * zero counts, no focused topics).
 */

function ws(
  slug: string,
  status: Workstream['status'],
  extra: Partial<Workstream> = {},
): Workstream {
  return {
    id: extra.id ?? `id-${slug}`,
    slug,
    title: extra.title ?? `WS ${slug}`,
    status,
    closure: extra.closure ?? null,
    opened_at: extra.opened_at ?? 1000,
    updated_at: extra.updated_at ?? 2000,
    closed_at: status === 'closed' ? extra.closed_at ?? 2000 : null,
    resourceVersion: extra.resourceVersion ?? 1,
  };
}

const sectionsOf = (items: unknown[]): PanelWorkstreamSection[] =>
  items as PanelWorkstreamSection[];

describe('buildWorkstreamPanels', () => {
  it('renders the daemon-down empty state on both tabs when unavailable', () => {
    const panels = buildWorkstreamPanels({
      available: false,
      workstreams: [],
      error: 'Control plane not running',
    });
    expect(panels.active.items).toEqual([]);
    expect(panels.archive.items).toEqual([]);
    expect(panels.active.emptyMessage).toBe('Control plane not running.');
    expect(panels.archive.emptyMessage).toBe('Control plane not running.');
  });

  it('renders three (empty) active sections + empty archive when available but empty', () => {
    const panels = buildWorkstreamPanels({ available: true, workstreams: [] });
    const sections = sectionsOf(panels.active.items);
    expect(sections.map((s) => s.section)).toEqual([
      'queue',
      'progress',
      'backlog',
    ]);
    for (const s of sections) {
      expect(s.kind).toBe('workstream-section');
      expect(s.workstreams).toEqual([]);
    }
    expect(panels.active.emptyMessage).toBe('No active workstreams.');
    expect(panels.archive.items).toEqual([]);
    expect(panels.archive.emptyMessage).toBe('No archived workstreams.');
  });

  it('groups workstreams by lifecycle status: queue/progress/backlog → Active, closed → Archive', () => {
    const panels = buildWorkstreamPanels({
      available: true,
      workstreams: [
        ws('a', 'queue'),
        ws('b', 'progress'),
        ws('c', 'backlog'),
        ws('d', 'closed'),
        ws('e', 'progress'),
      ],
    });
    const sections = sectionsOf(panels.active.items);
    const bySection = (name: string) =>
      sections.find((s) => s.section === name)!;
    expect(bySection('queue').workstreams.map((w) => w.label)).toEqual(['WS a']);
    expect(bySection('progress').workstreams.map((w) => w.label)).toEqual([
      'WS b',
      'WS e',
    ]);
    expect(bySection('backlog').workstreams.map((w) => w.label)).toEqual([
      'WS c',
    ]);
    // Only the closed workstream lands in Archive.
    expect(
      (panels.archive.items as PanelWorkstream[]).map((w) => w.label),
    ).toEqual(['WS d']);
  });

  it('builds an Active card with a section + section-move actions and a control-plane openUri', () => {
    const panels = buildWorkstreamPanels({
      available: true,
      workstreams: [ws('proj', 'progress', { title: 'Project' })],
    });
    const card = sectionsOf(panels.active.items).find(
      (s) => s.section === 'progress',
    )!.workstreams[0];
    expect(card.kind).toBe('workstream');
    expect(card.label).toBe('Project');
    expect(card.section).toBe('progress');
    // Opens the raw envelope via the control-plane-backed document virtual doc.
    expect(card.openUri).toBe('working-memory:/document/id-proj.md');
    // Simplified extras are stubbed until the topic/entry domain layers land.
    expect(card.focused_topics).toEqual([]);
    expect(card.children).toEqual([]);
    expect(card.recentEntryCount).toBe(0);
    // A 'progress' workstream can be moved to the other two sections.
    const moveTargets = card.actions.map((a) => a.command);
    expect(moveTargets).toEqual([
      'working-memory.setWorkstreamSection',
      'working-memory.setWorkstreamSection',
    ]);
    expect(card.actions).toHaveLength(2);
  });

  it('builds an Archive card with a reopen action and the closure note as description', () => {
    const panels = buildWorkstreamPanels({
      available: true,
      workstreams: [ws('done', 'closed', { closure: 'shipped it' })],
    });
    const card = (panels.archive.items as PanelWorkstream[])[0];
    expect(card.description).toBe('shipped it');
    expect(card.section).toBeUndefined();
    expect(card.actions).toHaveLength(1);
    expect(card.actions[0].command).toBe('working-memory.reopenWorkstream');
    expect(card.actions[0].args).toEqual([{ slug: 'done' }]);
  });
});
