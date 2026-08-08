# working-memory

**Working Memory is a context-storage and workflow engine for VS Code that
treats agentic workflows as a first-class citizen.** It gives AI agents (and
you) a durable, structured place to record what's happening, why decisions
were made, and what's left to do — so context survives across sessions instead
of evaporating when a chat ends.

It does two things at once:

- **Context storage** — a SQLite database that captures work as a simple
  hierarchy: **workstreams** (long-running threads) contain **sessions**
  (individual work blocks) which contain **entries** (timestamped log lines).
  Durable **topics** cut across workstreams to track subjects that outlive any
  one session, and full-text search makes all of it retrievable.
- **Workflow engine** — agents drive the whole thing through ~29 MCP
  language-model tools (`wm_*`). They open sessions, append journal entries,
  open and close topics, and link everything together as they work. A panel UI
  surfaces the live state so you can watch and steer.

## How it works

- **Storage:** a SQLite DB at `<hub-workspace>/memory/journal.sqlite`, opened
  via Node 22's built-in `node:sqlite` — no native modules, no build step.
  Schema lives in tracked, append-only migrations under `schema/NNN_*.sql`,
  applied automatically on activation.
- **Agent access:** the journal is exposed directly as MCP tools
  (`wm_start_session`, `wm_append_entry`, `wm_search_entries`,
  `wm_create_topic`, `wm_link_entry_topic`, …). Agents read and write the
  database without ever touching SQL by hand — the tools are the API.
- **You see it:** an activity-bar container with two tree views — **Active**
  (open workstreams) and **Archive** (closed) — plus a webview panel with
  Active / Archive / Topics tabs. Workstreams expand to a `Topics` group;
  clicking a workstream, topic, or session opens its virtual markdown doc.
- **Built for recovery:** FTS5 search over entry bodies, soft-delete (and
  `wm_restore_*` undo) across workstreams / sessions / entries / topics / link
  rows, and topic M:N links to both workstreams and entries.

## Install the latest prebuilt build

Tagging a release (`git tag v<version> && git push --tags`) runs the
[`Release VSIX`](.github/workflows/release.yml) workflow, which builds, tests,
packages, and attaches the `.vsix` to a GitHub Release. A stable
`working-memory.vsix` asset always points at the latest release, so this
downloads the newest build to the current directory and installs it without
cloning:

**macOS / Linux (bash):**

```bash
curl -sL https://github.com/mkubarycz/working-memory/releases/latest/download/working-memory.vsix -o working-memory.vsix && code --install-extension working-memory.vsix --force
# then reload the VS Code window
```

**Windows (PowerShell):**

```powershell
Invoke-WebRequest https://github.com/mkubarycz/working-memory/releases/latest/download/working-memory.vsix -OutFile working-memory.vsix; code --install-extension working-memory.vsix --force
# then reload the VS Code window
```

---

## Build

```bash
git clone https://github.com/mkubarycz/working-memory.git
cd working-memory
npm install
npm run compile           # tsc -p .  →  out/src/extension.js
```

## DB path resolution (extension)

On activation the extension looks at every open workspace folder and picks the
first one that contains **both** `AGENTS.md` and a `memory/` directory. The DB
lives at `<that folder>/memory/journal.sqlite`. If no folder qualifies, the
extension surfaces an error toast and the tree stays empty — open the hub
workspace and run **Working Memory: Refresh** (or reload the window).

## Run the extension locally

For iterating on the extension itself, use the **Extension Development Host**:

1. Open the `working-memory/` project folder in VS Code.
2. Press `F5` (or **Run → Start Debugging**). A second VS Code window opens
   with the extension loaded.
3. In that window, open the multi-root workspace
   `kubarycz-agentic-workspace.code-workspace` so the hub folder is present.
4. Click the brain icon in the activity bar → see your workstreams.

To install a build instead of debugging, use the prebuilt GitHub Release
one-liner above.

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

Releases are cut by tagging `main`. Bump the version, push the commit, and push
a `v<version>` tag — the [`Release VSIX`](.github/workflows/release.yml)
workflow does the rest: build, test, package, and publish the `.vsix` to a
GitHub Release (including the stable `working-memory.vsix` asset the install
one-liner points at).

```bash
# from an up-to-date main, with the change already merged:
npm version <version>                 # bumps package.json, commits, creates the v<version> tag
git push origin main --follow-tags    # pushes the commit and the tag
```

**Tags must be on `main`.** The workflow's first step verifies the tagged
commit is an ancestor of `origin/main` and refuses to release a feature-branch
tag.

### Migration safety

See `schema/005_safe_topic_rebuild_template.sql` for the safe table-rebuild
pattern when writing migrations that touch tables with `ON DELETE CASCADE`
children. Migration 004 wiped two join tables by using a naïve
create-copy-drop-rename pattern with `foreign_keys = ON` globally enabled;
that template is the documented cure.

## Release history

See the [GitHub Releases](https://github.com/mkubarycz/working-memory/releases)
page — each tagged `v<version>` release carries its notes and the published
`.vsix`.

### 0.14.2 — New Document UI

- **Unified `.working-memory` Svelte custom editor** — a single custom editor
  that dispatches on document kind: dedicated **workstream** and **topic**
  screens, with a **generic fallback** for other document kinds.
- **Tree UX** — collapse/expand, right-click context menu, pin, focus **glow**,
  and per-state styling (dim + sort closed topics, red-X for failed nanites).
- **Autosave + save indicator** — edits persist automatically with a live save
  status in the editor.
- **Live-refresh + startup-race heal** — open editors refresh in place on
  external changes, and a startup race that could leave the panel stale now
  self-heals.
- **Markdown Preview/Edit tabs** — topic bodies get a tabbed Preview/Edit
  panel.
- **Codicon packaging fix** — `media/codicons` is regenerated on build/install
  so the packaged `.vsix` reliably ships `codicon.css`.
