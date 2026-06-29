import { beforeEach, describe, expect, test, vi } from 'vitest';
import { openJournalStore, type JournalStore } from '../src/db';
import { AlertsStore } from '../src/alerts/store';
import { registerAlertTools } from '../src/alerts/tools';

// ---------------------------------------------------------------------------
// vscode mock — mirrors the pattern in tests/topicTypes.test.ts so we can
// exercise the tool-registration layer without the real editor.
// ---------------------------------------------------------------------------
vi.mock('vscode', () => {
  const tools = new Map<
    string,
    { invoke: (options: unknown) => Promise<unknown> }
  >();
  class LanguageModelTextPart {
    constructor(public value: string) {}
  }
  class LanguageModelToolResult {
    constructor(public content: LanguageModelTextPart[]) {}
  }
  class Disposable {
    constructor(private readonly disposeFn: () => void) {}
    dispose(): void {
      this.disposeFn();
    }
  }
  return {
    lm: {
      registerTool: (
        name: string,
        impl: { invoke: (options: unknown) => Promise<unknown> },
      ) => {
        tools.set(name, impl);
        return new Disposable(() => tools.delete(name));
      },
    },
    LanguageModelTextPart,
    LanguageModelToolResult,
    Disposable,
    __getRegisteredTool: (name: string) => tools.get(name),
    __clearRegisteredTools: () => tools.clear(),
  };
});

function parseToolResult(result: unknown): Record<string, unknown> {
  const payload = (result as { content: Array<{ value: string }> }).content[0]
    ?.value;
  return JSON.parse(payload ?? '{}') as Record<string, unknown>;
}

/** Build a store seeded with the given topic slugs. */
function freshStore(topicSlugs: string[] = []): {
  store: JournalStore;
  alerts: AlertsStore;
} {
  const store = openJournalStore({ dbPath: ':memory:' });
  for (const slug of topicSlugs) {
    store.createTopic({ slug });
  }
  return { store, alerts: new AlertsStore(store.connection) };
}

beforeEach(async () => {
  const vscode = await import('vscode');
  (
    vscode as unknown as { __clearRegisteredTools: () => void }
  ).__clearRegisteredTools();
});

// ---------------------------------------------------------------------------
// CRUD suite (AlertsStore data layer)
// ---------------------------------------------------------------------------

describe('AlertsStore CRUD', () => {
  test('createAlert: inserts with defaults, status alert, links topics', () => {
    const { alerts } = freshStore(['topic-a', 'topic-b']);
    const { alert, deduped } = alerts.createAlert({
      description: 'Disk almost full',
      recommended_action: 'Free space',
      topic_slugs: ['topic-a', 'topic-b'],
      created_by: 'monitor',
    });
    expect(deduped).toBe(false);
    expect(alert.id).toBeGreaterThan(0);
    expect(alert.status).toBe('alert');
    expect(alert.description).toBe('Disk almost full');
    expect(alert.recommended_action).toBe('Free space');
    expect(alert.created_by).toBe('monitor');
    expect(alert.dedupe_key).toBeTruthy();
    expect(alert.topics.sort()).toEqual(['topic-a', 'topic-b']);
  });

  test('createAlert: defaults created_by to system and recommended_action to empty', () => {
    const { alerts } = freshStore(['topic-a']);
    const { alert } = alerts.createAlert({
      description: 'Something',
      topic_slugs: ['topic-a'],
    });
    expect(alert.created_by).toBe('system');
    expect(alert.recommended_action).toBe('');
  });

  test('createAlert: empty description rejected', () => {
    const { alerts } = freshStore();
    expect(() => alerts.createAlert({ description: '   ' })).toThrow(
      /description is required/,
    );
  });

  test('getAlert: returns null for unknown id', () => {
    const { alerts } = freshStore();
    expect(alerts.getAlert(999)).toBeNull();
  });

  test('getAlert: returns the alert with topics', () => {
    const { alerts } = freshStore(['topic-a']);
    const { alert } = alerts.createAlert({
      description: 'x',
      topic_slugs: ['topic-a'],
    });
    const fetched = alerts.getAlert(alert.id);
    expect(fetched?.id).toBe(alert.id);
    expect(fetched?.topics).toEqual(['topic-a']);
  });

  test('listAlerts: status + topic filters', () => {
    const { alerts } = freshStore(['topic-a', 'topic-b']);
    const a1 = alerts.createAlert({
      description: 'a1',
      topic_slugs: ['topic-a'],
      dedupe_key: 'k1',
    }).alert;
    const a2 = alerts.createAlert({
      description: 'a2',
      topic_slugs: ['topic-b'],
      dedupe_key: 'k2',
    }).alert;
    alerts.updateAlert(a2.id, { status: 'informational' });

    // active queue = both
    expect(alerts.listAlerts().map((a) => a.id).sort()).toEqual(
      [a1.id, a2.id].sort(),
    );
    // status filter
    expect(alerts.listAlerts({ status: 'alert' }).map((a) => a.id)).toEqual([
      a1.id,
    ]);
    expect(
      alerts.listAlerts({ status: 'informational' }).map((a) => a.id),
    ).toEqual([a2.id]);
    // topic scope
    expect(
      alerts.listAlerts({ status: 'all', topic_slug: 'topic-a' }).map(
        (a) => a.id,
      ),
    ).toEqual([a1.id]);
  });

  test('listAlerts: ordered by severity then recency', () => {
    const { alerts } = freshStore(['t']);
    const older = alerts.createAlert({
      description: 'older-alert',
      topic_slugs: ['t'],
      dedupe_key: 'a',
    }).alert;
    const info = alerts.createAlert({
      description: 'info',
      topic_slugs: ['t'],
      dedupe_key: 'b',
    }).alert;
    alerts.updateAlert(info.id, { status: 'informational' });
    const newer = alerts.createAlert({
      description: 'newer-alert',
      topic_slugs: ['t'],
      dedupe_key: 'c',
    }).alert;
    const ordered = alerts.listAlerts({ status: 'all' }).map((a) => a.id);
    // alert-status first (newer before older within same severity), then informational
    expect(ordered).toEqual([newer.id, older.id, info.id]);
  });

  test('updateAlert: edits fields and bumps updated_at', () => {
    const { alerts } = freshStore(['t']);
    const { alert } = alerts.createAlert({
      description: 'before',
      topic_slugs: ['t'],
    });
    const updated = alerts.updateAlert(alert.id, {
      description: 'after',
      recommended_action: 'do it',
    });
    expect(updated.description).toBe('after');
    expect(updated.recommended_action).toBe('do it');
    expect(updated.updated_at).toBeGreaterThanOrEqual(alert.updated_at);
  });

  test('updateAlert: every status transition', () => {
    const { alerts } = freshStore(['t']);
    const { alert } = alerts.createAlert({
      description: 'x',
      topic_slugs: ['t'],
    });
    expect(alerts.updateAlert(alert.id, { status: 'informational' }).status).toBe(
      'informational',
    );
    expect(alerts.updateAlert(alert.id, { status: 'alert' }).status).toBe(
      'alert',
    );
    expect(alerts.updateAlert(alert.id, { status: 'closed' }).status).toBe(
      'closed',
    );
  });

  test('updateAlert: unknown id and empty description rejected', () => {
    const { alerts } = freshStore(['t']);
    expect(() => alerts.updateAlert(123, { status: 'closed' })).toThrow(
      /alert not found/,
    );
    const { alert } = alerts.createAlert({ description: 'x', topic_slugs: ['t'] });
    expect(() =>
      alerts.updateAlert(alert.id, { description: '  ' }),
    ).toThrow(/cannot be empty/);
  });

  test('link / unlink alert topic', () => {
    const { alerts } = freshStore(['t1', 't2']);
    const { alert } = alerts.createAlert({
      description: 'x',
      topic_slugs: ['t1'],
    });
    const link = alerts.linkAlertTopic(alert.id, 't2');
    expect(link.link_created).toBe(true);
    expect(alerts.getAlert(alert.id)?.topics.sort()).toEqual(['t1', 't2']);
    // idempotent
    expect(alerts.linkAlertTopic(alert.id, 't2').link_created).toBe(false);
    // unlink
    expect(alerts.unlinkAlertTopic(alert.id, 't2').unlinked).toBe(true);
    expect(alerts.unlinkAlertTopic(alert.id, 't2').unlinked).toBe(false);
    expect(alerts.getAlert(alert.id)?.topics).toEqual(['t1']);
  });

  test('link rejects unknown topic; link/unlink reject unknown alert', () => {
    const { alerts } = freshStore(['t1']);
    const { alert } = alerts.createAlert({
      description: 'x',
      topic_slugs: ['t1'],
    });
    expect(() => alerts.linkAlertTopic(alert.id, 'nope')).toThrow(
      /topic not found/,
    );
    expect(() => alerts.linkAlertTopic(999, 't1')).toThrow(/alert not found/);
    expect(() => alerts.unlinkAlertTopic(999, 't1')).toThrow(/alert not found/);
  });

  test('read paths tolerate a missing DB handle', () => {
    const detached = new AlertsStore(null);
    expect(detached.getAlert(1)).toBeNull();
    expect(detached.listAlerts()).toEqual([]);
    expect(() => detached.createAlert({ description: 'x' })).toThrow(
      /no database handle/,
    );
  });
});

// ---------------------------------------------------------------------------
// Per-topic rollup helpers (panel bubble + topic-doc section)
// ---------------------------------------------------------------------------

describe('AlertsStore.openCountForTopic', () => {
  test('zero open alerts => count 0, severity null', () => {
    const { alerts } = freshStore(['t']);
    expect(alerts.openCountForTopic('t')).toEqual({ count: 0, severity: null });
  });

  test('max severity is alert when any open alert is loud', () => {
    const { alerts } = freshStore(['t']);
    const info = alerts.createAlert({
      description: 'quiet',
      topic_slugs: ['t'],
      dedupe_key: 'i',
    }).alert;
    alerts.updateAlert(info.id, { status: 'informational' });
    alerts.createAlert({ description: 'loud', topic_slugs: ['t'], dedupe_key: 'a' });
    expect(alerts.openCountForTopic('t')).toEqual({ count: 2, severity: 'alert' });
  });

  test('severity informational when only quiet alerts are open', () => {
    const { alerts } = freshStore(['t']);
    const a = alerts.createAlert({ description: 'q1', topic_slugs: ['t'], dedupe_key: '1' }).alert;
    const b = alerts.createAlert({ description: 'q2', topic_slugs: ['t'], dedupe_key: '2' }).alert;
    alerts.updateAlert(a.id, { status: 'informational' });
    alerts.updateAlert(b.id, { status: 'informational' });
    expect(alerts.openCountForTopic('t')).toEqual({ count: 2, severity: 'informational' });
  });

  test('closed alerts are excluded from the count', () => {
    const { alerts } = freshStore(['t']);
    const a = alerts.createAlert({ description: 'open', topic_slugs: ['t'], dedupe_key: '1' }).alert;
    const b = alerts.createAlert({ description: 'gone', topic_slugs: ['t'], dedupe_key: '2' }).alert;
    alerts.updateAlert(b.id, { status: 'closed' });
    expect(alerts.openCountForTopic('t')).toEqual({ count: 1, severity: 'alert' });
    expect(a.id).toBeGreaterThan(0);
  });

  test('missing DB handle => count 0, severity null', () => {
    expect(new AlertsStore(null).openCountForTopic('t')).toEqual({ count: 0, severity: null });
  });
});

describe('AlertsStore.topicAlertsWithRecentClosed', () => {
  test('includes active alerts and excludes long-closed ones', () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date('2026-06-28T12:00:00Z'));
      const { alerts } = freshStore(['t']);
      const open = alerts.createAlert({ description: 'open', topic_slugs: ['t'], dedupe_key: '1' }).alert;
      const stale = alerts.createAlert({ description: 'stale', topic_slugs: ['t'], dedupe_key: '2' }).alert;
      alerts.updateAlert(stale.id, { status: 'closed' });
      // Move clock 2h forward: stale closed alert ages out of the 1h window.
      vi.setSystemTime(new Date('2026-06-28T14:00:00Z'));
      const ids = alerts.topicAlertsWithRecentClosed('t').map((a) => a.id);
      expect(ids).toEqual([open.id]);
    } finally {
      vi.useRealTimers();
    }
  });

  test('includes a just-closed alert within the 1h window', () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date('2026-06-28T12:00:00Z'));
      const { alerts } = freshStore(['t']);
      const open = alerts.createAlert({ description: 'open', topic_slugs: ['t'], dedupe_key: '1' }).alert;
      const recent = alerts.createAlert({ description: 'recent', topic_slugs: ['t'], dedupe_key: '2' }).alert;
      alerts.updateAlert(recent.id, { status: 'closed' });
      // 30 minutes later: closed alert still lingers.
      vi.setSystemTime(new Date('2026-06-28T12:30:00Z'));
      const ids = alerts.topicAlertsWithRecentClosed('t').map((a) => a.id).sort();
      expect(ids).toEqual([open.id, recent.id].sort());
    } finally {
      vi.useRealTimers();
    }
  });

  test('missing DB handle => empty list', () => {
    expect(new AlertsStore(null).topicAlertsWithRecentClosed('t')).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Workflow tests mapped to the user stories
// ---------------------------------------------------------------------------

describe('alerts workflows (user stories)', () => {
  // Story: alerts-agent-leaves-alert
  test('agent leaves an alert against topic(s)', () => {
    const { alerts } = freshStore(['stale-pr', 'ci']);
    const { alert, deduped } = alerts.createAlert({
      description: 'PR #42 has been open 30 days',
      recommended_action: 'Ping the author',
      topic_slugs: ['stale-pr', 'ci'],
      created_by: 'pr-bot',
    });
    expect(deduped).toBe(false);
    expect(alert.status).toBe('alert');
    expect(alert.topics.sort()).toEqual(['ci', 'stale-pr']);
  });

  // Story: alerts-triage-an-alert — reject unknown / soft-deleted topic
  test('createAlert rejects unknown topic slug', () => {
    const { alerts } = freshStore(['known']);
    expect(() =>
      alerts.createAlert({ description: 'x', topic_slugs: ['ghost'] }),
    ).toThrow(/topic not found/);
  });

  test('createAlert rejects soft-deleted topic slug', () => {
    const { store, alerts } = freshStore(['doomed']);
    store.softDeleteTopic('doomed');
    expect(() =>
      alerts.createAlert({ description: 'x', topic_slugs: ['doomed'] }),
    ).toThrow(/topic not found \(or soft-deleted\)/);
  });

  // Story: dedupe — same job re-raises => upsert, not duplicate
  test('dedupe: same caller key re-raises (upsert) instead of duplicating', () => {
    const { alerts } = freshStore(['t']);
    const first = alerts.createAlert({
      description: 'stale',
      topic_slugs: ['t'],
      dedupe_key: 'stale-pr:t',
    });
    expect(first.deduped).toBe(false);
    const second = alerts.createAlert({
      description: 'stale (updated count)',
      topic_slugs: ['t'],
      dedupe_key: 'stale-pr:t',
    });
    expect(second.deduped).toBe(true);
    expect(second.alert.id).toBe(first.alert.id);
    expect(second.alert.description).toBe('stale (updated count)');
    expect(alerts.listAlerts({ status: 'all' })).toHaveLength(1);
  });

  // Story: dedupe upsert — the second create with the same key updates the
  // existing row's description, status (re-raised to 'alert'), and updated_at.
  test('dedupe upsert: same key changes description, status, and updated_at', () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date('2026-06-28T12:00:00Z'));
      const { alerts } = freshStore(['t']);

      // 1) Create a new alert.
      const first = alerts.createAlert({
        description: 'first description',
        recommended_action: 'do the first thing',
        topic_slugs: ['t'],
        dedupe_key: 'recurring:t',
      });
      expect(first.deduped).toBe(false);
      expect(first.alert.status).toBe('alert');

      // Downgrade it so the upsert's status change is observable
      // (informational -> back to alert).
      const downgraded = alerts.updateAlert(first.alert.id, {
        status: 'informational',
      });
      expect(downgraded.status).toBe('informational');

      // Advance the clock so updated_at must strictly increase.
      vi.setSystemTime(new Date('2026-06-28T13:00:00Z'));

      // 2) Create a second alert with the SAME dedupe key -> upsert.
      const second = alerts.createAlert({
        description: 'second description',
        topic_slugs: ['t'],
        dedupe_key: 'recurring:t',
      });

      // Same row, not a duplicate.
      expect(second.deduped).toBe(true);
      expect(second.alert.id).toBe(first.alert.id);
      expect(alerts.listAlerts({ status: 'all' })).toHaveLength(1);

      // Verify the update operation: description, status, and updated_at change.
      expect(second.alert.description).toBe('second description');
      expect(second.alert.status).toBe('alert');
      expect(second.alert.updated_at).toBeGreaterThan(downgraded.updated_at);
    } finally {
      vi.useRealTimers();
    }
  });

  test('dedupe: derived key collides on same job + text + topics', () => {
    const { alerts } = freshStore(['t']);
    const a = alerts.createAlert({
      description: 'same',
      topic_slugs: ['t'],
      created_by: 'job',
    });
    const b = alerts.createAlert({
      description: 'same',
      topic_slugs: ['t'],
      created_by: 'job',
    });
    expect(b.deduped).toBe(true);
    expect(b.alert.id).toBe(a.alert.id);
    expect(alerts.listAlerts({ status: 'all' })).toHaveLength(1);
  });

  test('dedupe: 10 alerts to 10 distinct topics => 10 distinct alerts (derived keys)', () => {
    const slugs = Array.from({ length: 10 }, (_, i) => `topic-${i}`);
    const { alerts } = freshStore(slugs);
    for (const slug of slugs) {
      alerts.createAlert({
        description: 'stale PR',
        topic_slugs: [slug],
        created_by: 'pr-bot',
      });
    }
    expect(alerts.listAlerts({ status: 'all' })).toHaveLength(10);
  });

  test('dedupe: closing frees the key so a recurrence re-raises a new row', () => {
    const { alerts } = freshStore(['t']);
    const first = alerts.createAlert({
      description: 'flaky',
      topic_slugs: ['t'],
      dedupe_key: 'flaky:t',
    });
    alerts.updateAlert(first.alert.id, { status: 'closed' });
    const recurrence = alerts.createAlert({
      description: 'flaky again',
      topic_slugs: ['t'],
      dedupe_key: 'flaky:t',
    });
    expect(recurrence.deduped).toBe(false);
    expect(recurrence.alert.id).not.toBe(first.alert.id);
    // one closed + one open
    expect(alerts.listAlerts({ status: 'all' })).toHaveLength(2);
    expect(alerts.listAlerts()).toHaveLength(1); // active queue
  });

  test('dedupe: re-raise on a downgraded (informational) alert bumps it back to alert', () => {
    const { alerts } = freshStore(['t']);
    const first = alerts.createAlert({
      description: 'noisy',
      topic_slugs: ['t'],
      dedupe_key: 'noisy:t',
    });
    alerts.updateAlert(first.alert.id, { status: 'informational' });
    const again = alerts.createAlert({
      description: 'noisy again',
      topic_slugs: ['t'],
      dedupe_key: 'noisy:t',
    });
    expect(again.deduped).toBe(true);
    expect(again.alert.id).toBe(first.alert.id);
    expect(again.alert.status).toBe('alert');
  });

  // Status lifecycle: downgrade stays in queue, close leaves it
  test('downgrade to informational stays in the active queue; close removes it', () => {
    const { alerts } = freshStore(['t']);
    const { alert } = alerts.createAlert({
      description: 'x',
      topic_slugs: ['t'],
    });
    alerts.updateAlert(alert.id, { status: 'informational' });
    expect(alerts.listAlerts().map((a) => a.id)).toContain(alert.id);
    alerts.updateAlert(alert.id, { status: 'closed' });
    expect(alerts.listAlerts().map((a) => a.id)).not.toContain(alert.id);
    expect(
      alerts.listAlerts({ status: 'closed' }).map((a) => a.id),
    ).toContain(alert.id);
  });

  // Story: alerts-link-to-source — 1 alert -> many topics
  test('1 alert to many topics is a single row with many links', () => {
    const { alerts } = freshStore(['a', 'b', 'c']);
    const { alert } = alerts.createAlert({
      description: 'cross-cutting',
      topic_slugs: ['a', 'b', 'c'],
    });
    expect(alert.topics.sort()).toEqual(['a', 'b', 'c']);
    expect(alerts.listAlerts({ status: 'all' })).toHaveLength(1);
    for (const slug of ['a', 'b', 'c']) {
      expect(
        alerts.listAlerts({ status: 'all', topic_slug: slug }).map((x) => x.id),
      ).toEqual([alert.id]);
    }
  });

  // Story: alerts-see-what-needs-attention — many alerts -> many topics shape
  test('many alerts to many topics: each topic surfaces its own alerts', () => {
    const { alerts } = freshStore(['x', 'y']);
    const a1 = alerts.createAlert({
      description: 'a1',
      topic_slugs: ['x', 'y'],
      dedupe_key: 'a1',
    }).alert;
    const a2 = alerts.createAlert({
      description: 'a2',
      topic_slugs: ['y'],
      dedupe_key: 'a2',
    }).alert;
    expect(
      alerts.listAlerts({ status: 'all', topic_slug: 'x' }).map((a) => a.id),
    ).toEqual([a1.id]);
    expect(
      alerts
        .listAlerts({ status: 'all', topic_slug: 'y' })
        .map((a) => a.id)
        .sort(),
    ).toEqual([a1.id, a2.id].sort());
  });
});

// ---------------------------------------------------------------------------
// Tool-registration layer (wiring + error envelopes)
// ---------------------------------------------------------------------------

describe('alerts tools wiring', () => {
  async function setup() {
    const vscode = await import('vscode');
    const store = openJournalStore({ dbPath: ':memory:' });
    store.createTopic({ slug: 'topic-a' });
    const alerts = new AlertsStore(store.connection);
    const refresh = vi.fn();
    registerAlertTools(alerts, { refresh });
    const get = (name: string) =>
      (
        vscode as unknown as {
          __getRegisteredTool: (
            n: string,
          ) => { invoke: (o: unknown) => Promise<unknown> } | undefined;
        }
      ).__getRegisteredTool(name);
    return { get, refresh };
  }

  test('all six alert tools register', async () => {
    const { get } = await setup();
    for (const name of [
      'wm_create_alert',
      'wm_get_alert',
      'wm_list_alerts',
      'wm_update_alert',
      'wm_link_alert_topic',
      'wm_unlink_alert_topic',
    ]) {
      expect(get(name)).toBeTruthy();
    }
  });

  test('create -> get -> update round trip through tools', async () => {
    const { get, refresh } = await setup();
    const created = parseToolResult(
      await get('wm_create_alert')!.invoke({
        input: { description: 'tool alert', topic_slugs: ['topic-a'] },
      }),
    );
    expect(created.ok).toBe(true);
    const alert = (created as { alert: { id: number } }).alert;
    expect(refresh).toHaveBeenCalled();

    const got = parseToolResult(
      await get('wm_get_alert')!.invoke({ input: { id: alert.id } }),
    );
    expect((got as { alert: { description: string } }).alert.description).toBe(
      'tool alert',
    );

    const updated = parseToolResult(
      await get('wm_update_alert')!.invoke({
        input: { id: alert.id, status: 'closed' },
      }),
    );
    expect((updated as { alert: { status: string } }).alert.status).toBe(
      'closed',
    );
  });

  test('tool errors return ok:false envelope', async () => {
    const { get } = await setup();
    const res = parseToolResult(
      await get('wm_create_alert')!.invoke({
        input: { description: 'x', topic_slugs: ['ghost'] },
      }),
    );
    expect(res.ok).toBe(false);
    expect(String(res.error)).toMatch(/topic not found/);
  });
});
