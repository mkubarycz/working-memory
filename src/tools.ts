import * as vscode from 'vscode';
import {
  getAllPanelData,
  getPanelData,
  type PanelTab,
} from './panelData';
import { JournalStore, type Topic, type TopicStatus } from './db';
import {
  type TraversalModeId,
} from './graphTraversals';
import { linkWorkstreamTopicWithTraversal } from './topicWorkstreamAttach';

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
  handler: (input: TInput) => unknown,
): (
  options: vscode.LanguageModelToolInvocationOptions<TInput>,
) => Promise<vscode.LanguageModelToolResult> {
  return async (options) => {
    try {
      const out = handler(options.input);
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
  status?: 'open' | 'closed';
}
interface UpdateWorkstreamToolInput {
  slug: string;
  title?: string;
  status?: 'open' | 'closed';
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
  description?: string;
}
interface DeleteTopicTypeInput {
  id: string;
}
interface GetPanelDataInput {
  tab?: 'active' | 'archive' | 'topics' | 'topic-types' | 'all';
}

function topicSummary(
  t: Topic,
): { slug: string; title: string; status: TopicStatus } {
  return { slug: t.slug, title: t.title, status: t.status };
}

export function registerTools(
  context: vscode.ExtensionContext,
  store: JournalStore,
  deps: ToolDeps,
): void {
  const subs: vscode.Disposable[] = [];

  // ----- workstreams -----

  subs.push(
    vscode.lm.registerTool<ListWorkstreamsInput>('wm_list_workstreams', {
      invoke: safe<ListWorkstreamsInput>((input) => {
        const rows = store.listWorkstreams({
          status: input.status,
          includeDeleted: input.include_deleted ?? false,
        });
        return { ok: true, count: rows.length, workstreams: rows };
      }),
    }),
    vscode.lm.registerTool<GetWorkstreamInput>('wm_get_workstream', {
      invoke: safe<GetWorkstreamInput>((input) => {
        const includeDeleted = input.include_deleted ?? false;
        let ws = null;
        if (input.slug) {
          ws = store.getWorkstreamBySlug(input.slug, includeDeleted);
        } else if (typeof input.id === 'number') {
          ws = store.getWorkstreamById(input.id, includeDeleted);
        } else {
          throw new Error('one of `slug` or `id` is required');
        }
        if (!ws) {
          throw new Error(
            `workstream not found (slug=${input.slug ?? '∅'}, id=${input.id ?? '∅'})`,
          );
        }
        const sessions = store
          .listSessionsForWorkstream(ws.id, includeDeleted)
          .map((s) => ({
            session_id: s.session_id,
            started_at: s.started_at,
            ended_at: s.ended_at,
            summary: s.summary,
            entry_count: store.listEntriesForSession(
              s.session_id,
              includeDeleted,
            ).length,
            deleted_at: s.deleted_at,
          }));
        const total_entries = sessions.reduce((n, s) => n + s.entry_count, 0);
        const focused_topics = store
          .listTopicsForWorkstream(ws.id)
          .filter((t) => t.focused === 1)
          .map((t) => ({
            slug: t.slug,
            title: t.title,
            status: t.status,
            linked_at: t.linked_at,
          }));
        return {
          ok: true,
          workstream: ws,
          sessions,
          total_entries,
          focused_topics,
        };
      }),
    }),
    vscode.lm.registerTool<CreateWorkstreamToolInput>('wm_create_workstream', {
      invoke: safe<CreateWorkstreamToolInput>((input) => {
        const row = store.createWorkstream({
          slug: input.slug,
          title: input.title,
          status: input.status,
        });
        deps.refresh();
        return { ok: true, workstream: row };
      }),
    }),
    vscode.lm.registerTool<UpdateWorkstreamToolInput>('wm_update_workstream', {
      invoke: safe<UpdateWorkstreamToolInput>((input) => {
        const row = store.updateWorkstream(input.slug, {
          title: input.title,
          status: input.status,
          closure: input.closure,
        });
        deps.refresh();
        return { ok: true, workstream: row };
      }),
    }),
    vscode.lm.registerTool<DeleteWorkstreamInput>('wm_delete_workstream', {
      invoke: safe<DeleteWorkstreamInput>((input) => {
        const counts = store.softDeleteWorkstream(input.slug);
        deps.refresh();
        return { ok: true, soft_deleted: counts };
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
  );

  // ----- topics -----

  subs.push(
    vscode.lm.registerTool<ListTopicsInput>('wm_list_topics', {
      invoke: safe<ListTopicsInput>((input) => {
        const rows = store.listTopics({
          status: input.status,
          includeDeleted: input.include_deleted ?? false,
          workstreamSlug: input.workstream_slug,
          topicType: input.topic_type,
        });
        return { ok: true, count: rows.length, topics: rows };
      }),
    }),
    vscode.lm.registerTool<GetTopicInput>('wm_get_topic', {
      invoke: safe<GetTopicInput>((input) => {
        const includeDeleted = input.include_deleted ?? false;
        const topic = store.getTopic(input.slug, includeDeleted);
        if (!topic) {
          throw new Error(`topic not found: ${input.slug}`);
        }
        const workstreams = store.listWorkstreamsForTopic(input.slug);
        const entries = store.listEntriesForTopic(input.slug, 25);
        const parents = store.listTopicParents(input.slug).map(topicSummary);
        const children = store.listTopicChildren(input.slug).map(topicSummary);
        const focused_in_workstreams = workstreams
          .filter((w) => w.focused === 1)
          .map((w) => ({
            slug: w.workstream_slug,
            title: w.workstream_title,
          }));
        return {
          ok: true,
          topic,
          workstream_count: workstreams.length,
          entry_count: entries.length,
          workstreams,
          entries,
          parents,
          children,
          focused_in_workstreams,
        };
      }),
    }),
    vscode.lm.registerTool<CreateTopicToolInput>('wm_create_topic', {
      invoke: safe<CreateTopicToolInput>((input) => {
        const row = store.createTopic({
          slug: input.slug,
          title: input.title,
          body: input.body,
          status: input.status,
          topic_type: input.topic_type,
        });
        deps.refresh();
        return { ok: true, topic: row };
      }),
    }),
    vscode.lm.registerTool<UpdateTopicToolInput>('wm_update_topic', {
      invoke: safe<UpdateTopicToolInput>((input) => {
        const row = store.updateTopic(input.slug, {
          title: input.title,
          body: input.body,
          status: input.status,
          topic_type: input.topic_type,
        });
        deps.refresh();
        return { ok: true, topic: row };
      }),
    }),
    vscode.lm.registerTool<DeleteTopicInput>('wm_delete_topic', {
      invoke: safe<DeleteTopicInput>((input) => {
        const counts = store.softDeleteTopic(input.slug);
        deps.refresh();
        return { ok: true, soft_deleted: counts };
      }),
    }),
    vscode.lm.registerTool<LinkWorkstreamTopicToolInput>(
      'wm_link_workstream_topic',
      {
        invoke: safe<LinkWorkstreamTopicToolInput>((input) => {
          const result = linkWorkstreamTopicWithTraversal(store, input);
          deps.refresh();
          return {
            ok: true,
            ...result,
          };
        }),
      },
    ),
    vscode.lm.registerTool<LinkWorkstreamTopicToolInput>(
      'wm_unlink_workstream_topic',
      {
        invoke: safe<LinkWorkstreamTopicToolInput>((input) => {
          const result = store.unlinkWorkstreamTopic({
            workstream_slug: input.workstream_slug,
            topic_slug: input.topic_slug,
          });
          deps.refresh();
          return { ok: true, unlink: result };
        }),
      },
    ),
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
      invoke: safe<TopicParentLinkInput>((input) => {
        if (!input.child_slug || !input.parent_slug) {
          throw new Error('child_slug and parent_slug are required');
        }
        const result = store.addTopicParent(
          input.child_slug,
          input.parent_slug,
        );
        deps.refresh();
        return { ok: true, link: result };
      }),
    }),
    vscode.lm.registerTool<TopicParentLinkInput>('wm_unlink_topic_parent', {
      invoke: safe<TopicParentLinkInput>((input) => {
        if (!input.child_slug || !input.parent_slug) {
          throw new Error('child_slug and parent_slug are required');
        }
        const result = store.removeTopicParent(
          input.child_slug,
          input.parent_slug,
        );
        deps.refresh();
        return { ok: true, removed: result.removed, unlink: result };
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
          description: input.description,
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
      invoke: safe<GetPanelDataInput>((input) => {
        const tab = input?.tab ?? 'all';
        if (tab === 'all') {
          return { ok: true, tab, data: getAllPanelData(store) };
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
        return { ok: true, tab, data: getPanelData(store, tab as PanelTab) };
      }),
    }),
  );

  context.subscriptions.push(...subs);
}
