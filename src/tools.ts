import * as vscode from 'vscode';
import {
  addTopicParent,
  appendEntry,
  createTopic,
  createWorkstream,
  endSession,
  getSession,
  getTopic,
  getWorkstreamBySlug,
  getWorkstreamById,
  isDbOpen,
  linkEntryTopic,
  linkWorkstreamTopic,
  listEntriesForSession,
  listEntriesForTopic,
  listSessionsForWorkstream,
  listTopics,
  listTopicChildren,
  listTopicParents,
  listWorkstreams,
  listWorkstreamsForTopic,
  removeTopicParent,
  searchEntries,
  softDeleteEntry,
  softDeleteSession,
  softDeleteTopic,
  softDeleteWorkstream,
  startSession,
  unlinkEntryTopic,
  unlinkWorkstreamTopic,
  updateTopic,
  updateWorkstream,
  type Topic,
  type TopicStatus,
  type TopicTypeId,
} from './db';

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
): (options: vscode.LanguageModelToolInvocationOptions<TInput>) =>
  Promise<vscode.LanguageModelToolResult> {
  return async (options) => {
    if (!isDbOpen()) {
      return errorResult(
        'journal DB is not open — open the hub workspace (folder containing AGENTS.md and memory/) and reload the window',
      );
    }
    try {
      const out = handler(options.input);
      return jsonResult(out);
    } catch (err) {
      return errorResult(err instanceof Error ? err.message : String(err));
    }
  };
}

// ---------------------------------------------------------------------------
// Input interfaces
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

// ----- topics -----

interface ListTopicsInput {
  status?: TopicStatus | 'all';
  include_deleted?: boolean;
  workstream_slug?: string;
  topic_type?: TopicTypeId;
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
  topic_type?: TopicTypeId;
}
interface UpdateTopicToolInput {
  slug: string;
  title?: string;
  body?: string;
  status?: TopicStatus;
  topic_type?: TopicTypeId;
}
interface DeleteTopicInput {
  slug: string;
}
interface LinkWorkstreamTopicToolInput {
  workstream_slug: string;
  topic_slug: string;
}
interface LinkEntryTopicToolInput {
  entry_id: number;
  topic_slug: string;
}
interface TopicParentLinkInput {
  child_slug: string;
  parent_slug: string;
}

function topicSummary(t: Topic): { slug: string; title: string; status: TopicStatus } {
  return { slug: t.slug, title: t.title, status: t.status };
}

export function registerTools(
  context: vscode.ExtensionContext,
  deps: ToolDeps,
): void {
  const subs: vscode.Disposable[] = [];

  // ----- workstreams -----

  subs.push(
    vscode.lm.registerTool<ListWorkstreamsInput>('wm_list_workstreams', {
      invoke: safe<ListWorkstreamsInput>((input) => {
        const rows = listWorkstreams({
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
          ws = getWorkstreamBySlug(input.slug, includeDeleted);
        } else if (typeof input.id === 'number') {
          ws = getWorkstreamById(input.id, includeDeleted);
        } else {
          throw new Error('one of `slug` or `id` is required');
        }
        if (!ws) {
          throw new Error(
            `workstream not found (slug=${input.slug ?? '∅'}, id=${input.id ?? '∅'})`,
          );
        }
        const sessions = listSessionsForWorkstream(ws.id, includeDeleted).map(
          (s) => ({
            session_id: s.session_id,
            started_at: s.started_at,
            ended_at: s.ended_at,
            summary: s.summary,
            entry_count: listEntriesForSession(s.session_id, includeDeleted)
              .length,
            deleted_at: s.deleted_at,
          }),
        );
        const total_entries = sessions.reduce((n, s) => n + s.entry_count, 0);
        return { ok: true, workstream: ws, sessions, total_entries };
      }),
    }),
    vscode.lm.registerTool<CreateWorkstreamToolInput>('wm_create_workstream', {
      invoke: safe<CreateWorkstreamToolInput>((input) => {
        const row = createWorkstream({
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
        const row = updateWorkstream(input.slug, {
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
        const counts = softDeleteWorkstream(input.slug);
        deps.refresh();
        return { ok: true, soft_deleted: counts };
      }),
    }),
  );

  // ----- sessions -----

  subs.push(
    vscode.lm.registerTool<StartSessionToolInput>('wm_start_session', {
      invoke: safe<StartSessionToolInput>((input) => {
        const row = startSession({
          workstream_slug: input.workstream_slug,
          summary: input.summary,
          session_id: input.session_id,
        });
        deps.refresh();
        return { ok: true, session: row };
      }),
    }),
    vscode.lm.registerTool<EndSessionToolInput>('wm_end_session', {
      invoke: safe<EndSessionToolInput>((input) => {
        const row = endSession(input.session_id, input.summary);
        deps.refresh();
        return { ok: true, session: row };
      }),
    }),
    vscode.lm.registerTool<GetSessionInput>('wm_get_session', {
      invoke: safe<GetSessionInput>((input) => {
        const includeDeleted = input.include_deleted ?? false;
        const session = getSession(input.session_id, includeDeleted);
        if (!session) {
          throw new Error(`session not found: ${input.session_id}`);
        }
        const entries = listEntriesForSession(
          input.session_id,
          includeDeleted,
        );
        return { ok: true, session, entries };
      }),
    }),
    vscode.lm.registerTool<DeleteSessionInput>('wm_delete_session', {
      invoke: safe<DeleteSessionInput>((input) => {
        const counts = softDeleteSession(input.session_id);
        deps.refresh();
        return { ok: true, soft_deleted: counts };
      }),
    }),
  );

  // ----- entries -----

  subs.push(
    vscode.lm.registerTool<AppendEntryToolInput>('wm_append_entry', {
      invoke: safe<AppendEntryToolInput>((input) => {
        const row = appendEntry({
          session_id: input.session_id,
          body: input.body,
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
        const hits = searchEntries({
          query: input.query,
          workstream_slug: input.workstream_slug,
          limit: input.limit,
        });
        return { ok: true, count: hits.length, hits };
      }),
    }),
    vscode.lm.registerTool<DeleteEntryInput>('wm_delete_entry', {
      invoke: safe<DeleteEntryInput>((input) => {
        const counts = softDeleteEntry(input.entry_id);
        deps.refresh();
        return { ok: true, soft_deleted: counts };
      }),
    }),
  );

  // ----- topics -----

  subs.push(
    vscode.lm.registerTool<ListTopicsInput>('wm_list_topics', {
      invoke: safe<ListTopicsInput>((input) => {
        const rows = listTopics({
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
        const topic = getTopic(input.slug, includeDeleted);
        if (!topic) {
          throw new Error(`topic not found: ${input.slug}`);
        }
        const workstreams = listWorkstreamsForTopic(input.slug);
        const entries = listEntriesForTopic(input.slug, 25);
        const parents = listTopicParents(input.slug).map(topicSummary);
        const children = listTopicChildren(input.slug).map(topicSummary);
        return {
          ok: true,
          topic,
          workstream_count: workstreams.length,
          entry_count: entries.length,
          workstreams,
          entries,
          parents,
          children,
        };
      }),
    }),
    vscode.lm.registerTool<CreateTopicToolInput>('wm_create_topic', {
      invoke: safe<CreateTopicToolInput>((input) => {
        const row = createTopic({
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
        const row = updateTopic(input.slug, {
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
        const counts = softDeleteTopic(input.slug);
        deps.refresh();
        return { ok: true, soft_deleted: counts };
      }),
    }),
    vscode.lm.registerTool<LinkWorkstreamTopicToolInput>(
      'wm_link_workstream_topic',
      {
        invoke: safe<LinkWorkstreamTopicToolInput>((input) => {
          const result = linkWorkstreamTopic({
            workstream_slug: input.workstream_slug,
            topic_slug: input.topic_slug,
          });
          deps.refresh();
          return { ok: true, link: result };
        }),
      },
    ),
    vscode.lm.registerTool<LinkWorkstreamTopicToolInput>(
      'wm_unlink_workstream_topic',
      {
        invoke: safe<LinkWorkstreamTopicToolInput>((input) => {
          const result = unlinkWorkstreamTopic({
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
        const result = linkEntryTopic({
          entry_id: input.entry_id,
          topic_slug: input.topic_slug,
        });
        deps.refresh();
        return { ok: true, link: result };
      }),
    }),
    vscode.lm.registerTool<LinkEntryTopicToolInput>('wm_unlink_entry_topic', {
      invoke: safe<LinkEntryTopicToolInput>((input) => {
        const result = unlinkEntryTopic({
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
        const result = addTopicParent(input.child_slug, input.parent_slug);
        deps.refresh();
        return { ok: true, link: result };
      }),
    }),
    vscode.lm.registerTool<TopicParentLinkInput>('wm_unlink_topic_parent', {
      invoke: safe<TopicParentLinkInput>((input) => {
        if (!input.child_slug || !input.parent_slug) {
          throw new Error('child_slug and parent_slug are required');
        }
        const result = removeTopicParent(input.child_slug, input.parent_slug);
        deps.refresh();
        return { ok: true, removed: result.removed, unlink: result };
      }),
    }),
  );

  context.subscriptions.push(...subs);
}
