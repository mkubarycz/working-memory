# working-memory

**Working Memory is a desktop context-storage and workflow engine that treats
agentic workflows as a first-class citizen.** It gives AI agents (and you) a
durable, structured place to record what's happening, why decisions were made,
and what's left to do — so context survives across chats instead of
evaporating when a chat ends.

It does two things at once:

- **Context storage** — a portable SQLite database of durable **workstreams**,
For   **topics**, topic types, Agent Messages, and related control-plane documents.
- **Workflow engine** — agents drive the store through typed MCP tools
  (`ws-*` and `wm-document-*`). The standalone desktop app surfaces the live
  state so you can watch and steer.

## How it works

- **Storage:** the control plane owns a SQLite database opened through Node
  22's built-in `node:sqlite`. Schema changes are tracked in append-only
  migrations and applied automatically.
- **Agent access:** typed MCP tools expose the document store without requiring
  agents to touch SQL.
- **You see it:** the standalone Working Memory desktop app owns the Active
  rail, document editor, Markdown preview, chat, and settings UI. VS Code
  connects directly to the external MCP endpoint; no Working Memory extension
  is required.
- **Create workstreams:** use **NEW WORKSTREAM** beside **In Progress**
  in the Active rail. The topic creation editor includes a **New workstream**
  field under Workstreams. Describe the first topic to suggest its title, type,
  and the broader workstream name using the existing Simple / fast model.
  Manually edited fields are preserved. **Create Workstream & Topic** creates
  an In Progress workstream and saves the description as its first topic;
  nothing is created until you confirm. If the topic save fails after workstream
  creation, the draft keeps that workstream for retry rather than creating another.
- **Close a workstream:** right-click its row in the Active rail and choose
  **Close Workstream**. It moves to the archive; its topics, memberships, and
  authored content remain unchanged. **Reopen Workstream** returns it to
  In Progress.
- **Move to a new workstream:** right-click a topic in the Active rail, then
  **Move to... > New Workstream...**. Its saved title and body are used to suggest
  an editable workstream name. **Move** creates the In Progress workstream and
  moves the existing topic tree into it without changing topic statuses or other
  workstream memberships. Cancel makes no changes; a failed move can be retried
  without creating another workstream. The Active topic menu omits the redundant
  **Add to workstream** action; **Remove from workstream** remains available.
- **Link targets:** hover over an internal or external link to see its target
  URL in a tooltip, including links in live Markdown, document previews, and chat.
  Authored Markdown is not changed.
- **Topic identifiers:** topic headers show creation and update times without
  the resource ID. Hover over a topic tab to see its full resource locator.
- **Draft autocomplete:** suggestions start after an idle pause once the body
  contains at least 24 characters; punctuation is not required. Changes during
  the ten-second request cooldown are queued, and stale responses are ignored.
  Model errors are shown with **Retry suggestions**; manual edits are preserved.
- **Built for recovery:** resources use explicit status and relationship
  fields, while the SQLite store remains portable and independently backed up.

## Installation status

Working Memory no longer ships as a VS Code extension. Tagged releases publish
standalone installers built by `.github/workflows/release.yml`:

| Platform | Installer | Installs to |
| --- | --- | --- |
| macOS (Apple silicon) | `Working-Memory-<version>-mac-arm64.dmg` | drag to `/Applications` |
| Windows (x64) | `Working-Memory-<version>-win-x64.exe` (NSIS) | per-user `%LOCALAPPDATA%\Programs\Working Memory`, Start Menu and desktop shortcuts |

Both installers register the `working-memory://` URL scheme so chat links from
VS Code and other apps open the desktop UI.

**Prerequisite:** [Docker Desktop](https://www.docker.com/products/docker-desktop/).
Installers only install the app; the data tier is managed from inside it.

On launch, Working Memory connects to a running data tier if one is
reachable (for example an existing `working-memory-control-plane` on
`127.0.0.1:7717`). Otherwise it starts Docker Desktop (if needed), loads the
prebuilt control-plane image bundled in the installer, and starts its default
instance with `docker compose`, creating it on a fresh install. Loading the
image can take a few minutes. No npm downloads, local image builds, registry
login, or backend registry access are needed on the installed computer.
CI builds Linux ARM64 images for Mac installers and Linux x64 images for
Windows installers. Local `npm run build` / packaging builds the image using
Docker first; CI supplies it via `WM_DATA_TIER_IMAGE_ARCHIVE`.

Open **environment menu > Manage instances…** (or **Settings > Instances**) to
manage the data-tier instances the app created. Reachable Working Memory servers the app did not
create (for example one started from this repo's `compose.yaml`) are listed as
**Self-hosted**: you can make them current, but start, stop, upgrade, and
backup are managed outside the app.

- **Add instance** starts a new, empty data tier. The first instance uses
  `7717` when it is free; others use the next free port from 7719–7799 (7718
  is reserved for the desktop link bridge) and are named
  `working-memory-control-plane-<port>`.
- **Make current** switches the desktop app to that instance.
- **Start / Stop** controls the container (the current instance cannot be
  stopped).
- **Backend update channel** chooses which backend version instances should
  run: **Off** uses the image bundled with the app, **Canary** follows the
  latest `main` build, and **Stable** follows the latest tagged release.
  Canary and Stable images are pulled from
  `ghcr.io/mkubarycz/working-memory-control-plane`.
- **Update to <version>** appears when an instance runs a different version
  than the channel's target; it recreates the container with that image and
  keeps its data.
- **Rename** changes the display name shown in the environment picker.
- **Back up…** writes a consistent SQLite snapshot
  (`working-memory-<name>-<timestamp>.sqlite`) to a folder you choose
  (default: Desktop). The instance must be running.

Managed instances are recorded in the app's `data-tier/instances.json`
(`~/Library/Application Support/Working Memory` on macOS,
`%APPDATA%\Working Memory` on Windows). Data lives in:

- macOS: `~/Library/Application Support/WorkingMemory` (bind mount); other
  ports use `WorkingMemory-<port>`.
- Windows: the Docker volume `working-memory-data` (SQLite WAL is unreliable
  on Windows bind mounts); other ports use `working-memory-data-<port>`.

Set `WM_DATA_TIER_AUTOSTART=0` to disable automatic data-tier startup.

Builds are not code-signed or notarized yet. On macOS, use **System Settings >
Privacy & Security > Open Anyway** (or `xattr -dr com.apple.quarantine
"/Applications/Working Memory.app"`). On Windows, choose **More info > Run
anyway** at the SmartScreen prompt. Intel Macs are not packaged; build locally.

The macOS development build (`npm run compile:desktop`) still installs
`/Applications/Working Memory.app` directly and uses your existing control
plane.

### Desktop updates

**Settings > Updates** picks the desktop update channel: **Off**, **Canary**
(the rolling `canary` release rebuilt on every push to `main`), or **Stable**
(the latest non-prerelease `vX.Y.Z` release). Installer builds default to
Canary for `-build.N` versions and Stable for tagged versions; local
`npm run build` builds default to Off. The app checks 15 seconds after launch
and every six hours, then offers **Download** and **Restart and install**.

Each release carries an `update.json` manifest with the installer SHA-256 and
size; downloads that do not match are discarded. On macOS the updater copies
the app out of the DMG next to the installed bundle, checks its bundle id and
signature, and swaps it in after the app quits, so the app must live in a
folder you can write to (such as `/Applications`). On Windows it runs the NSIS
installer silently and relaunches. Electron's built-in updater is not used
because Squirrel.Mac requires a paid Developer ID signature. Set
`WM_UPDATE_RELEASES_URL` to test against another releases URL.

---

## Build

```bash
git clone https://github.com/mkubarycz/working-memory.git
cd working-memory
npm install
npm run compile           # shared client modules + control plane
npm run compile:desktop   # builds and updates /Applications/Working Memory.app on macOS
```

Local macOS desktop builds always update the stable
`/Applications/Working Memory.app` bundle, which can be kept in the Dock. A
build signals the installed desktop process to refresh after installation;
set `WM_DESKTOP_SKIP_REFRESH=1` to suppress that behavior. Local and installer
builds share the `Working Memory` app identity, so a build always refreshes the
running app instead of starting a second copy. Settings from earlier installer
builds (stored under `working-memory-desktop`) are copied into a fresh profile
on first launch; the old folder is left in place. The desktop stores
open document-tab identities and the selected tab per Working Memory
environment, then reopens current resource data in the same order after a
restart. CI builds prepare the application bundle but skip the local
`/Applications` installation.

For local builds that remember credentials, create an **Apple Development**
certificate once in **Xcode -> Settings -> Accounts -> Manage Certificates ->
+ -> Apple Development**. A free Apple account is sufficient for local
development signing; this is not distribution signing or notarization.
Builds automatically prefer a single valid Apple Development certificate and
use its SHA-1 to select the signing identity unambiguously. If several are
installed, set `WM_DESKTOP_CODESIGN_IDENTITY` to the desired certificate SHA-1.
An explicit identity always takes precedence, including Developer ID
certificates used for distribution.
If a newly created certificate is not listed as valid, check that Apple's
[Worldwide Developer Relations G3 intermediate certificate](https://developer.apple.com/support/expiration/)
is installed. Install the intermediate from Apple's Certificate Authority
site; do not override certificate trust or add an unverified root.

The stable Apple **Team ID** lets macOS retain Keychain trust across changed
builds. The first build with the new signer may ask for the Mac login password:
choose **Always Allow** in that native dialog once. The signing key may also
need a one-time authorization for `codesign`. Never enter either password in
chat, scripts or environment variables.

Without an Apple Development identity, builds retain the
`Working Memory Local Code Signing` fallback when installed, or use ad-hoc
signing for CI and machines without credentials. A self-signed certificate
without an Apple Team ID is **not** enough to avoid repeat prompts: macOS may
record a per-build code hash even when its designated requirement is stable.
Identity lookup failures stop the build rather than silently changing signers.

## Desktop AI providers

Settings > Models supports **OpenAI-compatible / Azure Foundry** and
**GitHub Copilot (local CLI)** profiles. Fresh installs default to a single
**GitHub Copilot** profile (model `auto`) on every routing cell. Existing
configurations are unchanged; adding Copilot does not change existing
endpoints, keys, or routing.

To dogfood Copilot:

1. Sign in with the account that has your Copilot license: install the
   official [GitHub Copilot CLI](https://docs.github.com/en/copilot/how-tos/copilot-cli/set-up-copilot-cli)
   (`brew install copilot-cli`, or `winget install GitHub.Copilot` on Windows)
   and run `copilot login`, or run `gh auth login`.
3. Add a model profile in Settings and choose **GitHub Copilot (local CLI)**.
4. The model dropdown loads automatically. Choose a model (or `auto`) and **Test**.
   If loading fails, the error is displayed with **Retry loading models**.
   Retrying starts a fresh connection after a sign-in failure. A failed refresh
   preserves the loaded model list, selected model, and routing.
5. Assign that profile in **Routing matrix** and save. Chat currently uses
   **Complex / medium**; topic title/type autocomplete uses **Simple / fast**.
   Assign all nine cells to Copilot to replace Azure for all configured routes.

The installed desktop app uses the native Copilot runtime bundled with the
app. It does not require Node.js on PATH or automatically select an installed
CLI launcher. Packaged installations launch the native executable from
`app.asar.unpacked`; development and local unarchived builds use the SDK's
default runtime path. Set `WM_COPILOT_CLI_PATH` in the app's launch environment only
to explicitly select an external executable, whose runtime dependencies you
must provide; `bundled` selects the default runtime. Inherited
`COPILOT_CLI_PATH` overrides are ignored. It uses the CLI's existing
authentication. If that account is not signed in, it can reuse the active
`github.com` account from GitHub CLI (`gh`), including Homebrew installations
missing from a macOS GUI's PATH. The token is read by the native process and
passed only to the Copilot runtime; it is never stored in model configuration
or sent to the renderer. Explicit token overrides are not replaced with another
GitHub identity. Inherited SDK session tokens are ignored so a desktop launch
does not depend on an agent's temporary sign-in.
Copilot requires an eligible account and employer permission
for CLI use; plan allowances, model access, and billing rules apply.

This is a model-only integration: Copilot's shell, filesystem, MCP tools,
skills, and repository instruction discovery are not enabled. The app sends
the current transcript and tool schemas, validates JSON tool proposals, and
executes them through Working Memory's existing confirmation and command
journal path. Attached images are passed as image attachments. Each model
turn uses an isolated session that is deleted afterward. Copilot errors are
reported explicitly; requests never fall back to Azure automatically.
Inherited `COPILOT_PROVIDER_*` BYOK overrides are removed from the runtime
environment so selecting Copilot does not silently use an Azure endpoint.

The normal test suite mocks Copilot and makes no billed model requests. To run
the opt-in live test with a signed-in local CLI (uses your Copilot allowance):

```bash
WM_COPILOT_SMOKE=1 npm test --prefix desktop-ui -- tests/copilotProvider.integration.test.ts
```

Set `WM_COPILOT_SMOKE_MODEL` to test a different model; the default is
`gpt-5.4-mini`. The smoke test uses synthetic prompts and tool results, never
mutates Working Memory documents, and deletes its temporary Copilot sessions.

## Persistent control-plane container

The Working Memory SQLite data tier and Streamable HTTP MCP server can run as
a dedicated Docker Compose service. The service:

- bind-mounts the existing data directory at `/data`, so `journal.sqlite`
  remains on the host and survives container replacement;
- publishes MCP and health only on `127.0.0.1:7717`;
- restarts automatically unless explicitly stopped;
- exposes `GET /health` and Streamable HTTP MCP at `/mcp`.

Create a local `.env` with an absolute host path. On macOS:

```bash
cp .env.example .env
# Edit WORKING_MEMORY_DATA_DIR for your username if needed.
docker compose up -d --build control-plane
docker compose ps
curl http://127.0.0.1:7717/health
```

The default production data directory on macOS is
`~/Library/Application Support/WorkingMemory`. Stop any host control-plane
process before starting the container so only one process opens the SQLite
store. View logs with `npm run container:logs` and stop the service with
`npm run container:stop`.

The daemon binds to loopback by default outside Docker. The container sets
`WM_CONTROL_PLANE_HOST=0.0.0.0` internally so Docker can publish it, while the
Compose port mapping keeps the host exposure restricted to `127.0.0.1`.

## Store path resolution

The control plane resolves its data directory from
`WM_CONTROL_PLANE_HOME` and otherwise uses the platform application-data
default. The desktop app connects to the selected control-plane environment;
it does not open SQLite directly.

## VS Code MCP integration

Configure VS Code directly, without an extension, by adding the external
control plane to the workspace's `.vscode/mcp.json`:

```json
{
  "servers": {
    "working-memory": {
      "type": "http",
      "url": "http://127.0.0.1:7717/mcp"
    }
  }
}
```

Start the Docker control plane before opening an agent session. Working Memory
resource links use the native `working-memory://` desktop protocol. The local
HTTP link bridge remains available for Agent Window surfaces that block custom
URL schemes.

To install a build instead of debugging, use the prebuilt GitHub Release
one-liner above.

## Agent Messages

Agent Messages replace alerts as regular `AgentMessage` documents. Use the
`ws-agent-message-create/read/update/delete` tools or the validated generic
`wm-document-*` API; `wm-list-kinds` exposes the authored schema.

Every new message requires `agent_id`, identifying its registered caller:

1. Look up your exact caller name with `ws-agent-read { "name": "Review Agent" }`.
2. If absent, register with `ws-agent-create { "name": "Review Agent" }`.
3. Remember the returned `metadata.id` and reuse it as `agent_id` on each message.

Registered callers are ordinary `Agent` documents with a unique,
case-insensitive name and optional description. Use `ws-agent-update` with
`expectedResourceVersion` to rename/update a registration, or `ws-agent-delete`
to delete an unreferenced registration (`restore: true` restores it). Message
sender IDs cannot be reassigned; the server snapshots `agent_name` at send time,
so renaming a registration never rewrites historical attribution. Referenced
registrations cannot be deleted, even if their messages are soft-deleted.
Registration is attribution only, not authentication or execution authority.

- **request**: a specific human action or decision is needed.
- **approval**: a request to review a decision, not an authorization grant.
- **error**: an important failure; require attention only when a human can
  take a specific next step.
- **completion**: completed work with a PR to review/merge, without an
  attention notification.

Keep a meaningful title and the authored Markdown in `description`, link
detailed journal/PR provenance, and specify topic/object relations. Do not post
dispatch/running chatter, duplicate summaries, or long operational reports.
`attention` defaults to false; use it only for a specific human decision/action.
For example, after substituting your registered agent ID and an existing topic ID:

```json
{
  "agent_id": "<registered-agent-uuid>",
  "title": "Choose the migration window",
  "description": "The upgrade is ready. Which maintenance window should we use?",
  "category": "request",
  "attention": true,
  "recommended_action": "Choose Friday evening or Saturday morning.",
  "topics": ["existing-topic-id"]
}
```

A completion instead uses `category: "completion", attention: false`, with
the review/merge PR linked in `description`. An approval request uses
`category: "approval"` and describes the decision, not an executable payload.

Lifecycle is `open → acknowledged → resolved`, with explicit reopening.
Acknowledged/resolved entries remain history rather than disappearing.
Acknowledgement, resolution, or message content never approves or executes a
tool; existing trusted confirmation controls remain authoritative. Messages do
not change topic/workstream lifecycle, and topic closure always requires the
user's explicit approval for that particular change.
An approval decision recorded on a message is authored communication, not proof
of a trusted identity, a host-task grant, or permission to execute a command.
For approval messages only, `decision` records `outcome` (`approved` or
`rejected`), `decided_by`, and optional `reason`. The store records `decided_at`
in Unix seconds; omit it when authoring a new decision. Recording a decision
does not resolve the message or execute anything.

The scoped Recent messages and global Log combine messages with conversation
runs, without representing messages as chat runs or tool results. Native
in-app links use `working-memory://open/agent-message/<id>`. Historical
`working-memory://open/alert/<id>` links resolve the same canonical record.
For the separate Agent Window only, retain the existing HTTP
`http://127.0.0.1:7718/open/alert/<id>` alias; the bridge's allowlist is unchanged.

### Upgrade and compatibility

The control-plane resource store runs its Agent Message conversion automatically
on opening an isolated or installed store (`resource_migrations`,
`agent-messages`; new conversion provenance and current store migration
version 4; original Alert conversion provenance remains version 3). It is versioned and transactional,
includes closed and soft-deleted Alert documents, and preserves their IDs,
Markdown, timestamps, lifecycle, and legacy provenance. It does not run against
a separate user's service as part of tests. Deprecated `ws-alert-*` and generic
`Alert` access are compatibility adapters to those same records, not a second
notification system. Legacy `alert` maps to an open attention request,
`informational` to open completion information, and `closed` to a resolved
non-attention request. Unsupported canonical categories/lifecycle combinations
return an explicit legacy-adapter error for by-ID reads; list reads return
compatible entries with `incompatibleMessageIds` and warnings instead of
coercing or silently omitting incompatible records.
Pre-existing messages, including resolved and soft-deleted history, are
attributed to the reserved **System Import** registration. Deprecated Alert
creation adapters also use this identity for compatibility; new callers must
register their own name and use canonical message tools. The registry upgrade
advances the change feed without changing authored content, timestamps, or IDs.
Recent messages and Log use the same exchange layout, with a pink caller
initials box and registered name for agent messages.
The original resource row, including legacy history and fields unknown to the
new model, remains in immutable `legacy_source` migration provenance.
Empty legacy deduplication keys are treated as absent; their original value
remains in provenance. Historical whitespace-only bodies are preserved exactly
and shown as "No message content" without saving that placeholder. This exception
applies only to migrated history and unchanged bodies on later lifecycle edits;
new messages still require nonblank content.
Malformed records or incompatible migration versions fail explicitly and roll
back conversion; reopening retries an unapplied conversion rather than
continuing a partially converted store.
`dedupe_key` identifies a live, unresolved message: identical retries reuse it,
and changed content conflicts. Resolved or deleted history is never revived by
create; a recurrence receives a new ID. Reopening an existing record is explicit
and must not collide with another unresolved message using the same key.

Keep the deprecated aliases until external agents have migrated; removal
requires an explicitly announced breaking compatibility change. Do not remove
the historical link route with the tool aliases: authored references must remain
resolvable.

### Stacked implementation and integration

The Agent Message implementation depends on
[#84](https://github.com/mkubarycz/working-memory/pull/84), head
`2535ad5982c4d8155e999a0a6e058648ba253997`, and its child PR targets
`copilot/improvement-recent-messages`. Merge #84 first, then retarget the child
to `main`; do not merge the parent into this branch or import sibling work.
The replacement supersedes #81's alert-history model: retain its history
requirements in canonical message lifecycle, not in a divergent alerts store.
Reconcile renderer overlap with #78/#79/#80, preserving App-owned
`scopePreviewExpanded`, and review migration-version overlap with #83 before
integration. Those sibling features are not included here.

## Document stage

Opening a document creates an italic **preview tab**. There is at most one:
opening another document replaces that preview in place, while existing
permanent tabs are selected without duplication. Selecting tabs, following
document navigation, scrolling, and switching Markdown viewing modes do not
make a preview permanent.

Double-click a tab header to keep it open. Authoring text, changing values,
starting a chat draft, or adding attachments also makes the affected tab
permanent before its work can be replaced. New-topic drafts and documents
returned by an authored chat request open as permanent tabs. Container-app
tabs also stay permanent because edits inside their embedded UI cannot be
observed reliably by the desktop renderer.
**Backlog**, **Settings**, and host-task views are permanent utility tabs too:
opening them does not replace a document preview. Backlog and Settings restore
locally without attempting to fetch a control-plane document.

Tab identities and order are saved per environment, but previews are
session-only: they are omitted on restart or environment switch. When the
selected tab was a preview, the leftmost saved permanent tab is selected on
restore. Previously saved tabs all restore as permanent. This does not change
content storage: document bodies are not stored in tab preferences, and
unsaved new-topic drafts and attachment/composer state are not newly persisted.

New document tabs open on the left. Selecting a tab reveals it in the navigation
strip, including after resizing the stage or closing neighboring tabs. Empty
new-topic forms use the same available document width as populated topics;
typing does not change the form's width.

In topic **Live** view, labeled Markdown links display only their label, not
their destination, optional title, or reference suffix. A plain click on a
rendered link opens it without entering editing. Editing its line reveals the
original Markdown; rendering never rewrites the stored source. Bare HTTP(S)
URLs and `www.` addresses are clickable too and continue to display their URL.
URLs inside code, image destinations, and link definitions are not standalone
click targets.

Pasting rich text into **Live** or **Source** converts clipboard HTML to authored
Markdown, preserving hyperlinks (including their display text), headings, basic
emphasis, lists, and code. Rich-text paste participates in normal undo/redo in
both Live and Source. Plain-text/Markdown paste remains unchanged. Image-file
paste still uses attachments, stored as `wm-attachment:` references; clipboard-only
local or embedded image URLs are not stored as broken image references. Raw HTML,
scripts, and unsupported link targets are not imported as executable markup.

Rendered images retain accessible alt text without a filename caption. Use the
magnifying-glass button or right-click **Open Image in Default Viewer** to view
the full-size image in the system's image viewer. Instance images are downloaded
through the selected environment's authenticated attachment proxy. Raster images
(PNG, JPEG, GIF, WebP, or AVIF; up to 30 MB) are opened as private temporary files,
which are removed when Working Memory quits.
Shutdown cancels or drains pending image opens before removing their temporary
files, and never starts a new image viewer after shutdown begins.

## Backlog

The left rail shows **Queue** and **In Progress** workstreams. Its backlog button
opens the **Backlog** page, where workstreams with backlog status appear first,
above open topics that do not belong to any non-closed workstream. Topics in a
backlog workstream stay grouped under that workstream rather than appearing twice.
Expand a backlog workstream to browse its topic tree, including nested child
topics, or click its title to open it. **Send to Queue** and **Send to In Progress**
move the workstream directly from the backlog page. The page refreshes as
membership and status change.

Backlog nodes use the same tree interactions as the left rail: right-click for
context-sensitive topic/workstream actions, drag between workstreams to copy a
topic tree (hold Command to move), drop on topics to reparent, and drag workstreams
between Backlog, Queue, and In Progress or reorder within a section. Dragged
resources also carry the same Markdown/context-file references for editors and
other apps. Unassigned topic trees can be added to a workstream without removing
any existing memberships; this requires a backend supporting source-free
`ws-topic-transfer`.
The shared tree uses light cards and menus on the backlog page while retaining
the dark rail palette. Move buttons wrap below titles when the page is narrow.

## Desktop container apps

The desktop **Container Apps** right-rail tab lists live ContainerClaims with a
Docker `runtime` in the selected environment. Claims are the persisted app
catalog, not a compiled-in allowlist: adding an app requires no Working Memory
source changes, rebuild, or installation. Selecting an app registered with
`desktop.embeddable: true` opens its UI
as a full-stage document tab. The tab health light and gear menu expose launch,
reload, external-open, stop, refresh, and App Info actions. Non-embeddable apps
open directly to App Info.

Container Apps and managed instances share Docker CLI discovery, including Docker
Desktop's installation directories when the app is launched without a shell PATH.
Docker child processes also receive the paths needed for credential helpers and
Compose. A missing CLI is reported separately from an unavailable Docker engine.

Send Feedback imports every copy as **User Story** in the receiving environment.
It does not look up or require the original topic's type, and never retypes the
source topic. The receiver resolves its own User Story TopicType UUID; a missing
or ambiguous User Story definition is reported before image upload or topic creation.

On local macOS builds, the desktop installer signals the running installed
copy to relaunch after the newly signed bundle is in place. Set
`WM_DESKTOP_SKIP_REFRESH=1` only when a build must update the application
without refreshing it.

Register an app with `ws-containerclaim-create` (or a generic `ContainerClaim`
document), providing a `title`, `repository`, and complete
Docker `runtime` (`buildContext`, `dockerfile`, image/container names, ports,
health/entry paths, and optional named volumes). Add `mcp` and `application`
metadata for chat tools and live contracts. Optional `desktop` metadata accepts
a codicon `icon` name and `embeddable` boolean; new apps default to a generic
icon and App Info rather than embedding. There are no app-name-specific
presentation defaults: icons and embedding preferences belong in each claim's
`desktop` configuration, including for previously bundled app registrations.

For example, Sunset Chess 1.4 can be registered with its dedicated source
worktree, image `sunset-chess:1.4`, container
`working-memory-sunset-chess-1-4`, host port 4176/container port 4175, and
named volume `working-memory-sunset-chess-1-4-data` mounted at `/data`.
It can advertise application identity `sunset-chess` independently of its
registration's generated object ID. Neither the original app nor its volume needs to change.

The catalog loads at startup and on environment switches, then refreshes when a
ContainerClaim changes. The desktop listens to a commit-driven, metadata-only
`GET /changes` long poll on the selected control plane; an idle connection does
not reload documents or the catalog. External MCP writes refresh the Active
rail and open documents, coalescing bursts of changes. Pending, saving, or failed
local edits are preserved rather than overwritten. Reconnecting beyond the
bounded replay window triggers a full refresh.

Live updates require the 1.1.1 control-plane image as well as the desktop update.
Upgrade an existing data-tier instance through **Settings > Instances** to use
the new endpoint. Selecting an older backend shows an explicit upgrade warning;
it does not silently fall back to continuous document polling. Changing
environments cancels the previous watch and ignores stale notifications.
Document created/updated timestamps are stored as Unix seconds and displayed
in the user's local date and time.
Updates through `ws-containerclaim-update` change the same persisted definition;
deleting a claim removes it from the catalog without stopping or deleting its
container or data. A claim without a Docker runtime is intent-only and is not
listed. Registration itself never launches a container.

Each action is routed by claim object ID through one generic orchestration path.
The launcher reads the authored claim without replacing its runtime, endpoints,
or source revision with compiled defaults, builds its Dockerfile, and
reconciles only the exactly labeled managed container. The browser opens an app
only after an HTTP readiness check succeeds. Docker must already be installed
and running; the launcher uses only a validated local Unix socket or Windows
named pipe (`npipe:////./pipe/...`). Remote TCP, SSH, and named-pipe hosts are
not permitted. The launcher reports missing CLI, daemon, timeout, build, ownership-conflict,
startup, and readiness failures without removing unrelated containers. Set
`WORKING_MEMORY_DOCKER_CONTEXT` to prefer a context; otherwise the launcher
checks `desktop-linux`, `orbstack`, and `default`. Configure local source paths
in the claim's repository and runtime; no app-specific environment variable is
required. `sourceRevision` records intent; the launcher does not check out or
switch the repository's branch.

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

The selected document's scoped conversation is also shown immediately above
the composer. Sending a command automatically expands this inline surface to
show all available exchanges for that document or Container App, including runs
that reference it from another scope. Collapsing it shows the latest five rows:
each row shows a one-line response preview with its status.
Use **Expand for all messages and details** to view the full scoped conversation.
History is paged independently of the global Log; loading older scoped messages
does not advance the Log's **Load older** cursor. With no document selected, use
the Log for global conversations.

Chat requests and write confirmations are scoped to their originating
conversation. You can switch to another topic and submit a query while the
first is still running; a background completion does not select its document.
The Log is a live chronological timeline, with a timestamped command dot and
nested tool activity, confirmation, and response for each query.
The Log and Recent messages share the same message component and timeline
styling. Expanded exchanges use boxed human initials and a boxed WM label beside
the message text, with tool calls between the two rows and no separate dark
background for the human message.
Linked context sits above the initials rows, using the same topic-type icon as
the matching open tab when available. Tool-call summaries align with that context
row and use a matching pink tool icon.
Click the pink-dot/date/status header (or focus it and press Enter/Space)
to collapse a message to a one-line preview and status; click the preview to
expand it again. Recent messages hides the redundant scope link and adds
**Show in Log**. Attention requests appear once in chronological order, marked
**Needs your attention**, rather than in a duplicate pinned section. Older
attention requests and pending tool confirmations remain available even when
Recent messages is limited to the latest five rows.
Both surfaces summarize tool activity as a count (for example, **5 tool calls**).
Click the summary, or focus it and press Enter/Space, to reveal tools and outcomes;
individual tools still open the full inspector. Failed, cancelled, and pending
counts remain visible in the summary, and confirmations stay outside it.

New completed responses add gray unread-count badges to associated topic and
workstream surfaces and a red dot to open document tabs. A response is marked
read after it is visible in a focused window for three continuous seconds;
merely switching tabs does not clear it. Unread state is retained separately
for each selected data environment, and loading old history does not mark
every historical response unread.

### Local Send Feedback prototype

An existing topic's square **Send Feedback** control prepares a copy and discovers
Feedback servers on the local network. Review the desktop version/build timestamp
and the selected backend's reported version, then click **Send**. One server is
preselected; multiple servers require a choice. Preparing or choosing a server
does not transmit topic content. After success, **Send** becomes **Done**.
No receiver URL or secret is required. Discovery probes IPv4 LAN broadcasts and
loopback using UDP 7721; topic content travels only over HTTPS on TCP 7720.

Pending edits must save successfully before sharing. The title, Markdown,
topic type, and referenced screenshot images are copied, but relationships,
Agent Messages, history, and lifecycle status are not. The receiver creates an open
topic in its **Inbox** workstream and remaps image IDs into that environment.
After delivery, the source topic receives an appended, dated **Sent as feedback
to Working Memory platform** note with a **Click to check status** link. Its
authored content and lifecycle status are otherwise preserved. The note uses
the latest source body and a resource-version guard, so concurrent edits are
not overwritten. Keep the dialog open when retrying an uncertain delivery:
retries use the same request ID and do not create duplicate topics. If delivery
succeeds but the note cannot save, the error says so; clicking **Send** again
retries the note without reposting the feedback.
The incoming copy includes a **Feedback environment** section with the desktop
version, exact build timestamp, and version reported by the selected backend's
`wm-ping` response, not the bundled image or update-channel target. These details
are captured with the topic snapshot and remain stable across retries.

The receiver is an independent **Feedback** container/repository, registered
using a ContainerClaim rather than application-specific code. Its primary
HTTP status UI is loopback-only on 7722. Generic Docker runtime `additionalPorts`
publish the receiving TCP port and discovery UDP port with explicit
`hostIp: "0.0.0.0"`; omitted host IPs default to loopback. The existing primary
UI/health port remains loopback-only for all apps.

The receiver persists its self-signed certificate in its own named volume.
Only the feedback request accepts that self-signed certificate, and it verifies
the fingerprint advertised in discovery before transmitting content. Normal
TLS verification elsewhere is unchanged. **Trusted LAN only:** discovery and
senders are unauthenticated, so encryption does not establish a trusted server
identity or prevent malicious LAN impersonation. Do not expose it to the
internet or transfer work content without authorization.

The Feedback app lists previously submitted items with their live titles and
statuses, and topic links open in a new tab. It uses the receipt marker already
persisted on imported topics rather than duplicating topic data or owning a
second database. Monitoring links remain on the receiver's HTTPS API and show
the latest status, refreshing every 15 seconds. Browsers may require trusting
the receiver's self-signed certificate when opening these links externally;
the sender's scoped certificate acceptance does not change browser trust.

Read-only MCP tools run directly, while app tools not explicitly annotated
read-only require confirmation. Command journals record the provider-safe
namespaced tool name, sanitized arguments/results, and confirmed app writes as
mutations. An app's `change-set-commit` and `change-set-discard` tools are
excluded from both the model tool list and routing table unless the current
message explicitly asks to commit, discard, or revert the staged changes; when
exposed, either operation still requires confirmation.

Selecting a Container App document makes that app the implicit target for each
submitted turn until another app or document is selected. This supplies the
same tools and routing as its explicit `@container-app-id` mention without
changing the user-visible or persisted message text. Explicit mentions still
work and can add other registered apps to a request.

### Container App resource references

Embedded apps can expose draggable resources through the shared MIME type
`application/vnd.kubarycz.container-app-resource+json`. Version 2 is:

```json
{
  "version": 2,
  "appId": "banking-app",
  "resourceKind": "LedgerItem",
  "resourceId": "projection-item:123",
  "title": "Monthly mortgage",
  "deepLink": "http://127.0.0.1:4174/?resource=LedgerItem&id=projection-item%3A123",
  "preview": {
    "date": "2026-02-01",
    "description": "Monthly mortgage",
    "amount": "$400.00",
    "details": [{ "label": "Status", "value": "Planned" }]
  }
}
```

Required identity fields are version, app ID, resource kind, resource ID,
title, and a registered loopback deep link. `preview` is optional and supports
the common date, description, and amount fields plus a bounded list of generic
label/value details. Apps set this JSON on the shared MIME during `dragstart`;
they should also provide `text/plain`, `text/markdown`, and `text/uri-list`
fallbacks. An embedded app may request the same attachment explicitly with:

```js
window.parent.postMessage({
  type: 'kubarycz:container-app-resource',
  reference
}, '*');
```

Working Memory validates the source frame, app identity, loopback URL, and
notation before accepting it. Dropping the resource into chat renders one
Markdown link labeled from its preview, adds the canonical `@app-id`, and
therefore gives the model the app's discovered MCP tools. The deep link's
resource kind and ID are the authoritative app-owned identity; the model is
instructed to resolve that identity through the app contract rather than
treating it as a Working Memory document. Version 1 references remain accepted
and are normalized to version 2.

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

The separate VS Code Agents window does not load ordinary extension URI
handlers and blocks arbitrary custom schemes. Chat-facing links therefore use
the desktop loopback bridge
`http://127.0.0.1:7718/open/<kind>/<id>`, where:

- `<kind>` is `topic`, `workstream`, `topic-type`, `alert`, or `document`
- `<id>` is the existing immutable resource object ID; names are not aliases

| Kind | Markdown shape | Example |
|---|---|---|
| Topic | `[label](http://127.0.0.1:7718/open/topic/<id>)` | `[chat-clickable-links](http://127.0.0.1:7718/open/topic/00000000-0000-4000-8000-000000000001)` |
| Workstream | `[label](http://127.0.0.1:7718/open/workstream/<id>)` | `[topic-types](http://127.0.0.1:7718/open/workstream/00000000-0000-4000-8000-000000000002)` |
| Agent Message (compatibility route) | `[label](http://127.0.0.1:7718/open/alert/<id>)` | `[release blocker](http://127.0.0.1:7718/open/alert/1234)` |

The loopback server accepts validated GET routes only, focuses the desktop app,
opens the resource, and returns a small confirmation page. Identifiers
containing reserved characters must be URI-encoded. The Working Memory Agent
Plugin supplies the same link rule to the separate Agents window.

### Palette + `command:` parity

The same four `working-memory.open*` commands also exist for use from
the Command Palette (`Working Memory: Open Session / Topic / Workstream`)
and from trusted markdown contexts. If you control a `MarkdownString`
with `isTrusted = true` (e.g. a hover, a chat participant), you can
still use:

```
[label]\(command:working-memory.openTopic?%5B%22<id>%22%5D\)
```

The `?...` payload is `encodeURIComponent(JSON.stringify([id]))`. The
deep-link form above is preferred for chat because it does not require
trust.

## Schema migrations

### Upgrading to ID-only resources (1.3.0)

Resource slugs are removed from storage, metadata, UI, clients, and MCP inputs.
Use returned object IDs for reads, updates, deletes, deep links, parent/type
references, workstream membership, and container registration references.
Creating a resource no longer requires or generates a slug. Duplicate titles
are allowed. Unsupported input fields are rejected rather than treated as
aliases or silently ignored.

The append-only `resource-ids` migration preserves existing IDs, timestamps,
soft-deletion, row order, attachments, and child rows. It converts structured
references and drops the old column without rebuilding the parent table.
Startup does **not** rewrite authored Markdown. A missing or ambiguous target
blocks the transaction rather than guessing or silently discarding a reference.
Old slug-based URLs have no compatibility resolver; clicking one reports that
the resource was not found. Old `vscode://` links are obsolete as well.

Before the first launch of an upgraded backend, stop the desktop and backend,
then run this explicit maintenance operation against the existing database:

```bash
npm run compile
node scripts/upgrade-resource-ids.mjs --database "/path/to/journal.sqlite"
# Review the dry-run output, then apply:
node scripts/upgrade-resource-ids.mjs --database "/path/to/journal.sqlite" --apply
```

`--apply` creates a consistent sibling SQLite backup before changing data.
It rewrites resolvable legacy native, loopback, and VS Code resource URLs to
ID-based native URLs, excluding immutable `legacy_source` archives. It detaches
unresolvable relationships, substitutes the existing general Topic type for
a missing type, and creates one open report topic in an **Upgrade to 1.3.0**
workstream, grouping repairs and unresolved links by risk with links to affected
documents. No existing topic lifecycle status is changed. A dry run rolls back
the entire transaction, including the proposed report. Once the migration is
recorded, subsequent runs are no-ops.

Saved desktop tabs and chat scope keys containing old names are not aliases;
reopen affected resources by ID. Existing managed Docker containers and images
retain old ownership labels. Recreate them through a reviewed, volume-preserving
upgrade before managing them from the ID-only desktop; unrelated containers
and volumes are never rewritten by the database migration.

The active control plane owns a unified `resources` store, initialized by
`control-plane/src/store.ts`. Agent Message conversion runs there using the
named, versioned `resource_migrations` ledger, separately from the historical
relational schema sequence below. It converts records in place, without
rebuilding cascading tables or consuming a SQL migration number potentially
used by sibling work.

For the historical relational schema, migrations live in `schema/NNN_<name>.sql`
and were registered in the
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

VSIX releases are retired. `.github/workflows/release.yml` builds the macOS
DMG and Windows NSIS installer on every pull request and push to `main`
and keeps them as workflow-run artifacts (version
`<desktop-ui version>-build.<run number>`). Pushes to `main` also push the
backend image to GHCR and replace the rolling `canary` prerelease (installers
plus `update.json`). Push a `v<version>` tag (for example `v0.90.0`) to build
that version and publish a GitHub Release; plain `vX.Y.Z` tags are full
releases that the Stable channel follows, and suffixed versions such as
`v1.0.0-rc.1` are prereleases. The app's footer shows the build time. Build
installers locally with `npm run package:mac --prefix desktop-ui` or
`npm run package:win --prefix desktop-ui` (output: `desktop-ui/release/`).

The GHCR package `working-memory-control-plane` must be public so installed
apps can pull it without logging in. After the first push from `main`, set it
to **Public** under the package's **Package settings**.

Download the `working-memory-installer-<platform>-<architecture>-<version>`
artifact for your computer. GitHub wraps each artifact in a ZIP; the Mac
download contains only the DMG, not a second copy of the app.
The `ci-only-backend-linux-<architecture>` artifacts transfer backend images
between build jobs, are already included in the installers, and expire after
one day. They are not separate downloads needed for installation.

macOS builds use free ad-hoc signing, including pull-request builds. CI mounts
the DMG to verify the packaged app with
`codesign --verify --deep --strict` before uploading artifacts. Run the same
check locally with `bash scripts/verify-mac-installers.sh desktop-ui/release`.
This verifies signature integrity, not publisher trust or notarization; macOS
may still require explicit approval to open the app.

### Migration safety

See `schema/005_safe_topic_rebuild_template.sql` for the safe table-rebuild
pattern when writing migrations that touch tables with `ON DELETE CASCADE`
children. Migration 004 wiped two join tables by using a naïve
create-copy-drop-rename pattern with `foreign_keys = ON` globally enabled;
that template is the documented cure.

## Approved Node.js host scripts (experimental)

The desktop now supports a generic **register -> approve -> request -> run**
workflow on macOS and Linux, separate from the unfinished Windows/Thrive
integration below. This runs **trusted code as your local account, not in an
OS sandbox**. It never elevates privileges or lets a caller submit script text,
choose an executable, supply shell arguments, or change the process environment.

### First local example

1. Connect to the instance in the desktop. Sign in with its owner password.
   On a locally managed
   instance's first connection, choose **Set password and connect** and confirm
   the native owner-setup prompt. Passwords must have at least 12 characters.
   No token-file import or Keychain access is required.
   An optional free-text **Password hint** (up to 1000 characters) is displayed
   beside the password prompt before sign-in. It is public reminder text, not
   a secret: never enter the password itself. After connecting, open
   **Settings -> Access -> Edit password hint** to add, change, or clear it
   without changing the password or enabling Host tasks.
2. Open **Settings -> Features**. The grid lists each feature's name, short
   description, and on/off toggle. It reuses your app session and has no
   separate password form. **Host tasks** is off by default.
3. Enable **Host tasks**, then select **Host Tasks** beside **Container Apps**
   in the desktop rail. The rail lists registered scripts; selecting one opens
   its editor and details in its own persistent document tab. Re-selecting a
   script selects its existing tab, and multiple tasks can be open independently.
   There is no footer launcher, popup, or platform/integration selector. No demo scripts
   are installed automatically. **Add script** immediately saves an untitled task
   with an inert starter script and opens the same editor used for existing tasks.
   It has an ID straight away for chat and tools; creation neither runs code nor grants caller access.
4. The editor uses subtabs: **Settings**, **Code and parameters**, **Testing**,
   **App access**, **Add a caller**, **Recent runs**, and **Integration details**.
   Rename directly in the title field; **Settings** uses the document-style
   Markdown live-preview editor for the description. Markdown is stored as source.
   Name, description, time limit, code and parameter schema autosave as numbered
   drafts after a short typing pause. Owner task lists show the latest draft name;
   caller metadata and executable code remain on the published version.
   Code and JSON use syntax-highlighted editors; **Testing** starts with example JSON.
   Choose **Test**
   to execute only the displayed version immediately and show its formatted
   result or error. The click authorizes this one host execution; there is no
   second approval popup and no need to start the background runner.
   Edits automatically save as numbered draft versions. Choose **Publish**
   to select the one version available to callers; testing never publishes.
   With this task selected, desktop chat targets the task rather than a Topic:
   ask it to change the code or parameter contract and test a draft. Chat first
   saves pending editor changes and uses the displayed version. It can read
   versions, append conflict-checked drafts, and request real native tests.
   Each test requires its own approval in chat, with no second native popup.
   The editor shows chat changes and test results. Publishing and caller
   grants remain manual; chat cannot publish or start the general runner.
5. For a real caller, open **App access**. Export its own
   private credential in **Add a caller**, select the caller in **App access**,
   and approve a **one-hour script grant**. Never give an agent
   the desktop's owner session or password. Revoke the grant or script version to stop
   future dispatch and result release.

Task lists, versions and run status refresh automatically while visible.
The background runner under **App access** polls only while its task's document tab is active and explicitly started.
Switching document tabs or closing it stops new claims; a current run may finish. **Stop runner**
also aborts the current process. A sleeping/closed desktop does not execute
jobs. Runs are not automatically retried, because scripts may have side effects.

### Instance feature flags

**Settings -> Features** saves flags on the selected control-plane instance,
not just in one desktop profile. Changes save immediately, and the Features tab
refreshes automatically every two seconds while open. Changing a flag requires a signed-in instance
owner. New and existing instances default to Host tasks disabled until enabled.
Turning it off removes the rail tab, closes its local task/detail tabs, and rejects
host-task HTTP/MCP calls with HTTP 503 and
`{"error":"feature_disabled","feature":"hostTasks","message":"Host tasks is turned off. Enable it in Settings > Features."}`.
This covers both generic scripts and the legacy broker, including claims,
completions, and result reads. Existing scripts, grants, jobs, and history are
retained; disabling a feature is not revocation. Queued jobs remain subject to
their original expiry if the feature is enabled again.

The desktop aborts its current run when disabling the flag. Other active runners
stop at their next status check; already completed host side effects cannot be
undone. Other desktops refresh flag visibility with their regular health poll.
`GET /features/v1` reports flag state to a signed-in owner; `POST /features/v1` accepts
`{"hostTasks":true}` only with an active owner bearer session. Identity sign-in,
initial local owner setup, and feature management stay available while Host tasks
is off so an owner can re-enable it. These switches do not replace authorization.

The footer displays the installed application's exact numbered version, such as
**Version 1.2.0-build.80**, rather than the renderer's build time. Local development
builds continue to display their immutable build timestamp.
Revocation cannot undo host work already performed.

### Registering your own script

Choose a reviewed, self-contained `.cjs`/CommonJS `.js` file up to 32 KiB:

```js
module.exports = async function (parameters) {
  return { greeting: `Hello, ${parameters.name}!` };
};
```

Declare its allowed parameters as JSON in the registration form:

```json
{
  "name": { "type": "string", "required": true, "maxLength": 80 },
  "mode": { "type": "string", "enum": ["preview", "import"], "maxLength": 10 },
  "limit": { "type": "integer", "minimum": 1, "maximum": 100 },
  "verbose": { "type": "boolean" }
}
```

Unknown keys, coercions, missing required values, unsupported schema fields,
and out-of-range values are rejected. At most 20 parameters and 16 KiB of
parameter JSON are accepted. Arguments arrive as a frozen object, not shell
substitutions. Return JSON-serializable data up to 64 KiB. Console output is
not returned; exceeding 64 KiB of console output fails the run.

Registration stores a private immutable snapshot of the entry script and its
parameter contract, host binding, and time limit. Its canonical SHA-256 is
shown during native approval and rechecked before execution. Editing the
original file does not change an approved version. The owner can read and edit
stored code in the desktop: edits create immutable numbered drafts without
changing the published version or its grants. Version 1 of an existing task
is preserved during upgrade. The version selector opens older versions;
**Publish** selects exactly one and invalidates existing caller grants, which
must be approved again for that published version. A stale publish is rejected.
The UI uses a 10-second time limit; the API
supports 1–30 seconds. The runner uses the installed Electron Node runtime in
a child process, with a minimal environment and best-effort process-group
termination on timeout, cancellation, and completion. Deliberately detached
descendants, runtime dependencies, and OS privileges are **not sandboxed**.
Only built-in modules are supported through the supplied `require`; filesystem
and network restrictions must be implemented in the reviewed script itself.
Do not register code from an untrusted caller.

### Authenticated tools and broker API

An app-specific bearer credential plus an unexpired, exact-version script
grant is required. Script definitions, grants, jobs, and private results live
in protected broker tables, not editable Topic/Config documents. Native
registration and grants require a cancel-default confirmation. Owner tests
are explicitly authorized by **Test** in the trusted desktop; the broker
atomically queues and claims that exact version's test, and the native host
executor returns its result without consuming unrelated queued work.
Grants last at most 24 hours, queued jobs at most five minutes, with one active
generic job per caller and at most ten requests per minute. Completed arguments
are cleared; results/error payloads are retained at most 30 minutes and never
past grant validity. Audit rows contain control metadata, not script source,
arguments, or result data. SQLite WAL/backups are not securely erased.

Agents can connect to **`/host-tasks/v1/scripts/mcp`** with their own bearer
credential. This is a separate, stateless MCP endpoint: only that caller's
currently granted script versions appear as named tools. Each tool accepts
`parameters` and a stable `idempotencyKey`, returns an accepted job, and exposes
`host_script_job_read` for polling. Revocation/expiry is rechecked on every
request and before completion/result release. Do not configure this endpoint
with an admin token or put credentials in authored documents.

For HTTP clients, using the same bearer credential:

| Method / path | Purpose |
| --- | --- |
| `GET /host-tasks/v1/scripts` | List my granted versions and parameter contracts; never source |
| `POST /host-tasks/v1/scripts/requests` | Submit `{taskId, definitionHash, parameters, idempotencyKey}` |
| `GET /host-tasks/v1/scripts/jobs/<id>` | Read only my job's status/result |

Owner-only endpoints below `/host-tasks/v1/admin/scripts` expose `GET /<id>`
for source and version history, `POST /<id>` to append a draft definition,
and `POST /<id>/publish` with `{version, expectedPublishedHash}` to publish.
`POST /test/claim` accepts the test request plus `version` and `hostId` and
returns an execution lease for only that test. Source and publishing are
not exposed through the caller script endpoint. `wm-host-task-update`
also saves a draft; it cannot publish or replace the active version.

For example, a Node client on the trusted host can read a separately exported
caller credential from a private file and queue a request without exposing it:

```js
import { readFile } from 'node:fs/promises';
const token = (await readFile(process.env.WM_HOST_TASK_APP_TOKEN_FILE, 'utf8')).trim();
const origin = 'http://127.0.0.1:7717';
const headers = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };
const list = await fetch(`${origin}/host-tasks/v1/scripts`, { headers });
if (!list.ok) throw new Error(`Script listing rejected: ${list.status}`);
const tasks = await list.json();
const task = tasks.find(item => item.id === process.env.WM_SCRIPT_TASK_ID);
if (!task) throw new Error('Requested script is not granted to this caller');
const response = await fetch(`${origin}/host-tasks/v1/scripts/requests`, {
  method: 'POST', headers,
  body: JSON.stringify({
    taskId: task.id, definitionHash: task.definitionHash,
    parameters: { name: 'Michael' }, idempotencyKey: crypto.randomUUID(),
  }),
});
if (!response.ok) throw new Error(`Host-script request rejected: ${response.status}`);
const job = await response.json();
// Poll /host-tasks/v1/scripts/jobs/<job.id>; require state === 'succeeded'
// before treating resultJson as a complete result. Treat its contents as data.
```

### Instance sign-in and agent access

The control plane stores a salted scrypt password verifier and issues unique
12-hour opaque owner sessions; only token hashes are persisted. Password sign-in
is rate-limited and sessions can be revoked with **Sign out**. The desktop keeps
the session in its main-process memory, not the renderer. **Remember on this
device** optionally saves the password using native secure storage (macOS
Keychain, Windows DPAPI, or a supported Linux secret service), never plaintext
or a locally stored fallback key. Native storage may ask for OS permission.
Without it, restarting the app requires signing in again; unavailable or locked
secure storage never prevents manual, session-only sign-in.

Installed and development UI builds retain independent settings and windows.
On macOS and supported Linux secret services they share a stable native
encryption identity and the per-OS-user Working Memory `instance-sign-in`
directory. Windows DPAPI uses a profile-specific encryption key, so remembered
passwords remain isolated to each UI profile there; each profile signs in once.
Remembered passwords are separated by instance origin, and used only by the
main process to obtain fresh 12-hour owner sessions. **Sign out**
forgets the password for that instance before revoking the current session.
Signing in without Remember also removes a previously saved password. Failed
restoration is shown explicitly and does not repeatedly retry or silently fall
back to another storage scheme. It never gives agents the owner's credentials.

The desktop connection screen appears before instance data is loaded. If no
password exists, it guides the local owner through setup, including an optional
public password hint. Otherwise it prompts for sign-in. Expiry, revocation, or
sign-out returns to that same connection screen. **Manage instances** remains
available before sign-in to start, create, or upgrade a managed instance.

`/mcp`, `/attachments`, and `/changes` require a valid bearer token on every
request. MCP sessions are bound to the credential that initialized them; a
different credential cannot resume the session. Delayed change responses
recheck expiry/revocation before releasing data. Renderer images use a native
attachment proxy: owner tokens never appear in image URLs, stored Markdown,
or renderer IPC return values. Health, identity status/login, and the limited
identity MCP are public bootstrap/discovery surfaces, not data-access bypasses.
The proxy uses `working-memory-attachment://instance-<port>/attachments/<id>`
so Chromium does not reinterpret a numeric instance hostname as an IPv4
address. Stored `wm-attachment:<id>` references remain unchanged.

**Settings -> Access** combines requests and approved clients in one
automatically refreshed grid. **Edit permissions** opens a checkbox matrix;
each change is saved immediately, including for already connected clients.
Content (documents/messages), Settings (configuration, topic types, registered
agents and container claims), and Tools (host task definitions) each have
Create, Read, Update and Delete permissions. Tools also has a separate **Run**
permission. Passwords, stored secrets, client approvals/revocation and
script-grant administration remain owner-only. Client revocation is not owner
sign-out.

When a connected client attempts an operation without permission, the instance
queues a request for only the missing permission. Repeated attempts reuse the
pending request. A card above the Access grid identifies the client and requested
access, with **Approve** and **Deny** actions. Approval adds those permissions to
the existing identity immediately, without replacing its credential or extending
its expiry. The blocked operation is not executed; retry it after approval.
Expired, revoked, denied or manually invalidated requests cannot grant access.
Denied requests are not automatically recreated during their ten-minute lifetime.
The identity MCP also exposes `wm-identity-request-permissions` for explicit
requests using an existing client credential.

Existing read/write identities retain their document/configuration permissions
without gaining Tools or Run. Pending requests can be narrowed before approval.
Changing an active identity invalidates outstanding renewal requests so they
cannot restore older permissions. Read-only OAuth requests cannot be upgraded
beyond their requested scope; reconnect requesting write access first.
Only the latest renewal for an existing client remains actionable.
Generic document lists filter out categories the client cannot read, including
before pagination. Attachments require Content Read/Create. The unfiltered
change feed requires both Content and Settings Read, rechecked before delivery.
`wm-attachment-create` uploads base64 images up to 700 KiB through authenticated
MCP and returns a portable `wm-attachment:<id>` reference. Larger images can use
the existing 10 MiB HTTP attachment endpoint.

Host tasks are available through `wm-host-task-create`, `-read`, `-update`,
`-delete`, `-run` and `-job-read` on the authenticated MCP endpoint when the
Host Tasks feature is enabled. **Run alone never approves execution**: an owner
must also grant the client's identity the exact script version, using the
existing Host Tasks grant controls. Editing saves a numbered draft without
changing published access. Explicit owner publication changes the active version,
revokes old grants and cancels affected caller jobs. Removing Run or revoking a client
cancels its jobs and grants; enabling Run again does not restore those grants.
Runner claims/completions and the owner test path are not client Tools CRUD.

#### VS Code / Copilot: automatic MCP sign-in

Some VS Code builds run OAuth discovery in a renderer whose Content Security
Policy allows HTTPS but blocks HTTP loopback fetches. Their **Sign In** button
fails before requesting owner approval, even though the HTTP MCP transport can
reach the backend. Do not weaken that policy. For these builds, use the bundled
native stdio connector instead:

```json
{
  "servers": {
    "working-memory": {
      "type": "stdio",
      "command": "/Applications/Working Memory.app/Contents/MacOS/Electron",
      "args": ["--mcp-stdio", "http://127.0.0.1:7717/mcp"]
    }
  }
}
```

Use the installed desktop executable on the current OS. The connector runs
headlessly, independently of the desktop's single-instance window lock. It
never reads or reuses remembered owner passwords. It requests its own
read/write identity, keeps claim proofs private in process memory, and stores
only its approved client credential in native-encrypted `mcp-client-sign-in`
storage, separate from owner sign-in. It refuses plaintext fallback.

Before approval, only `wm-connection-status` and `wm-request-access` are
available. The status tool and MCP stderr show the nonsecret request ID to
match in desktop **Settings -> Access**. Approval exposes the data tools using
MCP's tool-list-changed notification. Restarting the connector restores the
approved client without another prompt until its 90-day expiry or revocation.
If the server rejects an expired or revoked credential, the connector removes
the data tools and reports disconnection. Calling `wm-request-access` requests
a new owner approval; restarting also recovers from a rejected saved credential
without manually deleting credential files.
Denial/expiry/storage failures are explicit; call `wm-request-access` to retry.
No token is returned to Copilot or placed in MCP configuration. The connector
must not be reused as another container's identity.

For clients whose OAuth discovery can reach the instance, standard HTTP
authorization is also available:

Keep the HTTP MCP configuration pointed at the instance's
`http://127.0.0.1:<port>/mcp`; do not add an owner password, bearer header, or
manual broker token. Restart the MCP server after upgrading an existing
connection. VS Code discovers the standard OAuth protected-resource and
authorization-server metadata from the HTTP 401 challenge, registers a public
client, and starts an authorization-code flow with S256 PKCE.

The browser shows a request ID and directs you to the signed-in desktop's
**Settings -> Access**. Match that ID, review the inline permissions and expiry,
then click **Approve** once. There is no second confirmation popup.
The page cannot approve access, and never asks for or receives the owner
password/session. After approval, it returns a single-use, one-minute code to
VS Code's registered loopback callback. VS Code exchanges the code using its
private verifier, then manages its own scoped, revocable credential using its
native authentication facilities. Declining approval returns `access_denied`.

OAuth supports `wm.read` and `wm.write` (read/write); the access request states
the actual requested access. If no scope is supplied, read/write is requested
and still requires owner approval. Access lasts 90 days. There is no unattended
refresh token: expiry or revocation requires another owner-approved sign-in.
Owner sessions remain 12 hours, independently of client access.

This local integration supports desktop clients with HTTP loopback callbacks,
including VS Code's dynamically chosen callback ports. VS Code's web redirect
URIs may be included in registration metadata, but remote/web authorization
callbacks are explicitly rejected. Client labels are unverified, redirect URIs
are validated against registration, and codes are bound to the client, exact
callback, PKCE challenge, instance resource, and prior owner approval. Only
hashes of codes, approval proofs, and issued credentials are persisted.

#### MCP sessions and diagnostics

**Settings -> Sessions** shows the selected instance's active MCP connections,
JavaScript heap usage, and persisted session/enforcement events. This is an
owner-only view; it never exposes bearer tokens, credential hashes, or protocol
session IDs. Displayed session IDs are separate diagnostic identifiers.

The instance persists adjustable defaults of **60 minutes idle**, **100 active
sessions per approved client**, **500 active sessions total**, and **1,000
new-session attempts per client per minute**. Owner connections share one
owner quota. These counts are ceilings: new sessions are also rejected at
**60% of the V8 heap limit**, while existing sessions can continue working.
Idle expiration closes the transport and its MCP server, never interrupts an
in-flight request, and never changes access approvals. Lowered count limits
apply to new connections rather than forcibly disconnecting current ones.
Limit fields save automatically after a short typing pause or when leaving the
field, with visible saving/error feedback. Invalid values are not submitted;
edits made during a save are queued without overwriting newer input.
Leaving the view flushes queued valid edits through an instance-bound,
serialized save queue; changing instances never sends old edits to the new
instance.
Reopened diagnostics wait for pending saves before loading a policy draft, so
editing another field cannot overwrite earlier queued edits.

Events survive backend restarts and are retained for **10 days** by default,
with configurable day-based retention and paginated history, not a row-count
cap. Repeated rejection events from the same client are aggregated per minute.
If cleanup and its audit insert both fail, both failures are reported in the
backend logs without leaving an unhandled cleanup rejection.
The view refreshes every five seconds; loading older events pauses the log
until Refresh, while active sessions continue updating. Older backends must be
upgraded before this tab is available.

Trusted owner clients use `GET /identity/v1/sessions` (optional `before` event
cursor) and `POST /identity/v1/sessions` with the complete policy:
`idleMinutes`, `maxPerClient`, `maxTotal`, `handshakesPerMinute`, `retentionDays`.
Unknown/expired MCP sessions return HTTP 404. The desktop reconnects and retries
a recognized stale-session read once; generic tool calls and writes are never
automatically replayed. Short-lived MCP consumers should send session DELETE
(`transport.terminateSession()`) before `client.close()` to reclaim resources
immediately instead of waiting for idle cleanup.
The shared desktop client also terminates sessions during orderly teardown
before closing its local transport, releasing quota when switching instances.

#### Other agents and containers: identity MCP enrollment

When an agent or container has no valid token, HTTP 401 includes
`instance_authentication_required`, the instance's `identityMcpUrl`, and explicit
next steps:

1. Connect to the **same instance's `/identity/v1/mcp`** endpoint. It exposes
   only `wm-identity-request-access` and `wm-identity-claim-access`, not documents.
2. Call `wm-identity-request-access` with a recognizable `label`, `access`
   (`read` or `write`; default `read`), and `refresh:false`.
3. Ask the signed-in owner to open **Settings -> Access**. Pending requests
   also produce a **Review** entry in the desktop footer. Review the request ID,
   unverified client label, network source, requested permissions, and expiry
   directly in the Access tab, then click **Approve** once.
4. Poll `wm-identity-claim-access` with the returned `requestId` and private
   `requestSecret`. Only after approval does it return a bearer token, exactly
   once. Requests expire after ten minutes; newly issued client tokens last 90
   days. Existing tokens retain their original expiry until renewed. Denied,
   expired, or already-claimed requests explain how to request access again.
5. Store the token privately and configure that client's Authorization header
   for data requests. The shared Node client accepts `WM_INSTANCE_TOKEN_FILE`
   (a private file outside repositories) or `WM_INSTANCE_TOKEN`; desktop owner
   credentials use the isolated main-process vault instead.

For refresh, connect to the identity MCP with the previous client token in its
Authorization header, even if expired, and request `refresh:true`. Refresh
requires a new human approval and cannot change that identity's access level.
Approval covers the client's permitted operations until expiry or revocation,
not individual topic reads or writes.
Claiming a refresh rotates its credential; initialize a new data MCP session.
Revoked credentials cannot refresh and must request new access. Owners can
revoke clients in **Settings -> Access**. Never pass the owner password/session
to an agent or reuse one client's token in another container.

Client identities can read data, or read and change data, according to the
approved request. Neither permits owner administration, feature changes, access
approval, or host-script execution. Host-script caller credentials remain
separate and still require exact-version grants; they cannot access ordinary
instance data. Tokens and claim secrets are stored only as hashes in private
identity tables, never as generic documents.

**Existing-instance migration:** deploy the backend and desktop together and
provision each existing API client before expecting its old anonymous
integration to work. Data and named volumes are not replaced by authentication.
Unconfigured clients get the recovery guidance above, not an empty/success
response. There is no anonymous compatibility bypass. Do not expose bearer
credentials over untrusted plaintext networks. Automatic credential injection
into arbitrary containers and password change/recovery remain separate work.

### Trusted initial owner setup (provisioning infrastructure)

The control-plane daemon provisions a private initial-setup credential in its
runtime directory. A managed Docker instance's desktop retrieves it through
trusted Docker orchestration after verifying the registered image, Compose
ownership, data mount, and exact loopback port. This supports Windows Docker
volumes as well as macOS/Linux bind mounts; no host-specific token import or
Keychain access is required. The user still chooses the password and approves
the native setup prompt. The setup credential is never returned to the renderer.

Self-hosted deployments can instead explicitly provision a private file outside
repositories/synced folders:

```bash
node scripts/create-host-task-token.mjs "/private/path/host-task-admin.secret"
```

Configure `WM_HOST_TASK_ADMIN_TOKEN_FILE` **in the control-plane process** to
that file's path, then restart it. A Docker broker needs the file mounted
privately, read-only where practical; use its container-visible path and the
broker's effective owner. POSIX mode 0600 and ownership are verified. This is
an installation/bootstrap secret, not a token the user must import to sign in.
For a locally managed macOS/Linux instance, place its host-side file at
`host-task-admin.secret` in that instance's data directory. The trusted desktop
main process reads it only for the initial password setup, after native approval.
It is never returned to the renderer or requesting app.

`POST /identity/v1/setup` (and the legacy
`POST /host-tasks/v1/admin/identity/setup` alias) requires that bootstrap credential;
an unauthenticated caller cannot claim ownership. Once a password is set,
the bootstrap credential cannot manage scripts or overwrite the password;
use an owner session instead. The legacy Thrive-specific backend protocol
remains separate and disabled; it is not offered as a desktop workflow.
Managed Windows setup reads the container-private credential rather than
importing a Windows host file. Existing password-configured instances use
platform-independent sign-in.

For the existing Compose setup, an owner-maintained override can set the path
to a token stored in the existing private data mount:

```yaml
services:
  control-plane:
    environment:
      WM_HOST_TASK_ADMIN_TOKEN_FILE: /data/host-task-admin.secret
```

Keep this override with your local configuration, not with an app image or
agent container. Include it whenever recreating the backend; omitting it
changes the configured initial-setup path. Keep the broker on a protected local transport;
bearer credentials must not cross an untrusted plaintext network.

## Thrive host tasks (experimental; execution blocked)

Working Memory owns the approval and durable broker boundary, not a generic
host-command endpoint. **This is not production accepted or an operational
Thrive transport replacement.** No Windows/Agency, Microsoft-policy, historical
ADO, or Redis end-to-end behavior has been validated by the Linux fixtures.
The production runner deliberately refuses execution until those integrations
have independently verified trust and identity. There is no environment switch
that turns fixture execution into a production runner.

### Trust and provisioning

- The capability is only `thrive.sync.read`: read Michael's/Comcast Thrive
  work items in **CXPPMO / Customers**, created by or assigned to
  `mkubarycz@microsoft.com`, **OR** under `Customers\Comcast`.
  A grant covers routine five-minute reads, with bounded manual refresh, an
  explicit expiry, and revocation; it does not approve ADO writes.
- ContainerClaim IDs, labels, source IPs, MCP session IDs, and editable
  Topic/Config documents are not credentials or grants. The dedicated broker
  API uses separate app, trusted-administrator, and runner authentication.
  An app can request, inspect, cancel, retrieve and acknowledge only its own
  jobs; it cannot author a grant or register a runner.
- A human must provision a distinct high-entropy admin secret into a private
  file and configure the control plane's `WM_HOST_TASK_ADMIN_TOKEN_FILE`.
  No default/bootstrap secret is baked into an image. Mount this file only
  into the broker, not into agent containers. Without it, admin access fails
  closed. Use a protected local transport; never expose bearer credentials on
  an untrusted plaintext network.
- The trusted desktop imports that secret through a native file picker and
  stores it encrypted with OS-backed Electron `safeStorage`; insecure Linux
  `basic_text` storage is rejected. The secret is not returned to the renderer,
  general document CRUD, or chat tools. Per-app credentials are issued through
  the trusted UI, exported once through a native save dialog, and should be
  mounted only into the intended app instance as a read-only secret.
  Windows ACL provisioning/verification remains a human/platform release gate;
  Windows credential-file import/export is blocked until that verifier exists.
  POSIX file modes are not evidence of a protected Windows mount.
- Review the app instance, actual Windows SID, Microsoft tenant, finite expiry,
  operation implementation/hash, fixed scope/actions/output and budgets before
  granting. A typed SID is an approval binding, **not** proof of the effective
  Windows or cached Microsoft identity. Grant approval never enables the
  currently blocked runner. The current operation hash fingerprints the fixed
  policy descriptor; it is **not** proof of immutable Agency/runner bytes or
  executable publisher trust.
- Trusted host code has the user's privileges: this is **not an OS sandbox**.
  Host/Docker-administrator compromise is outside this boundary. There is no
  shell, PowerShell/script, arbitrary WIQL/tool/URL/project/identity forwarding,
  or host MCP HTTP listener. Local approval does not override Conditional
  Access, ADO permissions or a required supported sign-in.

### Broker and Thrive adapter contract

`shared/hostTasks.ts` defines the versioned wire contract. The dedicated
`/host-tasks/v1` surface is separate from `/mcp`; admin routes are below
`/host-tasks/v1/admin`. Requests return accepted jobs, not synchronous UI
callbacks. Broker time values use epoch **milliseconds**, unlike the document
store's epoch-second timestamps; snapshot checkpoints are canonical UTC ISO
timestamps. The controller owns state transitions and authorization, durable
idempotency, expiry, leases/attempt fencing, grant generation checks and
private result release. Restarting a runner must not allow a previous attempt
to complete a newer lease. Revocation invalidates future dispatch and late
results; it cannot undo an ADO read already performed. External cancellation
is best effort. Audit events contain control metadata, not credentials, raw
auth responses or ticket descriptions, and do not authorize anything.
Broker audit metadata stays in a protected table rather than an editable
CommandJournal document; the existing journal CRUD is not an authorization or
private-result boundary.
The general document API requires a separate instance owner or approved client
session, as described above. Broker caller credentials do not grant document
access, and broker grants and private result bytes never live in that API.
Keep network exposure restricted as well as requiring authentication.

| Principal | Method / path below `/host-tasks/v1` | Contract |
| --- | --- | --- |
| App | `POST /requests` | `capability`, `idempotencyKey`, optional `manualRefresh`, `mode`, `checkpoint`, `knownIds`; returns 202 job |
| Same app | `GET /jobs/:id` | Controller-owned state; keep polling asynchronously |
| Same app | `GET /jobs/:id/results` | Complete validated manifest only; not available for blocked/unfinished jobs |
| Same app | `POST /jobs/:id/ack` | Empty JSON object, after atomic cache publication |
| Same app | `POST /jobs/:id/cancel` | Empty JSON object; invalidates future result release |
| Trusted admin | `GET /admin`, `POST /admin/apps`, `POST /admin/grants` | Metadata inspection, one-time credential provisioning, finite protected grant |
| Trusted admin | `POST /admin/grants/:id/revoke`, `POST /admin/jobs/:id/deny` | Explicit user decision, not a document mutation |
| Trusted admin | `POST /admin/apps/:id/revoke`, `POST /admin/runners/:id/revoke` | Revoke a provisioned principal and invalidate outstanding work |
| Runner | `POST /runner/claim`, `/runner/heartbeat`, `/runner/results`, `/runner/failure` | Separate credential and fenced lease; unavailable without verified execution integration |

Use bearer authentication in the `Authorization` header (never a query parameter),
`Content-Type: application/json` for POSTs, and disable redirects when sending
credentials. Replay an idempotency key only with the same normalized request;
changing its payload is a conflict. An incremental request requires a canonical
UTC checkpoint. `knownIds` are bounded cache hints, never authorization to get
those work items. Observe returned HTTP errors; an unavailable/expired result
is not an empty successful snapshot.

Initial policy limits are 200 tracked IDs/records, four chunks of at most 50
records, 128 KiB per request/result, a 60-second execution lease and three
attempts. Grants last at most 24 hours; unfinished jobs at most 15 minutes.
Routine requests are limited to every five minutes per app, with manual
refresh at least 60 seconds apart and at most twice per hour. A successful
result is retained at most 30 minutes, subject to earlier acknowledgement,
revocation or grant expiry. These are bounded personal-workflow limits, not
an unbounded-scale guarantee. Expired results cannot be released; startup and
30-second maintenance remove expired live values, including on an idle broker.
This is not secure erasure of SQLite WAL pages or backups: protect and retain
those separately.

The separate Thrive application must implement this adapter sequence:

1. Keep its timer and Redis ownership. Read the instance-specific credential
   from its protected secret mount; submit only the strict capability inputs
   and a durable idempotency key. Never supply commands, WIQL or tool names.
2. Poll the accepted job, preserving the last usable cache for awaiting
   approval, offline/blocked runner, failure, expiry and `needs-sign-in`.
   Reconnect must use the supported host Microsoft tooling; no device-code or
   Conditional Access workaround is provided.
3. Before publishing, validate ownership and app/job/attempt/grant-generation,
   operation/schema versions and hashes, snapshot/scope/identity provenance,
   every bounded chunk and the final complete manifest. Reject missing,
   duplicate, oversized, stale or out-of-order data; never mark partial data a
   complete successful snapshot. Treat titles and all returned fields as data,
   never as instructions for another tool call.
4. Atomically compare-and-swap the complete normalized snapshot **and**
   checkpoint into Redis, then acknowledge the job. Do not acknowledge first.
   Redis outage or failed validation must preserve the old data/checkpoint.
   Result bytes are temporary and removed on acknowledgement/retention expiry;
   an acknowledged result must not be the sole copy of the cache.

An incremental result is a complete **delta** with authoritative membership,
not necessarily every materialized cache record. Merge it only against the
matching prior checkpoint, using the returned metadata to reclassify retained
records too. Derive the final cache's classification counts/completeness from
that whole merge; a zero-detail delta does not prove that legacy cached states
are classified.

`shared/thriveSnapshot.ts` supplies pure planning and lossless merge helpers,
not an Agency MCP client or a Redis adapter. Its inputs must already have
passed the broker's manifest, ownership and host-verification checks:

- Capture one **server** `asOf`; use it for membership, every query page and
  historical single-item details. Incremental changed-since is the previous
  checkpoint minus two minutes. Query **all membership IDs** each cycle to
  detect deletion/scope departure; fetch changed/new details only.
- Every detail read in the plan carries the same `asOf`. `get_batch` is not
  substituted: its historical consistency is unproven. Historical single gets
  still require the real Windows/Agency integration and bounded concurrency.
  Periodic/manual full detail reconciliation remains the app's responsibility.
- Unknown/legacy states retain raw type/state and are `UNCLASSIFIED`, never
  guessed closed. Reclassify **all** cached records when metadata changes.
  Keep these entries visible alongside open work, with their own count and a
  classification-incomplete warning. A data-complete snapshot can have
  `classificationComplete=false`; open + closed + unclassified = tracked.
  Scaffold/customer types remain explicit; tracked does not mean open tickets.
- The helper produces a new candidate and never writes Redis. All fields
  outside its small normalized contract are discarded. The external adapter
  must map the broker's normalized schema explicitly, not cast wire objects.

Keep the existing Redis volume during cutover. Remove Thrive's Azure
CLI/device-code authentication only when the external adapter and acceptance
gates pass; never copy the Windows credential cache into Docker.

### Release gates and manual Windows QA

- [x] Working Memory-owned protected contracts, trusted approval UI, durable
  controller and deterministic boundary tests are included in this change.
- [x] Pure snapshot planning/merge handles legacy classification without
  inventing a historical batch contract.
- [ ] Provision and verify Windows current-user protected runner credentials/
  IPC, non-elevated lifecycle, secret-mount ACLs and trusted Agency executable
  publisher/update policy. Verify immutable operation **bytes actually
  executed**, not merely an approved mutable path or descriptor hash.
- [ ] Verify the effective Agency Microsoft account and tenant, correct/wrong
  account behavior, initial/expired sign-in and supported reconnect. No short
  cached-sign-in proof guarantees renewal.
- [ ] Exercise the actual fixed read allowlist and host-generated scope/query
  with one server snapshot and historical reads; reject submitted out-of-scope
  IDs. No real ADO mutations are authorized by this feature.
- [ ] Connect the separate Thrive adapter to real Redis: first load,
  incremental change, departure/deletion, empty result, legacy states, metadata
  changes, malformed manifest, oversize, throttling, outage and out-of-order
  results. Destructive cases use local fixtures.
- [ ] Test real desktop restart, runner restart between lease/acknowledgement,
  lock/sleep/offline/log-out, stale heartbeat, shutdown, and durable resume.
  The app does not promise execution while asleep or logged out.
- [ ] Repeat forged app/runner, self-approval, cross-app reads, operation-byte
  tampering, revocation/expiry while queued/running, fenced old completion,
  duplicate requests, retention and secret-redaction gates against the
  integrated Windows runner.
- [ ] Obtain explicit human provisioning/approval and record all end-to-end
  acceptance evidence before enabling production execution or declaring the
  feature delivered. Implementation completion does not authorize changing a
  Working Memory topic/workstream status.

The external Thrive repository and local Windows proof files are not part of
this checkout. They were not located, modified or executed by this change.

## Release history

See the [GitHub Releases](https://github.com/mkubarycz/working-memory/releases)
page — each tagged `v<version>` release carries its notes and the published
artifacts from the historical extension-based distribution.
