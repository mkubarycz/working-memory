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
  clicking a workstream, topic, or session opens its virtual markdown doc. The
  panel header also includes a shortcut that launches or focuses the packaged
  Working Memory desktop UI.
- **Built for recovery:** FTS5 search over entry bodies, soft-delete (and
  `wm_restore_*` undo) across workstreams / sessions / entries / topics / link
  rows, and topic M:N links to both workstreams and entries.

## Install the latest prebuilt build

Tagging a release (`git tag v<version> && git push --tags`) runs the
[`Release VSIX`](.github/workflows/release.yml) workflow, which builds, tests,
and attaches platform-targeted `.vsix` files to a GitHub Release. Each package
contains the matching Electron runtime. Download the asset for the host running
VS Code:

**macOS / Linux (bash):**

```bash
case "$(uname -s)-$(uname -m)" in
  Darwin-arm64) TARGET=darwin-arm64 ;;
  Darwin-x86_64) TARGET=darwin-x64 ;;
  Linux-x86_64) TARGET=linux-x64 ;;
  *) echo "No prebuilt Working Memory package for this host" >&2; exit 1 ;;
esac
curl -sL "https://github.com/mkubarycz/working-memory/releases/latest/download/working-memory-${TARGET}.vsix" -o working-memory.vsix && code --install-extension working-memory.vsix --force
# then reload the VS Code window
```

**Windows (PowerShell):**

```powershell
Invoke-WebRequest https://github.com/mkubarycz/working-memory/releases/latest/download/working-memory-win32-x64.vsix -OutFile working-memory.vsix; code --install-extension working-memory.vsix --force
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

## Desktop container apps

The desktop **Container Apps** right-rail tab lists registered local
applications. Selecting one opens its stable virtual document in the middle
stage, where its launch, health, contract, MCP, and refresh actions remain
available:

| App | ContainerClaim | Container | URL | Source override |
|---|---|---|---|---|
| Clarinet Hero | `clarinet-hero` | `working-memory-clarinet-hero` | <http://localhost:4173/> | `CLARINET_HERO_SOURCE` |
| Banking App | `banking-app` | `working-memory-banking-app` | <http://localhost:4174/> | `BANKING_APP_SOURCE` |
| Sunset Chess | `sunset-chess` | `working-memory-sunset-chess` | <http://localhost:4175/> | `SUNSET_CHESS_SOURCE` |

Each action is routed by app ID through one registry-driven orchestration path.
The launcher creates or updates the durable claim, builds its Dockerfile, and
reconciles only the exactly labeled managed container. The browser opens an app
only after an HTTP readiness check succeeds. Docker must already be installed
and running; the launcher uses only a validated local Unix-socket Docker
context and reports missing CLI, daemon, timeout, build, ownership-conflict,
startup, and readiness failures without removing unrelated containers. Set
`WORKING_MEMORY_DOCKER_CONTEXT` to prefer a context; otherwise the launcher
checks `desktop-linux`, `orbstack`, and `default`. Existing valid source paths
are retained; otherwise use the app-specific source override or place the
checkout in its discoverable sibling/workspace project path.

ContainerClaims may include a validated Docker `volumes` list and an optional
app-scoped MCP descriptor (`{ transport: "streamable-http", url }`). Sunset
Chess mounts `working-memory-sunset-chess-data` and publishes
<http://localhost:4175/mcp>. The desktop MCP client is separate from
the selected Working Memory control-plane environment, permits only localhost
HTTP endpoints, connects only after app health succeeds, and disconnects on
app stop, environment switch, and window shutdown.

A claim can also advertise an `application` contract descriptor with:

- stable application `id` and `contractVersion`
- the MCP `discovery.toolName` that returns the live Zod-derived contract
- declared `capabilities` and `dataOwnership: "application"`
- optional `healthUrl`, `httpUrl`, and `uiUrl`

Container App detail connects through the same loopback-only MCP client, invokes
that discovery tool, verifies the application identity, and displays the live
common-envelope resource schemas, relationships, and business rules. Working
Memory stores only registration metadata; application domain data remains in
the app-owned database.

Sunset Chess registers contract version `1.0` with MCP discovery tool
`contract-discover`, app-owned data, and only the bootstrap
`contract-discovery` capability. Resource-specific capabilities are derived
from the live contract rather than duplicated in registry metadata. Its local
endpoints are:

- health: <http://127.0.0.1:4175/health>
- MCP: <http://127.0.0.1:4175/mcp>
- HTTP API base: <http://127.0.0.1:4175/api>
- preferred HTTP contract: <http://127.0.0.1:4175/.well-known/sunset-chess-contract>
- compatibility contract alias: <http://127.0.0.1:4175/api/contract>
- optional UI: <http://127.0.0.1:4175/>

The registry contains only identifiers, capabilities, and endpoints. Resource
schemas, constraints, lifecycles, effects, errors, and events are fetched live
from Sunset Chess rather than copied into Working Memory.

In Desktop chat, use the canonical `@container-app-id` form to include only
that app's advertised MCP tools in a model request. For example,
`@sunset-chess show me current games` and
`@Sunset-Chess add Elliot as a new player` resolve case-insensitively. The model
chooses the MCP tool and arguments from its description and schema. An app must
already have a current ContainerClaim that advertises MCP and its managed
container must be running and healthy; chat never starts it automatically.
Read-only MCP tools run directly, while app tools not explicitly annotated
read-only require confirmation. Command journals record the provider-safe
namespaced tool name, sanitized arguments/results, and confirmed app writes as
mutations.

Selecting a Container App document makes that app the implicit target for each
submitted turn until another app or document is selected. This supplies the
same tools and routing as its explicit `@container-app-id` mention without
changing the user-visible or persisted message text. Explicit mentions still
work and can add other registered apps to a request.

An explicit or implicit app target injects the live claim identity and MCP
connection context into the desktop model prompt. The model is instructed to
call the advertised contract discovery tool first, then plan resource
envelopes and relationships before any other operation. Existing endpoint
validation, health checks, provider-safe namespacing, connection pinning, and
mutation confirmation remain in force.

The reusable [`templates/standalone-app`](templates/standalone-app) Cruft
template implements the application side: Zod contract discovery, the approved
`{ kind, metadata, spec, status, relationships }` envelope, app-owned SQLite,
generic MCP resource operations, optional HTTP/UI, atomic audit/domain events,
health, Docker/Compose, tests, and generated-project CI.

Generate and maintain apps with the repository-pinned Cruft 2.16.0 wrapper;
it creates/reuses ignored `.tools/` and `.cache/` directories instead of
installing globally:

```bash
scripts/cruft.sh create . --directory templates/standalone-app --output-dir ../
npm run test:standalone-template
```

The disposable smoke harness covers `create`, `link`, `check`, and `update`
against the template as a Git-repository subdirectory. It also installs and
validates the generated npm project, proves template drift/update behavior,
preserves committed app-owned changes, checks `.cruft.json` subdirectory
provenance, and cleans its ignored `.tmp/` workspace. Generated READMEs define
`src/framework/**` as template-owned and `src/app/**` as app-owned, including
the recommended Cruft `skip` patterns.

For bulk topic closure, agents use `ws-topic-close-tree` rather than emitting
one `ws-topic-update` per descendant. The operation preflights the whole DAG and
closes it in one atomic batch. By default it preserves any descendant with a
parent outside the selected closure and propagates that exclusion to
no-longer-exclusive descendants; `includeSharedDescendants: true` deliberately
closes every reachable descendant, while `dryRun: true` returns the exact plan.
CommandJournal keeps its supplemental entity-reference index capped at 500;
canonical tool call/result events remain the complete audit evidence.

Typing `@` at the start of a message or after whitespace or punctuation opens
the registry-driven Container App picker. Continue typing to filter by app ID
or display name, use the arrow keys to navigate, and press Enter or Tab to
insert the canonical ID (Escape dismisses it). The picker labels apps that
currently advertise MCP; apps without an endpoint remain selectable so chat
can explain the missing capability.

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
workflow does the rest: build, test, package, and publish
`working-memory-{darwin-arm64,darwin-x64,linux-x64,win32-x64}.vsix`. The
extension's **Update to Latest** command selects the asset matching the current
host. Linux arm64 and Windows arm64 are not currently published.

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
