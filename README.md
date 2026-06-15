# working-memory

A VS Code extension that surfaces Michael's journal database as a left-rail
tree view inside the hub workspace, and exposes the journal as MCP
language-model tools (`wm_*`) so agents can read and append entries
directly.

**What's in the box (current):**

- Opens / creates a SQLite DB at `<hub-workspace>/memory/journal.sqlite`
  (via Node 22's built-in `node:sqlite`).
- Applies tracked schema migrations from `schema/NNN_*.sql` on activation
  (see *Schema migrations* below).
- Activity-bar container with two tree views: **Active** (open
  workstreams) and **Archive** (closed). Workstream nodes expand to a
  `Topics` group; clicking a workstream or topic opens its virtual
  markdown doc.
- ~29 MCP tools (`wm_list_workstreams`, `wm_append_entry`,
  `wm_search_entries`, `wm_link_entry_topic`, …) for agent-driven
  journaling.
- FTS5 search over entry bodies, soft-delete across workstreams /
  sessions / entries / topics / link rows, and topic M:N links to both
  workstreams and entries.

---

## Build

```bash
npm install
npm run compile           # tsc -p .  →  out/src/extension.js, out/scripts/seed.js
```

Watch mode while iterating:

```bash
npm run watch
```

## Seed the DB

```bash
npm run seed              # idempotent; only inserts when workstreams is empty
```

To re-seed from scratch, delete the DB first:

```bash
rm ../../memory/journal.sqlite*   # .sqlite, -wal, -shm
npm run seed
```

The script resolves the DB path **relative to its own location**:
`<hub>/projects/working-memory/scripts/seed.ts` → `<hub>/memory/journal.sqlite`.
That makes it safe to run from any cwd as long as the project lives at
`<hub>/projects/working-memory/`.

## DB path resolution (extension)

On activation the extension looks at every open workspace folder and picks the
first one that contains **both** `AGENTS.md` and a `memory/` directory. The DB
lives at `<that folder>/memory/journal.sqlite`. If no folder qualifies, the
extension surfaces an error toast and the tree stays empty — open the hub
workspace and run **Working Memory: Refresh** (or reload the window).

## Run the extension locally

Two options.

### A. Extension Development Host (recommended while iterating)

1. Open `/Users/mkubarycz/Documents/kubarycz-agentic-workspace/projects/working-memory/`
   in VS Code.
2. Press `F5` (or **Run → Start Debugging**). A second VS Code window opens
   with the extension loaded.
3. In that window, open the multi-root workspace
   `kubarycz-agentic-workspace.code-workspace` so the hub folder is present.
4. Click the brain icon in the activity bar → see the seeded workstreams.

### B. Install the packaged `.vsix`

```bash
npm run package                                    # produces working-memory-0.1.0.vsix
code --install-extension working-memory-0.1.0.vsix
# then reload the window
```

## Chat link patterns

VS Code's Copilot Chat panel only linkifies a narrow set of URI forms in
assistant output. Custom schemes (`working-memory:`) are stripped, and
`command:` URIs require trusted markdown — a privilege not granted to
assistant-rendered links. The form that survives is VS Code's own
extension deep-link scheme: **`vscode://<publisher>.<extension>/...`**.

The extension registers a URI handler for
`vscode://kubarycz.working-memory/open/<kind>/<id>`, where:

- `<kind>` ∈ `session | topic | workstream`
- `<id>` is the session uuid or the topic/workstream slug

| Kind | Markdown shape | Example |
|---|---|---|
| Session | `[label](vscode://kubarycz.working-memory/open/session/<uuid>)` | `[chat session](vscode://kubarycz.working-memory/open/session/de55954a-d717-4b5f-9aa5-dc2513ba6f71)` |
| Topic | `[label](vscode://kubarycz.working-memory/open/topic/<slug>)` | `[chat-clickable-links](vscode://kubarycz.working-memory/open/topic/chat-clickable-links)` |
| Workstream | `[label](vscode://kubarycz.working-memory/open/workstream/<slug>)` | `[topic-types](vscode://kubarycz.working-memory/open/workstream/topic-types)` |

Slugs containing reserved characters should be URI-encoded (the handler
calls `decodeURIComponent` on the id). Unknown slugs/uuids fall through
to the content provider, which renders its own not-found body (parity
with clicking a stale row in the panel). Malformed paths surface a
single error notification — no extension crash.

### Palette + `command:` parity

The same four `working-memory.open*` commands also exist for use from
the Command Palette (`Working Memory: Open Session / Topic / Workstream`)
and from trusted markdown contexts. If you control a `MarkdownString`
with `isTrusted = true` (e.g. a hover, a chat participant), you can
still use:

```
[label]\(command:working-memory.openTopic?%5B%22<slug>%22%5D\)
```

The `?...` payload is `encodeURIComponent(JSON.stringify([id]))`. The
deep-link form above is preferred for chat because it does not require
trust.

## Recovery

If you (or an agent acting on your behalf) accidentally soft-deleted a
workstream, session, entry, or topic, use the `wm_restore_*` tools to undo
the delete **without writing SQL by hand**.

Each tool restores only the individual record — child records remain
soft-deleted and must be restored individually.

| Soft-deleted | Restore tool |
|---|---|
| Workstream | `wm_restore_workstream` |
| Session | `wm_restore_session` |
| Entry | `wm_restore_entry` |
| Topic | `wm_restore_topic` |

### Typical recovery flow

```
# Restore a soft-deleted workstream:
wm_restore_workstream { "slug": "my-workstream" }

# Restore a specific session:
wm_restore_session { "session_id": "<uuid>" }

# Restore a single entry:
wm_restore_entry { "entry_id": 42 }

# Restore a topic (link rows in workstream_topics / entry_topics remain
# soft-deleted; use wm_link_workstream_topic / wm_link_entry_topic to
# re-activate them):
wm_restore_topic { "slug": "some-topic" }
```

**Notes:**

- Every restore is **idempotent** — calling it on a row that is already
  active is a no-op (returns zero counts, no error).
- `wm_restore_entry` throws if the entry is not currently soft-deleted.
- Restored entries are automatically re-inserted into the FTS index so
  `wm_search_entries` can find them again immediately.

## Schema migrations

New migrations go in `schema/NNN_<name>.sql` and are registered in the
`MIGRATIONS` array at the top of `src/db.ts`. On activation, the runner
ensures the `schema_migrations(version, applied_at)` table exists, then
applies any unapplied versions in order — each inside its own
`BEGIN`/`COMMIT`. A legacy bootstrap stamps version 1 as applied if the
`workstreams` table already exists from a pre-tracking DB.

Rules:

- **Append-only.** Never edit an already-applied migration.
- Use the safe table-rebuild pattern in
  `schema/005_safe_topic_rebuild_template.sql` whenever you need to
  rebuild a table that has children with `ON DELETE CASCADE` (the DB is
  opened with `foreign_keys = ON`, so a naïve `DROP TABLE` will cascade
  and silently wipe the join rows — exactly what migration 004 did).
- Keep DDL idempotent where possible (`CREATE TABLE IF NOT EXISTS`,
  etc.).

## Releasing

**Don't run these scripts directly.** Ask the `working-memory-developer`
agent to ship a build, check it in, or roll one back. The scripts below
are the agent's tools; the rules for *when* to run each one live in the
agent's spec at
`~/Library/Application Support/Code/User/prompts/working-memory-developer.agent.md`.

### Flow (test-then-commit)

1. **Build & install** — `./scripts/release.sh`
   - Snapshots the journal DB to `<hub>/memory/.backups/` (gitignored,
     last 10 kept).
   - Compiles, packages `dist/working-memory-<version>.vsix`, installs it.
   - Does **no git work**. The working tree is expected to be dirty —
     the in-flight change is what's being released.
2. **Reload + test** — human-in-the-loop step. Reload the VS Code window
   and exercise the change.
3. **Commit + tag** — only after testing passes. The agent does this with
   normal git commands:
   ```
   git add -A
   git commit -m "Release working-memory v<version>: <one-line summary>"
   git tag working-memory-v<version> -m "Release working-memory v<version>"
   ```
   No sibling script wraps this — it's intentionally a deliberate step.

### Rollback (if testing fails)

```bash
./scripts/rollback.sh <version>
```

Restores the snapshot over the live DB and reinstalls the previous
`.vsix` from `dist/`. Requires VS Code to be fully quit first (the live
DB is opened with WAL — restoring it under a live extension host can
corrupt state). Because commit + tag only happen after testing passes,
rollback normally has no git state to clean up.

### Migration safety

See `schema/005_safe_topic_rebuild_template.sql` for the safe table-rebuild
pattern when writing migrations that touch tables with `ON DELETE CASCADE`
children. Migration 004 wiped two join tables by using a naïve
create-copy-drop-rename pattern with `foreign_keys = ON` globally enabled;
that template is the documented cure.

## SQLite runtime (`node:sqlite`)

The extension uses Node 22's built-in `node:sqlite` module — **no native
module build step, no `better-sqlite3`, no `@electron/rebuild` dance**.
`src/db.ts` requires it lazily so any load-time failure surfaces as an
error toast instead of a silent activation crash. VS Code 1.95+ ships
with a Node runtime new enough to support it.

## Layout

```
working-memory/
├── package.json
├── tsconfig.json
├── media/
│   └── brain.svg              # activity-bar icon
├── schema/
│   ├── 001_initial.sql        # baseline (workstreams, sessions, entries, FTS5)
│   ├── 002_soft_delete.sql    # deleted_at on workstreams/sessions/entries
│   ├── 003_topics.sql         # topics + workstream/entry join tables
│   ├── 004_topic_status_open_closed.sql
│   ├── 005_safe_topic_rebuild_template.sql  # cure for the 004 cascade bug
│   ├── 006_topic_parents.sql  # topic-to-topic DAG (parent/child links)
│   ├── 007_topic_type.sql     # topic_type discriminator (default 'topic')
│   ├── 008_topic_types_table.sql  # `topic_types` registry table + seed
│   └── 009_topic_type_fk.sql      # FK topics.topic_type -> topic_types.id
├── src/
│   ├── extension.ts           # activate/deactivate, registers views + commands
│   ├── db.ts                  # hub lookup, open + migrate, all queries
│   ├── tools.ts               # MCP language-model tool registrations (wm_*)
│   ├── tree.ts                # WorkstreamTreeProvider (Active + Archive tabs)
│   └── contentProvider.ts     # virtual docs on the working-memory: URI scheme
├── scripts/
│   ├── seed.ts                # standalone seeder (npm run seed)
│   ├── release.sh             # snapshot + compile + package + install
│   └── rollback.sh            # restore snapshot + reinstall previous vsix
└── dist/                      # built .vsix artifacts (gitignored)
```

## Release history

- **v0.7.2** — `topic_types` DB table with FK from `topics.topic_type`. Removed the TS registry + build-time sync script in favor of server-side validation; new `wm_list_topic_types` tool exposes the registry.
- **v0.7.1** — TopicType registry; Feature type registered.
- **v0.7.0** — add `topic_type` discriminator on topics (default `'topic'`, registry in `src/topicTypes.ts`); surfaced on `wm_create_topic`, `wm_update_topic`, `wm_list_topics`.
- **v0.6.1** — topic parents DAG + muted closed topic rows.
- **v0.5.1** — Topics tab in the panel.
- **v0.5.0** — webview panel with Active/Archive tabs.
- **v0.4.2** — archive tab + topic status open/closed + last-activity sort.
