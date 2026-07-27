import * as vscode from 'vscode';
import {
  buildTopicsPanel,
  getAllPanelData,
  getPanelData,
  type PanelData,
  type PanelTab,
} from './panelData';
import { JournalStore, humanizeSlug, type TopicStatus, type WorkstreamStatus } from './db';
import {
  type TraversalModeId,
} from './graphTraversals';
import { reshapeTopicBody, extractH2Headers } from './topicReshape';
import { registerAlertsFeature } from './alerts';
import { registerNanitesFeature } from './nanites';
import type {
  ControlPlaneClient,
  WorkstreamLifecycleStatus,
  Topic as ControlPlaneTopic,
} from './controlPlaneClient';

interface ToolDeps {
  refresh: () => void;
}

function jsonResult(data: unknown): vscode.LanguageModelToolResult {
  return new vscode.LanguageModelToolResult([
    new vscode.LanguageModelTextPart(JSON.stringify(data, null, 2)),
  ]);
}

function errorResult(message: string): vscode.LanguageModelToolResult {
  return new vscode.LanguageModelToolResult([
    new vscode.LanguageModelTextPart(
      JSON.stringify({ ok: false, error: message }, null, 2),
    ),
  ]);
}

function safe<TInput>(
  handler: (input: TInput) => unknown | Promise<unknown>,
): (
  options: vscode.LanguageModelToolInvocationOptions<TInput>,
) => Promise<vscode.LanguageModelToolResult> {
  return async (options) => {
    try {
      const out = await handler(options.input);
      return jsonResult(out);
    } catch (err) {
      return errorResult(err instanceof Error ? err.message : String(err));
    }
  };
}

// ---------------------------------------------------------------------------
// Tool input interfaces
// ---------------------------------------------------------------------------

interface ListWorkstreamsInput {
  status?: 'open' | 'closed' | 'all';
  include_deleted?: boolean;
}
interface GetWorkstreamInput {
  slug?: string;
  id?: number;
  include_deleted?: boolean;
}
interface CreateWorkstreamToolInput {
  slug: string;
  title: string;
  status?: WorkstreamStatus;
  /** Optional: pin a topic to this workstream at creation (same as calling wm_link_workstream_topic after). Pair with focused: true to create a workstream that is immediately focused on a topic. */
  topic_slug?: string;
  /** Only meaningful with topic_slug. true → set focused = 1 on the link. */
  focused?: boolean;
}
interface UpdateWorkstreamToolInput {
  slug: string;
  title?: string;
  status?: WorkstreamStatus;
  closure?: string;
}
interface DeleteWorkstreamInput {
  slug: string;
}
interface StartSessionToolInput {
  workstream_slug: string;
  summary?: string;
  session_id?: string;
  chat_ref?: string | null;
}
interface EndSessionToolInput {
  session_id: string;
  summary?: string;
}
interface GetSessionInput {
  session_id: string;
  include_deleted?: boolean;
}
interface DeleteSessionInput {
  session_id: string;
}
interface AppendEntryToolInput {
  session_id: string;
  body: string;
  created_by: string;
  timestamp?: number;
}
interface SearchEntriesToolInput {
  query: string;
  workstream_slug?: string;
  limit?: number;
}
interface DeleteEntryInput {
  entry_id: number;
}
interface ListTopicsInput {
  status?: TopicStatus | 'all';
  include_deleted?: boolean;
  workstream_slug?: string;
  topic_type?: string;
}
interface GetTopicInput {
  slug: string;
  include_deleted?: boolean;
}
interface CreateTopicToolInput {
  slug: string;
  title?: string;
  body?: string;
  status?: TopicStatus;
  topic_type?: string;
  /** Optional: pin to a workstream at creation (same as calling wm_link_workstream_topic after). */
  workstream_slug?: string;
  /** Only meaningful with workstream_slug. true → set focused = 1 on the workstream link. */
  focused?: boolean;
  /** Optional: tag an entry with this topic at creation (also auto-creates the workstream link for that entry's workstream). */
  entry_id?: number;
  /** Optional: link to one or more parent topics at creation. Accepts a single slug or an array of slugs. */
  parent_slug?: string | string[];
}
interface UpdateTopicToolInput {
  slug: string;
  title?: string;
  body?: string;
  status?: TopicStatus;
  topic_type?: string;
}
interface DeleteTopicInput {
  slug: string;
}
interface RestoreWorkstreamInput {
  slug: string;
}
interface RestoreSessionInput {
  session_id: string;
}
interface RestoreEntryInput {
  entry_id: number;
}
interface RestoreTopicInput {
  slug: string;
}
interface LinkWorkstreamTopicToolInput {
  workstream_slug: string;
  topic_slug: string;
  /**
   * Optional. true → mark this topic as focused in the workstream;
   * false → clear focus (link itself stays); omitted → preserve existing
   * focus state. Focus is only applied to the seed topic, never to
   * traversed neighbours.
   */
  focused?: boolean;
  /**
   * Graph-traversal mode. Determines which topics (relative to topic_slug)
   * are attached in addition to the seed. Defaults to 'self' (only the seed,
   * preserving the original single-topic behaviour).
   */
  traversal?: TraversalModeId;
  /**
   * When true, closed topics encountered during traversal are included.
   * Defaults to false. Has no effect when traversal is 'self'.
   */
  includeClosed?: boolean;
}
interface LinkEntryTopicToolInput {
  entry_id: number;
  topic_slug: string;
}
interface TopicParentLinkInput {
  child_slug: string;
  parent_slug: string;
}
interface CreateTopicTypeInput {
  id: string;
  label: string;
  icon: string;
  description: string;
}
interface GetTopicTypeInput {
  id: string;
}
interface UpdateTopicTypeInput {
  id: string;
  label?: string;
  icon?: string;
  description?: string;
  body_template?: string;
}
interface DeleteTopicTypeInput {
  id: string;
}
interface GetPanelDataInput {
  tab?: 'active' | 'archive' | 'topics' | 'topic-types' | 'all';
}

function topicSummary(
  t: ControlPlaneTopic,
): { slug: string; title: string; status: TopicStatus } {
  return { slug: t.slug ?? '', title: t.title, status: t.status };
}

/**
 * Map the tool-facing WorkstreamStatus (which still carries the legacy 'open'
 * alias) onto the control-plane lifecycle enum. 'open' → 'progress' (matching
 * migration 014); undefined passes through so the kind's default applies.
 */
function normalizeLifecycleStatus(
  status: WorkstreamStatus | undefined,
): WorkstreamLifecycleStatus | undefined {
  if (status === undefined) {
    return undefined;
  }
  return status === 'open' ? 'progress' : status;
}

export function registerTools(
  context: vscode.ExtensionContext,
  store: JournalStore,
  client: ControlPlaneClient | null,
  deps: ToolDeps,
): void {
  const subs: vscode.Disposable[] = [];

  // The workstream tools are backed by the control-plane document store (WM
  // 13.0 "rehome-wm-tools"). Fail clearly if the client is missing rather than
  // silently falling back to the journal DB.
  const requireClient = (): ControlPlaneClient => {
    if (!client) {
      throw new Error(
        'Working Memory control-plane client is unavailable; the daemon may not be running.',
      );
    }
    return client;
  };

  // ----- workstreams (WM 13.0 "ws-consumer-repoint": backed by the
  // control-plane document store via the client's ws-* domain API, NOT the
  // journal DB and NOT the retired src/domain/workstreams.ts shim) -----

  subs.push(
    vscode.lm.registerTool<ListWorkstreamsInput>('wm_list_workstreams', {
      invoke: safe<ListWorkstreamsInput>(async (input) => {
        const all = await requireClient().wsRead({});
        // Preserve the legacy status filter: 'open' means any non-closed
        // lifecycle status; 'closed' means closed; 'all'/undefined means all.
        const rows = all.filter((w) => {
          if (input.status === 'closed') {
            return w.status === 'closed';
          }
          if (input.status === 'open') {
            return w.status !== 'closed';
          }
          return true;
        });
        // NOTE: include_deleted is accepted for shape-compat but is a no-op —
        // the control-plane list returns live documents only.
        // TODO: needs a list-with-deleted path in the document store.
        return { ok: true, count: rows.length, workstreams: rows };
      }),
    }),
    vscode.lm.registerTool<GetWorkstreamInput>('wm_get_workstream', {
      invoke: safe<GetWorkstreamInput>(async (input) => {
        if (!input.slug) {
          // The legacy numeric `id` was the journal rowid; control-plane
          // documents are keyed by uuid + slug, so only slug lookups work now.
          throw new Error(
            input.id !== undefined
              ? 'wm_get_workstream by numeric id is not supported after the control-plane move; pass `slug` instead.'
              : 'one of `slug` or `id` is required',
          );
        }
        const found = await requireClient().wsRead({ slug: input.slug });
        const ws = found[0] ?? null;
        if (!ws) {
          throw new Error(`workstream not found (slug=${input.slug})`);
        }
        // TODO: needs the session/entry/topic domain layers — sessions,
        // total_entries and focused_topics aren't migrated yet, so they're
        // stubbed to preserve the tool's output shape.
        return {
          ok: true,
          workstream: ws,
          sessions: [],
          total_entries: 0,
          focused_topics: [],
        };
      }),
    }),
    vscode.lm.registerTool<CreateWorkstreamToolInput>('wm_create_workstream', {
      invoke: safe<CreateWorkstreamToolInput>(async (input) => {
        const ws = await requireClient().wsCreate({
          slug: input.slug,
          title: input.title,
          status: normalizeLifecycleStatus(input.status),
        });
        // TODO: topic_slug / focused pin a topic to the workstream at creation —
        // needs the topic domain layer; ignored for now (documented no-op), so
        // no topic_link is returned.
        deps.refresh();
        return { ok: true, workstream: ws };
      }),
    }),
    vscode.lm.registerTool<UpdateWorkstreamToolInput>('wm_update_workstream', {
      invoke: safe<UpdateWorkstreamToolInput>(async (input) => {
        const ws = await requireClient().wsUpdate({
          slug: input.slug,
          title: input.title,
          status: normalizeLifecycleStatus(input.status),
          closure: input.closure,
        });
        deps.refresh();
        return { ok: true, workstream: ws };
      }),
    }),
    vscode.lm.registerTool<DeleteWorkstreamInput>('wm_delete_workstream', {
      invoke: safe<DeleteWorkstreamInput>(async (input) => {
        await requireClient().wsDelete({ slug: input.slug });
        deps.refresh();
        // TODO: needs the session/entry domain layers to report a real cascade
        // count. The control-plane delete soft-deletes the workstream document
        // only, so the count is stubbed to preserve the tool's output shape.
        return {
          ok: true,
          soft_deleted: { workstreams: 1, sessions: 0, entries: 0 },
        };
      }),
    }),
    vscode.lm.registerTool<RestoreWorkstreamInput>('wm_restore_workstream', {
      invoke: safe<RestoreWorkstreamInput>(async (input) => {
        await requireClient().wsDelete({ slug: input.slug, restore: true });
        deps.refresh();
        // TODO: mirrors wm_delete_workstream — a real cascade count needs the
        // session/entry domain layers; stubbed to the workstream row only.
        return { ok: true, restored: { workstreams: 1 } };
      }),
    }),
  );

  // ----- sessions -----

  subs.push(
    vscode.lm.registerTool<StartSessionToolInput>('wm_start_session', {
      invoke: safe<StartSessionToolInput>((input) => {
        const row = store.startSession({
          workstream_slug: input.workstream_slug,
          summary: input.summary,
          session_id: input.session_id,
          chat_ref: input.chat_ref,
        });
        deps.refresh();
        return { ok: true, session: row };
      }),
    }),
    vscode.lm.registerTool<EndSessionToolInput>('wm_end_session', {
      invoke: safe<EndSessionToolInput>((input) => {
        const row = store.endSession(input.session_id, input.summary);
        deps.refresh();
        return { ok: true, session: row };
      }),
    }),
    vscode.lm.registerTool<GetSessionInput>('wm_get_session', {
      invoke: safe<GetSessionInput>((input) => {
        const includeDeleted = input.include_deleted ?? false;
        const session = store.getSession(input.session_id, includeDeleted);
        if (!session) {
          throw new Error(`session not found: ${input.session_id}`);
        }
        const entries = store.listEntriesForSession(
          input.session_id,
          includeDeleted,
        );
        return { ok: true, session, entries };
      }),
    }),
    vscode.lm.registerTool<DeleteSessionInput>('wm_delete_session', {
      invoke: safe<DeleteSessionInput>((input) => {
        const counts = store.softDeleteSession(input.session_id);
        deps.refresh();
        return { ok: true, soft_deleted: counts };
      }),
    }),
    vscode.lm.registerTool<RestoreSessionInput>('wm_restore_session', {
      invoke: safe<RestoreSessionInput>((input) => {
        const counts = store.restoreSession(input.session_id);
        deps.refresh();
        return { ok: true, restored: counts };
      }),
    }),
  );

  // ----- entries -----

  subs.push(
    vscode.lm.registerTool<AppendEntryToolInput>('wm_append_entry', {
      invoke: safe<AppendEntryToolInput>((input) => {
        const row = store.appendEntry({
          session_id: input.session_id,
          body: input.body,
          created_by: input.created_by,
          timestamp: input.timestamp,
        });
        deps.refresh();
        return { ok: true, entry: row };
      }),
    }),
    vscode.lm.registerTool<SearchEntriesToolInput>('wm_search_entries', {
      invoke: safe<SearchEntriesToolInput>((input) => {
        if (!input.query || !input.query.trim()) {
          throw new Error('query is required');
        }
        const hits = store.searchEntries({
          query: input.query,
          workstream_slug: input.workstream_slug,
          limit: input.limit,
        });
        return { ok: true, count: hits.length, hits };
      }),
    }),
    vscode.lm.registerTool<DeleteEntryInput>('wm_delete_entry', {
      invoke: safe<DeleteEntryInput>((input) => {
        const counts = store.softDeleteEntry(input.entry_id);
        deps.refresh();
        return { ok: true, soft_deleted: counts };
      }),
    }),
    vscode.lm.registerTool<RestoreEntryInput>('wm_restore_entry', {
      invoke: safe<RestoreEntryInput>((input) => {
        const counts = store.restoreEntry(input.entry_id);
        deps.refresh();
        return { ok: true, restored: counts };
      }),
    }),
  );

  // ----- topics -----

  subs.push(
    vscode.lm.registerTool<ListTopicsInput>('wm_list_topics', {
      invoke: safe<ListTopicsInput>(async (input) => {
        // Backed by the control-plane document store (WM 13.0
        // "topic-consumer-repoint"): topics-of-a-workstream is the
        // `spec.workstreams` membership filter.
        let rows = await requireClient().topicRead(
          input.workstream_slug ? { workstream: input.workstream_slug } : {},
        );
        if (input.status && input.status !== 'all') {
          rows = rows.filter((t) => t.status === input.status);
        }
        if (input.topic_type !== undefined) {
          rows = rows.filter((t) => t.topicType === input.topic_type);
        }
        // NOTE: include_deleted is accepted for shape-compat but a no-op — the
        // control-plane list returns live topics only.
        // TODO: needs a list-with-deleted path in the document store.
        return { ok: true, count: rows.length, topics: rows };
      }),
    }),
    vscode.lm.registerTool<GetTopicInput>('wm_get_topic', {
      invoke: safe<GetTopicInput>(async (input) => {
        const client = requireClient();
        const found = await client.topicRead({ slug: input.slug });
        const topic = found[0] ?? null;
        if (!topic) {
          // NOTE: include_deleted has no control-plane equivalent on read, so a
          // soft-deleted topic won't resolve here (no-op flag).
          throw new Error(`topic not found: ${input.slug}`);
        }
        // Resolve parents/children from the full topic list: parents are this
        // topic's `parents` slugs; children are topics whose `parents` include
        // this slug. One list read backs both.
        const all = await client.topicRead({});
        const bySlug = new Map(all.map((t) => [t.slug ?? '', t]));
        const parents = topic.parents
          .map((s) => bySlug.get(s))
          .filter((t): t is ControlPlaneTopic => Boolean(t))
          .map(topicSummary);
        const children = all
          .filter((t) => t.parents.includes(input.slug))
          .map(topicSummary);
        return {
          ok: true,
          topic,
          // Membership is a flat slug list on the control-plane topic.
          workstream_count: topic.workstreams.length,
          workstreams: topic.workstreams,
          // TODO: entry↔topic linking is still journal-backed (DEFERRED) — a
          // control-plane topic carries no entry rollup, so entries/entry_count
          // are stubbed to preserve the tool's output shape.
          entry_count: 0,
          entries: [],
          parents,
          children,
          // TODO: per-workstream topic focus has no control-plane equivalent yet
          // (DEFERRED) — always empty.
          focused_in_workstreams: [],
        };
      }),
    }),
    vscode.lm.registerTool<CreateTopicToolInput>('wm_create_topic', {
      invoke: safe<CreateTopicToolInput>(async (input) => {
        let resolvedBody = input.body;
        let reshapeWarning: string | undefined;

        if (input.topic_type) {
          const typeRow = store.getTopicType(input.topic_type);
          if (typeRow && typeRow.body_template.trim()) {
            const template = typeRow.body_template.trim();
            if (!input.body?.trim()) {
              // No body provided — store template literally; user edits later.
              resolvedBody = template;
            } else {
              // Body provided — reshape via LLM.
              try {
                const reshaped = await reshapeTopicBody({
                  template,
                  body: input.body,
                  title: input.title ?? input.slug,
                  typeLabel: typeRow.label,
                  typeDescription: typeRow.description,
                });
                // Validate: if LLM dropped more than half the template's H2 headers, fall back.
                const templateHeaders = extractH2Headers(template);
                if (templateHeaders.length > 0) {
                  const reshapedHeaders = extractH2Headers(reshaped);
                  const missing = templateHeaders.filter(
                    (h) => !reshapedHeaders.includes(h),
                  );
                  if (missing.length * 2 > templateHeaders.length) {
                    reshapeWarning = `Body reshaping dropped ${missing.length}/${templateHeaders.length} template sections; stored original body with template prefix.`;
                    resolvedBody = `${template}\n\n## Original input\n\n${input.body}`;
                  } else {
                    resolvedBody = reshaped;
                  }
                } else {
                  resolvedBody = reshaped;
                }
              } catch (err) {
                reshapeWarning = `Body reshaping failed: ${err instanceof Error ? err.message : String(err)}; stored original body with template prefix.`;
                resolvedBody = `${template}\n\n## Original input\n\n${input.body}`;
              }
            }
          }
        }

        const parents =
          input.parent_slug === undefined
            ? undefined
            : Array.isArray(input.parent_slug)
              ? input.parent_slug
              : [input.parent_slug];
        // Membership + parents are created natively on the control-plane topic
        // (WM 13.0 "topic-consumer-repoint").
        // TODO: `focused` (workstream focus pin) and `entry_id` (entry↔topic
        // link) at creation are journal-only concepts (DEFERRED) — ignored here.
        const topic = await requireClient().topicCreate({
          slug: input.slug,
          title: input.title ?? humanizeSlug(input.slug),
          body: resolvedBody,
          status: input.status,
          topicType: input.topic_type,
          workstreams: input.workstream_slug ? [input.workstream_slug] : undefined,
          parents,
        });
        deps.refresh();
        return reshapeWarning
          ? { ok: true, topic, reshape_warning: reshapeWarning }
          : { ok: true, topic };
      }),
    }),
    vscode.lm.registerTool<UpdateTopicToolInput>('wm_update_topic', {
      invoke: safe<UpdateTopicToolInput>(async (input) => {
        const topic = await requireClient().topicUpdate({
          slug: input.slug,
          title: input.title,
          body: input.body,
          status: input.status,
          topicType: input.topic_type,
        });
        deps.refresh();
        return { ok: true, topic };
      }),
    }),
    vscode.lm.registerTool<DeleteTopicInput>('wm_delete_topic', {
      invoke: safe<DeleteTopicInput>(async (input) => {
        await requireClient().topicDelete({ slug: input.slug });
        deps.refresh();
        // TODO: cascade counts (workstream_links / entry_links) need the entry
        // domain layer; the control-plane delete soft-deletes the topic document
        // only, so counts are stubbed to preserve the tool's output shape.
        return {
          ok: true,
          soft_deleted: { topics: 1, workstream_links: 0, entry_links: 0 },
        };
      }),
    }),
    vscode.lm.registerTool<RestoreTopicInput>('wm_restore_topic', {
      invoke: safe<RestoreTopicInput>(async (input) => {
        await requireClient().topicDelete({ slug: input.slug, restore: true });
        deps.refresh();
        // TODO: mirrors wm_delete_topic — real cascade counts need the entry
        // domain layer; stubbed to the topic row only.
        return {
          ok: true,
          restored: { topics: 1, workstream_links: 0, entry_links: 0 },
        };
      }),
    }),
    vscode.lm.registerTool<LinkWorkstreamTopicToolInput>(
      'wm_link_workstream_topic',
      {
        invoke: safe<LinkWorkstreamTopicToolInput>(async (input) => {
          // Membership add via the control-plane topic's `spec.workstreams`
          // (WM 13.0 "topic-consumer-repoint").
          // TODO: graph TRAVERSAL (attach a topic + its family) and the per-link
          // `focused` pin have no control-plane equivalent yet (DEFERRED) — the
          // `traversal` / `focused` inputs are ignored; this is a plain attach.
          const topic = await requireClient().topicAttachWorkstream({
            slug: input.topic_slug,
            workstream: input.workstream_slug,
          });
          deps.refresh();
          return { ok: true, topic };
        }),
      },
    ),
    vscode.lm.registerTool<LinkWorkstreamTopicToolInput>(
      'wm_unlink_workstream_topic',
      {
        invoke: safe<LinkWorkstreamTopicToolInput>(async (input) => {
          const topic = await requireClient().topicDetachWorkstream({
            slug: input.topic_slug,
            workstream: input.workstream_slug,
          });
          deps.refresh();
          return { ok: true, topic };
        }),
      },
    ),
    // DEFERRED (WM 13.0 "topic-consumer-repoint"): entry↔topic linking stays
    // journal-backed — entries are still journal rows, so these only resolve
    // legacy journal topics (an accepted cross-store seam until the entry/session
    // repoint). store.linkEntryTopic auto-creates a journal topic stub for an
    // unknown slug, so the normal path never throws.
    vscode.lm.registerTool<LinkEntryTopicToolInput>('wm_link_entry_topic', {
      invoke: safe<LinkEntryTopicToolInput>((input) => {
        const result = store.linkEntryTopic({
          entry_id: input.entry_id,
          topic_slug: input.topic_slug,
        });
        deps.refresh();
        return { ok: true, link: result };
      }),
    }),
    vscode.lm.registerTool<LinkEntryTopicToolInput>('wm_unlink_entry_topic', {
      invoke: safe<LinkEntryTopicToolInput>((input) => {
        const result = store.unlinkEntryTopic({
          entry_id: input.entry_id,
          topic_slug: input.topic_slug,
        });
        deps.refresh();
        return { ok: true, unlink: result };
      }),
    }),
    vscode.lm.registerTool<TopicParentLinkInput>('wm_link_topic_parent', {
      invoke: safe<TopicParentLinkInput>(async (input) => {
        if (!input.child_slug || !input.parent_slug) {
          throw new Error('child_slug and parent_slug are required');
        }
        // Parents are the control-plane topic's `spec.parents` slug array (WM
        // 13.0 "topic-consumer-repoint"): read, merge, CAS-update.
        // TODO: no cycle detection on the control-plane path yet; the panel tree
        // walk is depth-guarded so a stray cycle can't hang rendering.
        const client = requireClient();
        const found = await client.topicRead({ slug: input.child_slug });
        const child = found[0];
        if (!child) {
          throw new Error(`topic not found: ${input.child_slug}`);
        }
        const already = child.parents.includes(input.parent_slug);
        const topic = already
          ? child
          : await client.topicUpdate({
              slug: input.child_slug,
              parents: [...child.parents, input.parent_slug],
            });
        deps.refresh();
        return {
          ok: true,
          topic,
          link: {
            child_slug: input.child_slug,
            parent_slug: input.parent_slug,
            link_created: !already,
          },
        };
      }),
    }),
    vscode.lm.registerTool<TopicParentLinkInput>('wm_unlink_topic_parent', {
      invoke: safe<TopicParentLinkInput>(async (input) => {
        if (!input.child_slug || !input.parent_slug) {
          throw new Error('child_slug and parent_slug are required');
        }
        const client = requireClient();
        const found = await client.topicRead({ slug: input.child_slug });
        const child = found[0];
        if (!child) {
          throw new Error(`topic not found: ${input.child_slug}`);
        }
        const had = child.parents.includes(input.parent_slug);
        const topic = had
          ? await client.topicUpdate({
              slug: input.child_slug,
              parents: child.parents.filter((p) => p !== input.parent_slug),
            })
          : child;
        deps.refresh();
        return {
          ok: true,
          topic,
          removed: had ? 1 : 0,
          unlink: {
            child_slug: input.child_slug,
            parent_slug: input.parent_slug,
            removed: had ? 1 : 0,
          },
        };
      }),
    }),
    vscode.lm.registerTool<Record<string, never>>('wm_list_topic_types', {
      invoke: safe<Record<string, never>>(() => {
        const rows = store.listTopicTypes();
        return { ok: true, count: rows.length, topic_types: rows };
      }),
    }),
    vscode.lm.registerTool<CreateTopicTypeInput>('wm_create_topic_type', {
      invoke: safe<CreateTopicTypeInput>((input) => {
        if (!input.id || !input.label || !input.icon || !input.description) {
          throw new Error('id, label, icon, and description are required');
        }
        const row = store.createTopicType({
          id: input.id,
          label: input.label,
          icon: input.icon,
          description: input.description,
        });
        deps.refresh();
        return { ok: true, topic_type: row };
      }),
    }),
    vscode.lm.registerTool<GetTopicTypeInput>('wm_get_topic_type', {
      invoke: safe<GetTopicTypeInput>((input) => {
        if (!input.id) {
          throw new Error('id is required');
        }
        const row = store.getTopicType(input.id);
        if (!row) {
          throw new Error(`topic type not found: ${input.id}`);
        }
        return { ok: true, topic_type: row, topic_count: row.topic_count };
      }),
    }),
    vscode.lm.registerTool<UpdateTopicTypeInput>('wm_update_topic_type', {
      invoke: safe<UpdateTopicTypeInput>((input) => {
        if (!input.id) {
          throw new Error('id is required');
        }
        const row = store.updateTopicType(input.id, {
          label: input.label,
          icon: input.icon,
          description: input.description,
          body_template: input.body_template,
        });
        deps.refresh();
        return { ok: true, topic_type: row };
      }),
    }),
    vscode.lm.registerTool<DeleteTopicTypeInput>('wm_delete_topic_type', {
      invoke: safe<DeleteTopicTypeInput>((input) => {
        if (!input.id) {
          throw new Error('id is required');
        }
        if ((JournalStore.SEEDED_TOPIC_TYPE_IDS as readonly string[]).includes(input.id)) {
          throw new Error(
            `cannot delete seeded topic type: ${input.id} (protected: ${JournalStore.SEEDED_TOPIC_TYPE_IDS.join(', ')})`,
          );
        }
        const deleted = store.deleteTopicType(input.id);
        deps.refresh();
        return { ok: true, id: input.id, ...deleted };
      }),
    }),
    vscode.lm.registerTool<GetPanelDataInput>('wm_get_panel_data', {
      invoke: safe<GetPanelDataInput>(async (input) => {
        const tab = input?.tab ?? 'all';
        // Topics are control-plane-sourced (WM 13.0 "topic-consumer-repoint").
        // The rest of this agent-facing tool's panel data stays journal-sourced
        // here (active/archive remain a known mixed-source seam on this tool);
        // when the control-plane client is absent we fall back to the journal
        // topics assembled by getAllPanelData / getPanelData.
        const controlPlaneTopics = async (): Promise<PanelData> => {
          const topics = await requireClient().topicRead({});
          return buildTopicsPanel({ available: true, topics, store });
        };
        if (tab === 'all') {
          const data = getAllPanelData(store);
          if (client) {
            data.topics = await controlPlaneTopics();
          }
          return { ok: true, tab, data };
        }
        if (
          tab !== 'active' &&
          tab !== 'archive' &&
          tab !== 'topics' &&
          tab !== 'topic-types'
        ) {
          throw new Error(
            `invalid tab '${String(tab)}' — must be one of 'active' | 'archive' | 'topics' | 'topic-types' | 'all'`,
          );
        }
        if (tab === 'topics' && client) {
          return { ok: true, tab, data: await controlPlaneTopics() };
        }
        return { ok: true, tab, data: getPanelData(store, tab as PanelTab) };
      }),
    }),
  );

  // ----- alerts (self-contained feature; single toggle in src/alerts) -----
  registerAlertsFeature({ context, store, deps: { refresh: deps.refresh } });

  // ----- nanites (self-contained feature; single toggle in src/nanites) -----
  registerNanitesFeature({ context, store, deps: { refresh: deps.refresh } });

  context.subscriptions.push(...subs);
}
