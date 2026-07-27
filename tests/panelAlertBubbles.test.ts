import { describe, it, expect } from 'vitest';
import {
  buildTopicsPanel,
  buildWorkstreamPanels,
  type PanelTopicRow,
  type PanelWorkstream,
  type PanelWorkstreamSection,
} from '../src/panelData';
import type {
  Alert,
  Topic as ControlPlaneTopic,
  Workstream,
} from '../src/controlPlaneClient';

/**
 * Unit-tests the control-plane alert-bubble aggregation (WM 13.0
 * "panel-alert-bubbles"): the Active/Archive/Topics card bubbles are computed
 * from the control-plane `ws-alert-read` list (an alert's `spec.topics` slug
 * refs), NOT the journal `AlertsStore`. Pure builders — no store, no daemon —
 * so alerts are injected through the new `alerts` param.
 */

function topic(
  slug: string,
  extra: Partial<ControlPlaneTopic> = {},
): ControlPlaneTopic {
  return {
    id: extra.id ?? `id-${slug}`,
    slug,
    title: extra.title ?? `Topic ${slug}`,
    body: extra.body ?? '',
    status: extra.status ?? 'open',
    topicType: extra.topicType ?? 'topic',
    parents: extra.parents ?? [],
    workstreams: extra.workstreams ?? [],
    focusedWorkstreams: extra.focusedWorkstreams ?? [],
    created_at: extra.created_at ?? 1000,
    updated_at: extra.updated_at ?? 2000,
    resourceVersion: extra.resourceVersion ?? 1,
  };
}

function alert(
  id: string,
  status: Alert['status'],
  topics: string[],
  extra: Partial<Alert> = {},
): Alert {
  return {
    id,
    slug: null,
    title: extra.title ?? `Alert ${id}`,
    description: extra.description ?? '',
    recommended_action: extra.recommended_action ?? '',
    status,
    dedupe_key: extra.dedupe_key ?? null,
    created_by: extra.created_by ?? 'system',
    topics,
    created_at: extra.created_at ?? 1000,
    updated_at: extra.updated_at ?? 2000,
    resourceVersion: extra.resourceVersion ?? 1,
  };
}

function ws(slug: string, status: Workstream['status'] = 'progress'): Workstream {
  return {
    id: `id-${slug}`,
    slug,
    title: `WS ${slug}`,
    status,
    closure: null,
    opened_at: 1000,
    updated_at: 2000,
    closed_at: status === 'closed' ? 2000 : null,
    resourceVersion: 1,
  };
}

const rowsOf = (items: unknown[]): PanelTopicRow[] => items as PanelTopicRow[];
const cardIn = (panels: ReturnType<typeof buildWorkstreamPanels>, section: string) =>
  (panels.active.items as PanelWorkstreamSection[]).find(
    (s) => s.section === section,
  )!.workstreams[0];

describe('control-plane topic alert bubble (buildTopicsPanel)', () => {
  it('counts only OPEN alerts referencing the topic; closed excluded, non-member topics ignored', () => {
    const topics = [topic('t'), topic('other')];
    const alerts = [
      alert('a1', 'informational', ['t']),
      alert('a2', 'closed', ['t']), // closed → excluded
      alert('a3', 'alert', ['other']), // different topic → ignored for 't'
    ];
    const panel = buildTopicsPanel({ available: true, topics, alerts });
    const rows = rowsOf(panel.items);
    const tRow = rows.find((r) => r.label === 'Topic t')!;
    const otherRow = rows.find((r) => r.label === 'Topic other')!;
    expect(tRow.alertCount).toBe(1);
    expect(tRow.alertSeverity).toBe('informational');
    expect(otherRow.alertCount).toBe(1);
    expect(otherRow.alertSeverity).toBe('alert');
  });

  it('escalates severity to alert when any referencing open alert is status:alert', () => {
    const topics = [topic('t')];
    const alerts = [
      alert('a1', 'informational', ['t']),
      alert('a2', 'alert', ['t']),
    ];
    const panel = buildTopicsPanel({ available: true, topics, alerts });
    const tRow = rowsOf(panel.items)[0];
    expect(tRow.alertCount).toBe(2);
    expect(tRow.alertSeverity).toBe('alert');
  });

  it('renders no bubble (count 0, severity null) when no open alert references the topic', () => {
    const panel = buildTopicsPanel({
      available: true,
      topics: [topic('t')],
      alerts: [alert('a1', 'closed', ['t'])],
    });
    const tRow = rowsOf(panel.items)[0];
    expect(tRow.alertCount).toBe(0);
    expect(tRow.alertSeverity).toBeNull();
  });
});

describe('control-plane workstream alert rollup (buildWorkstreamPanels)', () => {
  it('rolls up the union of open alerts across member topics, deduped by alert id', () => {
    // Two topics are members of workstream `w`; one alert references BOTH — it
    // must count once, not twice.
    const topics = [
      topic('t1', { workstreams: ['w'] }),
      topic('t2', { workstreams: ['w'] }),
      topic('t3', { workstreams: ['other'] }), // not a member → ignored
    ];
    const alerts = [
      alert('shared', 'informational', ['t1', 't2']), // spans two members → once
      alert('a-t2', 'alert', ['t2']),
      alert('a-t3', 'alert', ['t3']), // non-member topic → excluded
    ];
    const panels = buildWorkstreamPanels({
      available: true,
      workstreams: [ws('w')],
      topics,
      alerts,
    });
    const card: PanelWorkstream = cardIn(panels, 'progress');
    // shared (once) + a-t2 = 2 distinct open alerts; a-t3 excluded.
    expect(card.alertCount).toBe(2);
    // Max severity across the deduped set is 'alert' (from a-t2).
    expect(card.alertSeverity).toBe('alert');
  });

  it('excludes closed alerts and yields no bubble when nothing open references a member', () => {
    const topics = [topic('t1', { workstreams: ['w'] })];
    const alerts = [alert('c1', 'closed', ['t1'])];
    const panels = buildWorkstreamPanels({
      available: true,
      workstreams: [ws('w')],
      topics,
      alerts,
    });
    const card = cardIn(panels, 'progress');
    expect(card.alertCount).toBe(0);
    expect(card.alertSeverity).toBeNull();
  });
});

describe('control-plane per-workstream focus pin (buildWorkstreamPanels)', () => {
  const topicsGroupOf = (card: PanelWorkstream) =>
    card.children.find((c) => c.kind === 'topics-group')!;

  it('flags a focused member focused:true in the Topics group AND pins it in focused_topics', () => {
    const topics = [
      // Focused in workstream `w`.
      topic('pinned', { workstreams: ['w'], focusedWorkstreams: ['w'] }),
      // A member of `w` but NOT focused.
      topic('plain', { workstreams: ['w'] }),
      // Focused in a DIFFERENT workstream → must not leak into `w`.
      topic('elsewhere', { workstreams: ['w'], focusedWorkstreams: ['other'] }),
    ];
    const panels = buildWorkstreamPanels({
      available: true,
      workstreams: [ws('w')],
      topics,
      alerts: [],
    });
    const card: PanelWorkstream = cardIn(panels, 'progress');

    // The Topics group flags exactly the pinned topic as focused.
    const group = topicsGroupOf(card);
    const groupRows = group.children as { label: string; focused: boolean }[];
    const pinnedRow = groupRows.find((r) => r.label === 'Topic pinned')!;
    const plainRow = groupRows.find((r) => r.label === 'Topic plain')!;
    const elsewhereRow = groupRows.find((r) => r.label === 'Topic elsewhere')!;
    expect(pinnedRow.focused).toBe(true);
    expect(plainRow.focused).toBe(false);
    expect(elsewhereRow.focused).toBe(false);

    // The pinned row (and only it) appears in the focused_topics pin.
    expect(card.focused_topics.map((t) => t.label)).toEqual(['Topic pinned']);
  });

  it('leaves focused_topics empty when no member is focused in this workstream', () => {
    const topics = [topic('plain', { workstreams: ['w'] })];
    const panels = buildWorkstreamPanels({
      available: true,
      workstreams: [ws('w')],
      topics,
      alerts: [],
    });
    const card = cardIn(panels, 'progress');
    expect(card.focused_topics).toEqual([]);
  });
});
