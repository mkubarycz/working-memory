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

**Prerequisite:** a running local Docker or Podman installation with Compose support.
Docker Desktop is supported; Podman Desktop is not required.
Installers only install the app; the data tier is managed from inside it.

On launch, Working Memory connects to a running data tier if one is
reachable (for example an existing `working-memory-control-plane` on
`127.0.0.1:7717`). Otherwise it checks the selected provider, loads the
prebuilt control-plane image bundled in the installer, and starts its default
instance with Compose, creating it on a fresh install. Loading the
image can take a few minutes. No npm downloads, local image builds, registry
login, or backend registry access are needed on the installed computer.
CI builds Linux ARM64 images for Mac installers and Linux x64 images for
Windows installers. Local `npm run build` / packaging builds the image using
Docker first; CI supplies it via `WM_DATA_TIER_IMAGE_ARCHIVE`.

Choose **Docker** (the default) or **Podman** under **Settings > System >
Container Provider**, or in the startup dependency dialog. The selection applies to
both managed backends and Container Apps. Executables, safe local connections, and
Compose invocation are resolved internally; there is no fallback to another engine.
Working Memory never launches Docker Desktop or starts a Podman machine. Install and
start the selected provider yourself, then use **Retry** if its CLI, engine, or Compose
support is unavailable. Podman requires an installed external Compose implementation
(`podman compose version` must work); both Docker Compose and podman-compose are supported.
Native Linux Podman and local Podman-machine connections are supported; remote TCP/SSH
engines are rejected. Docker continues to use local Unix-socket/named-pipe contexts.
Without an explicit context override, Docker uses the CLI's active context, including
local providers such as Colima; unavailable or remote contexts do not trigger fallback.

Changing provider is **not a database migration**. Existing registrations belong to
their original engine/connection (legacy registrations belong to Docker). The app
refuses to manage those registrations through another engine, recreate missing
registered data, or switch an environment's existing stateful Container Apps to
another provider. Return to the original provider to manage that data. New Windows
instances explicitly create engine-owned volumes; Compose treats them as external
and cannot silently create replacement volumes. No provider action deletes volumes.
Starting a stopped registered backend validates its existing database or volume before
the engine start command, just as recreation through Compose does.
Legacy backend registrations are pinned only after their container image, Compose
labels, data mount, loopback port and existing storage are verified; listing alone
does not adopt them. Stopped legacy containers are checked against configured port
bindings; running containers and owner setup still require live loopback bindings.
Failed new-instance provisioning keeps a per-port reservation so Retry reuses
the same storage, including after desktop restart; a missing Compose dependency does
not reserve an engine. After an installer update, Retry reconciles a pending bundled
image with the new archive while preserving its provider, connection, port and storage.
Pending bind storage also records initialization and refuses
to recreate a lost data directory or a database known to have been initialized.
Stateful legacy Container Apps must be adopted from their
verified Docker container and existing volumes, never inferred as new Podman storage.
Returning to a recorded app's original provider is allowed. On a stateful app's first
desktop Run, a native confirmation can explicitly initialize new empty storage if no
container, ownership record or existing volume is found. Cancel is the default:
only confirm for an app that has never stored data, not to recover a legacy app.
An existing unverified volume or recorded owner is never overridden by this action.

Open **environment menu > Manage instances…** (or **Settings > System > Backend**) to
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
  newest published rolling or Stable build, and **Stable** follows the latest
  non-prerelease tagged release.
  Canary and Stable images are pulled from
  `ghcr.io/mkubarycz/working-memory-control-plane`.
- **Update to <version>** appears when an instance runs a different version
  than the channel's target; it recreates the container with that image and
  keeps its data.
- **Current version** shows each instance's container-image version. If the
  container list only returns an image ID, Working Memory inspects that managed
  container to recover its configured image tag. Unknown versions are labeled
  explicitly, rather than implying the instance is up to date.
  Inspection errors remain visible without discarding known container states,
  versions, or updates for other instances.
- **Rename** changes the display name shown in the environment picker.
- **Back up…** writes a consistent SQLite snapshot
  (`working-memory-<name>-<timestamp>.sqlite`) to a folder you choose
  (default: Desktop). The instance must be running, and you must be signed in
  as its owner. The backend creates the snapshot using its already-open store;
  the desktop copies only that finished snapshot from the container.

Managed instances are recorded in the app's `data-tier/instances.json`
(`~/Library/Application Support/Working Memory` on macOS,
`%APPDATA%\Working Memory` on Windows). Data lives in:

- macOS: `~/Library/Application Support/WorkingMemory` (bind mount); other
  ports use `WorkingMemory-<port>`.
- Windows: the selected engine's volume `working-memory-data` (SQLite WAL is unreliable
  on Windows bind mounts); other ports use `working-memory-data-<port>`.

On macOS, a separate read-only SQLite process opening a live database on a
Docker bind mount has reproduced a backend `SIGBUS` (exit 135); database
corruption was not demonstrated. The managed desktop **Back up…** path now asks
the owning backend process to create its snapshot. Backend diagnostics and
incident/heap reports also use that process's existing store handle. The
resource-ID maintenance command below takes an offline-maintenance marker that
prevents this version of the backend from starting while it accesses the
database. These protections cover those supported Working Memory paths only:
they do not establish that arbitrary SQLite tools, older backend builds, or
other host/container processes can safely inspect a live bind-mounted database.
Stop the backend before external inspection or maintenance, and do not copy the
live database files as a substitute for a snapshot. Existing storage is not
automatically moved to a Docker volume.

Set `WM_DATA_TIER_AUTOSTART=0` to disable automatic data-tier startup.
This controls backend containers only, never provider startup.

Podman support is intended for canary feedback before Stable 1.7. Automated provider
fixtures cover lifecycle, upgrade persistence, Container Apps, ownership refusal and
diagnostic normalization. These tests are not evidence of real Windows/Podman
validation. Before release, exercise fresh install, provider restart, backend upgrade,
stateful Container Apps, owner bootstrap and crash/health diagnostics on Windows with
a real Podman machine and both Compose implementations. Installer-image preparation
and CI still use Docker; this is developer/release tooling, not an installed-app
Docker dependency.

Builds are not code-signed or notarized yet. On macOS, use **System Settings >
Privacy & Security > Open Anyway** (or `xattr -dr com.apple.quarantine
"/Applications/Working Memory.app"`). On Windows, choose **More info > Run
anyway** at the SmartScreen prompt. Intel Macs are not packaged; build locally.

The macOS development build (`npm run compile:desktop`) still installs
`/Applications/Working Memory.app` directly and uses your existing control
plane.

### Desktop updates

**Settings > System** contains **Front End**, **Backend**, and **Container Provider**.
Backend instances are cached across navigation and refreshed every 15 seconds
while the tab is visible; starting instances also receive faster health checks.
Refresh failures leave the last known list visible and show an error with Retry.
**Settings > System > Front End**
picks the desktop update channel: **Off**, **Canary**
(the newer of the rolling `canary` build and the latest Stable release), or **Stable**
(the latest non-prerelease `vX.Y.Z` release). Installer builds default to
Canary for `-build.N` versions and Stable for tagged versions; local
`npm run build` builds default to Off. The app checks 15 seconds after launch
and every six hours, then offers **Download** and **Restart and install**.

Canary compares the manifests' build publication timestamps, not their version
strings or the rolling GitHub release's original creation date. A newly tagged
Stable build therefore also becomes the Canary target until a newer rolling
build is published; a later rolling build can win even if its base version is
lower. Equal timestamps prefer Stable. Both desktop and backend channels use
this rule. Missing releases (HTTP 404) are allowed, but failed checks or invalid
comparison timestamps are reported rather than silently selecting an older build.

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
5. Assign that profile in the **Routing matrix** section of **Settings > Models**.
   Model profiles, routing and Human settings save automatically after a short pause
   or when leaving a field/view. Saving and validation errors are shown; incomplete
   profiles must be completed before the configuration can be saved. Chat currently uses
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

## AI-driven document search

Search is experimental and **off by default**. The instance owner can enable
**Working Memory search** in **Settings > Features**. The choice is persisted
per instance. Turning it off hides/closes Search, stops active requests and
blocks search IPC and MCP discovery/query execution without changing documents.
Expanded flags use `/features/v2`; `/features/v1` retains its Host tasks-only
contract for existing desktops. New desktops fall back to v1 only when v2 is
unavailable, preserving Host tasks while leaving unsupported Search disabled.

When enabled, click the magnifying glass beside Refresh in the upper-left rail to open a
permanent **Search** tab. Describe what you want to find in natural language,
then select **Search**.

Enter submits the query; Shift+Enter inserts a newline. Use the page icon in the
textbox's upper-right corner to toggle **Multiline mode** (white when off, dark
when on) for chat-style expanded composition: Enter inserts newlines and
Ctrl/Cmd+Enter submits. Switching modes preserves the text.

Single-word searches such as `nanites` or `bank` return local matches without
calling an AI model or performing AI-selected source reads. Add to the search
text to narrow results; there is no separate AI refinement action. Normal
result caps and bounded indexed text are shown as top matches, not as evidence
errors or tool failures. Longer requests use the configured
**Medium / Complex** model profile and a host-controlled, read-only tool loop:

1. Search retrieves local evidence before asking the AI to interpret the request.
   Exact whole-word/phrase matches are returned first, including matches below
   the semantic relevance cutoff. Searching `bank` shows documents containing
   that word before semantic-only matches or suggestions for narrowing it.
   The AI uses the document/workstream selected when opening Search as context.
   Retrieved rows display immediately, before AI configuration or refinement.
   Refinement runs without blocking those rows; cancellation or a model failure
   leaves retrieved results available and explicitly reports the interruption.
2. AI chooses local semantic searches or structured document queries, follows
   workstream membership/parent/type relationships, reads bounded body chunks,
   and can retry different strategies. Structured filters/counts run in SQLite
   before paging; literal queries scan stored search projections rather than
   rebuilding every document's text, and preserve version strings such as `1.5`.
   Body ranges are sliced in SQLite; `bodyOffset`, `bodyLimit`, `bodyLength` and
   `nextBodyOffset` count Unicode code points. AgentMessage evidence includes
   searchable scheduling, recommendations, decisions and relationships, not
   opaque metadata. Ranked excerpts are SQL-capped at 1,200 code points.
3. Discovery embeds the search phrase using the same local model/index as
   Related topics, then ranks supporting passages across readable Topics,
   Workstreams, AgentMessages, CommandJournals, TopicTypes, Agents and
   ContainerClaims. Only safe searchable projections are indexed, never Config
   values or arbitrary journal/tool payloads. Connected applications are excluded
   from this Search surface: no app catalog, discovery or app tool calls.
4. AI returns typed summaries, linked lists, tables, verified query counts or
   clarification suggestions. Titles/statuses come from actual sources; invented
   source IDs and unsupported counts are rejected. Narrative summaries are
   always evidence-cited, even after an unrelated empty query, but not mechanically
   proven factually correct. Matching documents are retained even if the AI
   only asks a clarification; optional refinements follow the results.
   An empty semantic retrieval means zero sufficiently
   similar passages, not proof the information does not exist. Exact totals
   require structured query evidence.

Open results to browse and return to Search without losing the request, original
scope, results or completed retrieval trace.
Closing the Search tab clears that session; reopen Search from another document
to start fresh with that document's context.
Search and Related topics use the same compact tree-style result widget with
separate **Relevance** and **Confidence** labels and supporting Markdown quotes,
collapsed by default. Relevance is raw cosine similarity, not a probability.
Confidence is a local, transparent evidence-strength heuristic: High means a
verified exact word/phrase occurrence, or passage cosine >= 0.65 and document
cosine >= 0.50 with complete coverage; Medium means passage cosine >= 0.45 and
document cosine >= 0.35; otherwise Low. Passage and document agreement uses the
same query vector. Limited coverage prevents semantic High. Exact-term High
verifies occurrence, not the intended meaning; tooltips explain each rating.
Structured-only results show unavailable scores rather than inventing them.
Read enrichment preserves scores, term-match evidence and supporting passages
only when the document version still matches.
Document links in results, tables and citations can be dragged like rail
items: they provide a Markdown link and, once prepared, a native Markdown
context attachment. Topic drops onto a workstream add the topic tree without
removing existing memberships; open workstreams can be reordered in the rail.
Topic handles share their preparation/drag controller and right-click menu with
Related topics. Topic results offer **Add Child...** and **Add to workstream**,
not removal or pinning. Children use the parent's sole workstream, otherwise
the picker asks which workstream to use. Membership addition requires an explicit choice of an
open workstream (Queued, In Progress or Backlog). This adds membership only:
existing memberships, focus pins, parent links and topic status are preserved.
The dedicated membership action checks the Search flag and open workstream
inside the topic write transaction. Closed workstreams are excluded; concurrent
topic edits produce a visible conflict rather than overwriting newer membership.
Model, transport and save failures remain visible and retryable; search never
falls back silently to an unranked full-store listing.

Search is bounded to eight model turns, 24 tool calls and
90 seconds per request. The initial host retrieval counts toward the 24-call
total. Batches of evidence reads execute sequentially within that remaining
budget; there is no separate four-call-per-turn limit. Budget errors report
the total, calls already used and size of the rejected batch.
Model evidence/context and semantic result counts are
bounded; incomplete pages/body chunks, truncated responses and tool failures
are visibly marked. Cancel stops follow-up calls and signals pending query
inference/MCP requests without disconnecting shared clients. A busy host (HTTP
409) is retried until cancellation or the inference deadline, with backoff
starting at 500 ms and capped at two seconds, never replaced with keyword results.
Local query inference allows up to 60 seconds, including cold model startup;
the desktop MCP client allows 70 seconds for that tool so the backend can return
a useful timeout error before the client expires. The overall Search deadline
remains 90 seconds. Initial retrieval failures appear in read-only activity with
their elapsed time, even when no documents have been returned.
External indexing callers need `content.read`, `settings.read`, and
`settings.update` for `wm-embeddings-next`, because pending work can include
settings documents as well as content. Update permission alone never authorizes
reading their passages.
Activity separates each AI turn from retrieval calls and shows local-model
startup (including cache verification/loading), inference, ranking and host
round-trip times. Host round trip includes transport and busy retries; startup
is zero for an already-loaded helper, or unavailable with an older host.
New hosts add timing metadata only for callers opting in with
`X-WM-Embedding-Metrics: 1`, preserving strict response shapes for older containers.
Switching environments cancels searches
and discards stale results. Read-only activity is inspectable without storing a
write-only CommandJournal or exposing model chain-of-thought.

AI-driven Search uses existing AI configuration for conversation and the
**local embeddings index** for retrieval. Search requires Embeddings enabled
and complete indexing of the caller's readable WM documents. Disabled/pending
states are checked before any AI call and before semantic retrieval; edits
during query inference are checked again before returning results. A paused
but fully indexed corpus remains searchable. Indexing the first 32,000 body
characters counts as indexed; later text remains outside semantic coverage,
and AI answers using incomplete evidence are marked partial. Local match lists
instead indicate their bounded retrieval without implying a failed read.
No keyword/partial-index fallback is
used by this surface. Only retrieved evidence is supplied to the configured model,
not the entire store; Config secrets are excluded and tool output (including
JSON embedded in MCP text) is redacted. Sanitizer limits mark answers partial.
AI explanations are rendered as plain text, not executable Markdown/HTML.
Expandable source quotes use the normal safe Markdown renderer and the selected
environment's attachment URL.

The read-only `wm-semantic-status` reports enabled/readiness and readable
document coverage without contacting the host. `wm-semantic-search` accepts
`{ "queries": ["Trouble signing into the service"], "kinds": ["Topic"], "limit": 20 }`
and returns versioned sources with the best supporting passage, raw cosine
`similarity`, and a `limited` coverage/result-cap marker. Permissions are
rechecked and filtered before ranking/limits. Related topics still returns only
Topics even though the shared index covers other document kinds.

MCP callers use the same read-only retrieval as desktop Search. For topic-only
search, call `wm-semantic-search` with
`{ "queries": ["health"], "literalQuery": "health", "kinds": ["Topic"], "limit": 20 }`.
`literalQuery` prioritizes exact text matches; results include relevance,
evidence confidence and source IDs. Use `wm-document-query` for literal filters,
exact counts, workstream membership or full source reads. Conversational AI
interpretation remains desktop-owned, not an extra MCP or HTTP search endpoint.

Agents can call the read-only `wm-document-search` tool with
`{ "queries": ["authentication", "sign in"], "kinds": ["Topic"], "limit": 20 }`.
Each phrase matches all of its stemmed words; alternative phrases are combined
with OR. Results include `id`, `kind`, `title`, `excerpt`, and a BM25 `score`
(higher is better). Permission filtering happens before the result limit and is
rechecked on each request. The desktop chat assistant receives and recommends
this tool only when Search is enabled; otherwise it uses existing read filters.
If feature settings are unavailable, ordinary chat logs the failure and omits
Search after a bounded probe, without blocking its other MCP tools or changing
the 404-only feature-version fallback.
The existing `wm-document-read.query` substring filter remains unchanged.

The control plane alone owns the derived FTS5 index. Startup backfills existing
live resources without rewriting their source, timestamps or resource versions;
transactional triggers keep create/update/delete/restore and rollback consistent.
Persistent triggers only enqueue changed resource row IDs using built-in SQL.
Connection-local triggers maintain projections on upgraded writers; older
backends can still write without registering `wm_search_text`. Queued legacy
changes are repaired on startup or before the next search without rewriting
authored resources. Startup replaces earlier experimental function-dependent
triggers, so run this backend once before rolling back an experimental database.
Kind descriptors supply searchable text, including Config's key-only projection
that excludes configuration values. As with all resource writes, connections must
be opened through `openStore` to install the local projection function and triggers.

### Local embeddings and Related topics (V1)

With Search and Embeddings enabled, saved topics show **Related topics**:
semantic candidates ranked by vector similarity.
Results include supporting passages and label existing parent/child links;
they never create links or modify authored documents. Compact topic-tree-style
rows show a relevance score (vector cosine similarity, not a confidence
percentage). Supporting Markdown passages are quoted beneath the title when
expanded; they start collapsed. The section is hidden
when Embeddings is disabled, without running related-topic retrieval. Pending
source topics show an indexing message, not keyword substitutes. Ordinary
keyword MCP search remains available separately; desktop Search uses semantic retrieval.

Related topic handles share drag handling with the workstream tree: drag to the
left rail or export the same Markdown context attachment to VS Code. Their
right-click menu offers **Add to workstream** and **Add Child...**, not removal
or pinning. Child creation uses the parent's workstream when there is exactly
one; otherwise it asks for an open workstream before opening the normal form.
Search and Related topics share the result component, topic actions and workstream picker.

Enable local indexing with the **Embeddings** switch in **Settings > Features**.
Monitor progress and use pause/resume or retry in **Settings > Diagnostics > Embeddings**. Enabling downloads
the pinned Apache-2.0 [MiniLM model](https://huggingface.co/sentence-transformers/all-MiniLM-L6-v2)
(about 87 MiB) once, verifies file sizes and SHA-256 hashes, and caches it in the
desktop profile. WM document text is processed locally, not sent to Hugging Face.
The bundled helper includes its runtime; users do not install Python or a model
server. On macOS, background Embeddings and MCP connector processes forward app
activation and resource links to the desktop UI, without stopping background work.
Starting a background process alone does not open a desktop window.
Developers building the desktop need Python 3.13 (`WM_EMBEDDING_PYTHON`
can select its executable); build each installer on its native target OS.
The build creates an isolated environment from
`native/embeddings/requirements.txt`.

The control plane owns the background indexing worker: it selects changed
searchable WM documents, reuses their safe stored search projections, prepares
bounded passages, calls the host inference service, and accepts
vectors only while the document content version remains current. Existing
Topic text/hash representation is preserved, so valid Topic vectors are reused
while other kinds join the index. Enabling indexing
persists settings in that instance, independently of the desktop's selected
environment. Each explicitly enabled local environment continues indexing after
the desktop quits and resumes after its container restarts.

WM installs a per-user host inference service on enablement: a macOS LaunchAgent
or Windows sign-in Scheduled Task. It starts at sign-in, survives desktop exit,
and runs the bundled helper over private standard input/output. No separate
Python or model-server installation is required. Indexing needs an awake
computer, a signed-in user, a running local container runtime and control plane; it does not run
before sign-in. A service restored by WM uses the current installed application
version. Updates retain model files and indexing settings.

The inference service binds **127.0.0.1:7716** and requires a random bearer
credential for every request, including status. Docker Desktop containers
connect using `host.docker.internal:7716`; the credential is stored in the local
profile and the instance's private configuration, never returned in diagnostics
or queue inspection. Only fixed-model, bounded embedding requests are accepted;
no arbitrary model paths or executable commands are exposed. Service logs live
under the profile's `embeddings` directory. Remote environments cannot be enabled
against this local bundled service.

On Windows with Podman/WSL, WM additionally discovers private IPv4 addresses on
Windows `vEthernet (WSL...)` interfaces and binds authenticated listeners there,
after validating that the selected Podman connection belongs to a WSL machine.
It does not open a wildcard or LAN-adapter listener, change VM networking mode,
or reset the machine. Enable/Resume/Retry configure that private endpoint and
probe candidate `/status` endpoints from the container before changing indexing
settings. The existing host bridge remains a candidate for configurations where
it already works, including WSL configurations without a private virtual adapter;
discovery/binding errors remain available in native diagnostics.
No available WSL interface, a refused connection, or a firewall block produces
an explicit error; it is not reported as a model/NPU initialization failure.
Windows firewall policy still applies; restricted hosts may require a scoped
exception for the installed application on the WSL virtual interface.
Both desktop and backend must be updated to accept private WSL endpoints.

WSL listener enablement is retained in the native service's `network-settings.json`.
The background service checks interface changes every ten seconds and keeps
loopback access and a single shared model runtime. If an enabled, unpaused
instance has a failed connection and its WSL address changed, starting WM or
opening the Embeddings dashboard refreshes its stored route automatically. Pause/Disable
and environment changes cancel stale route repair. Automatic repair uses an
opt-in configuration fingerprint and a server-side conditional host-only update;
another client's Pause/Disable or configuration change cancels it before saving,
including while endpoint discovery or probing is pending. Legacy dashboards
omit the fingerprint. Startup restoration waits for
data-tier launch and environment selection. A failed automatic repair retains the
fetched dashboard state and displays its error, keeping Pause/Retry and the
Features disable switch available. With the desktop closed,
an instance whose stored WSL address changes remains visibly failed until that
refresh or an explicit Retry; its existing vectors are retained. Host diagnostics
show currently bound WSL endpoints and listener/discovery errors.

The Windows uninstaller removes the background task. Before manually deleting
the Mac app, stop its service with
`launchctl bootout gui/$(id -u)/com.workingmemory.embeddings` and remove
`~/Library/LaunchAgents/com.workingmemory.embeddings.plist`. Cached models and
instance indexing settings are retained; an unavailable service is reported
in diagnostics rather than treated as successful indexing.

Only the control plane owns the SQLite embedding tables.
Metadata-only edits reuse vectors; changed content is
reindexed, incompatible model versions are excluded, and deleted topics remove
their derived vectors. Related lookup uses cached topic summaries, exact cosine
similarity and best-passage evidence, without running a chat model. V1 scans
topic summaries rather than maintaining an approximate-nearest-neighbor graph.

Windows packages OpenVINO and its Intel NPU plugin. Intel Core Ultra 7 165H /
Intel AI Boost is the required hardware acceptance target, with Windows 11 and
a compatible Intel NPU driver. The helper compiles the fixed-shape model for
`NPU`, caches it, and reports OpenVINO's execution devices. Missing drivers or
failed NPU compilation produce a visible warning and CPU recovery. A successful
CPU run does **not** establish NPU support. Mac packages ONNX Runtime; it reports
providers observed in a warm-up profile. Core ML permits GPU execution but that
provider label is not proof every operator executed on the GPU; CPU and mixed
execution are explicit.

The dashboard shows installation/download progress, backend, topic coverage,
last indexing success, last topic inference time, helper RSS and passage-vector
disk bytes (not total database size). Pause/disable stop that instance's indexing
but retain cached weights and stored vectors. The host serializes inference
across enabled instances. Once loaded, the helper stays warm until the host
service stops by default, avoiding repeated cold starts while holding roughly
1.1 GiB of memory. **Diagnostics > Embeddings > Keep model loaded** can instead
unload it after 1, 10, 30 or 60 idle minutes. The host-wide setting is saved
atomically in the service's `model-settings.json`, survives restarts/updates,
and applies to all local environments. It neither enables Embeddings nor starts
indexing. A new service installation uses the always-warm default; the first
use after a service restart still pays model initialization.
Connectivity failures are visible and retried automatically; invalid inference
responses halt until Retry or Resume. Retry also repairs/restarts the host service.
**Diagnostics > Embeddings > Service troubleshooting and error log** checks the
native host directly, independently of the container. It shows its connection
state, backend, installed/service versions and the actual service log location
for this desktop profile. The latest 100 log lines (up to 32 KiB) are displayed
in the app, with credentials redacted; document passages are not logged.
Installation and early startup failures are recorded even before the service
can listen. Indexing preserves the host's error detail instead of only reporting
HTTP 500. A running host with a container connection error points to container
connectivity; an unreachable host points to the sign-in service. On Windows,
check the **Working Memory Embeddings** Scheduled Task, install the current build
for missing helper/DLL errors, or update the Intel NPU driver for NPU errors.
“Not loaded” by itself is normal before first inference or after model unloading;
an `error` status is not. Retry resumes indexing for the selected environment.
Container and local host diagnostics poll independently while the dashboard is
visible, every two seconds, so a stalled container cannot block local evidence.
V1 indexes the first
32,000 body characters in overlapping passages; the dashboard and affected
topics identify that limit. The model has a 256-token passage input limit.

Validate the real packaged-helper-to-MCP path with:

```bash
WM_TEST_EMBEDDINGS=1 npm test --prefix desktop-ui -- tests/embeddingRuntime.integration.test.ts --reporter=verbose --silent=false
```

On macOS, validate the installed sign-in service with a real disposable Docker
container (it disconnects its desktop client before indexing and removes only
its synthetic container/data afterward):

```bash
WM_TEST_BACKGROUND_EMBEDDINGS=1 npm test --prefix desktop-ui -- tests/embeddingBackground.integration.test.ts --reporter=verbose --silent=false
```

This installs/restores the actual per-user host service and retains its verified
model cache. It never enables indexing in an existing WM environment.

On the target Windows PC, additionally set `WM_REQUIRE_INTEL_NPU=1`; this fails
unless the helper actually reports NPU execution. Unit/browser tests use isolated
fixtures and do not download weights. The opt-in integration test downloads only
public model artifacts and uses synthetic topic content.

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
- **reminder**: a one-time scheduled human action, with a required `due_at`
  deadline in Unix seconds and a specific `recommended_action`.

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

### Reminders

Create a reminder with the same registered agent and topic/workstream links as
other messages:

```json
{
  "agent_id": "<registered-agent-uuid>",
  "title": "Review the rollout",
  "description": "Check the rollout results and decide the next step.",
  "category": "reminder",
  "due_at": 1793507400,
  "recommended_action": "Review the rollout results.",
  "topics": ["existing-topic-id"]
}
```

Replace `due_at` with the intended deadline (`Math.floor(Date.now() / 1000) + 1800`
means 30 minutes from now). The deadline is persisted, not tied to an agent
session or desktop timer. The control plane checks every second and catches up
on startup; a stopped backend cannot notify until it resumes. The sweep searches
a partial deadline index containing only live, open reminders that have not yet
raised attention, rather than scanning retained message history. The index is
added idempotently when opening new or existing stores. No separate Alert
is created. Attention is server-owned: scheduled reminders have no attention;
due open reminders require attention. Red overdue styling is display urgency,
not a change to the reminder's informational severity.

All AgentMessages (reminders, info/completion notices, requests, approvals, and
errors) share fixed-width, horizontally scrolling cards in their linked
topic/workstream. They are not duplicated in those documents' Recent messages,
which retain conversation history and trusted tool confirmations. The global
Log retains all message history, with open reminders above other messages.
Preview cards expose all available lifecycle, Snooze, and approval decision
actions as icon buttons with tooltips and accessible labels. Expanded details
pair the same icons with text. Acknowledge uses a completion seal, Resolve an archive box,
Reopen a return arrow, and Snooze a clock. Approval decisions still require a
recorder name and do not authorize execution.
The next lifecycle action uses a pink outline and icon with no background fill:
Acknowledge for open messages,
then Resolve for acknowledged messages. Resolved messages have no highlighted
action; Reopen remains secondary.
**Show full alert** (expand icon) opens a
temporary detail stage below the slider; selecting another message replaces
that stage, and **Hide full alert** dismisses it. Reminder cards show the
requester in gray above friendly deadlines such as "Due in 8 minutes" or
"Due 3 minutes ago"; other open messages show their relative received time instead.
Acknowledged and resolved messages show "Acknowledged" or "Resolved" in that
position, consistently across message categories and compact/expanded views.
The exact timestamp remains in the tooltip. Scheduled
reminders have a gray left border; overdue reminders have a red left border.
Acknowledging stops
attention until explicitly reopened. Resolving retains completed history.
Reopening an already-due reminder immediately restores attention. None of these
actions changes topic/workstream status.

**Snooze** opens a dialog with **10 minutes**, **1 hour**, **Tomorrow**
(9 AM local tomorrow), **Next week** (9 AM local on the next Monday), and
**Custom**. Custom becomes a text field for phrases such as "in 45 minutes" or
"Friday at 2pm". Chrono parses these locally without AI or network requests;
the exact local date, time, and timezone are previewed before confirmation.
Invalid/past times, partially understood expressions (including unsupported
recurrence), multiple dates, and time ranges are rejected explicitly. Custom
input must contain only the one-time date/time expression, without extra prose.
Calendar shortcuts respect daylight-saving changes. Cancel or Escape dismisses
the dialog without changing the reminder.
It reschedules and reopens the same document, clears attention until due, and
preserves authored Markdown and attribution. Agents can use
`ws-agent-message-snooze {id, expectedResourceVersion, due_at}` with a future
deadline, or edit `due_at` through the canonical update tool. Snooze uses the
existing Content Update permission. Editing the deadline alone preserves
the current lifecycle; Snooze explicitly reopens an acknowledged reminder.
Recurring reminders and OS notifications
are not part of this feature.

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

Live changes refresh only the selected document tab. Inactive open tabs keep
their cached content and are marked stale; selecting one refreshes it with a
non-blocking **Refreshing...** indicator. Unsaved or failed local edits remain
protected, including when a deferred save completes in an inactive tab.

Drag a tab header left or right within the tab bar to reorder it. The insertion
marker shows where it will land, and dropping it does not change the selected
document or promote a preview. The new permanent-tab order is remembered per
environment.

The right-hand Chat rail starts collapsed when no preference has been saved.
Its open/closed state is remembered locally across desktop restarts, alongside
the rail widths. Explicit chat actions can still open it when needed.

In topic **Live** view, labeled Markdown links display only their label, not
their destination, optional title, or reference suffix. A plain click on a
rendered link opens it without entering editing. Editing its line reveals the
original Markdown; rendering never rewrites the stored source. Bare HTTP(S)
URLs and `www.` addresses are clickable too and continue to display their URL.
URLs inside code, image destinations, and link definitions are not standalone
click targets.

Working Memory links, including existing `http://127.0.0.1:7718/open/...`
links, open directly in the current app and selected environment without a
browser round trip. External web links still open in the default browser.

Live Markdown text uses native spell checking. Right-click a misspelled word
to choose a correction or **Add to Dictionary**; ordinary cut/copy/paste actions
remain available. Windows and Linux download Chromium spelling dictionaries, so
initial dictionary setup requires network access.
Dictionary failure monitoring is cleaned up safely when desktop windows close or
restart.

Pasting rich text into **Live** or **Source** converts clipboard HTML to authored
Markdown, preserving hyperlinks (including their display text), headings, basic
emphasis, lists, and code. Plain-text/Markdown paste remains unchanged. Image-file
paste still uses attachments, stored as `wm-attachment:` references; clipboard-only
local or embedded image URLs are not stored as broken image references. Raw HTML,
scripts, and unsupported link targets are not imported as executable markup.

Rendered images retain accessible alt text without a filename caption. Use the
magnifying-glass button or right-click **Open Image in Default Viewer** to view
the full-size image in the system's image viewer. Instance images are downloaded
through the selected environment's authenticated attachment proxy. Raster images
(PNG, JPEG, GIF, WebP, or AVIF; up to 30 MB) are opened as private temporary files,
which are removed when Working Memory quits.

## Inbox, pinned workstreams and Backlog

The left rail shows **Queue** and **In Progress** workstreams. Its backlog button
opens a page with Settings-style **Inbox**, other pinned workstream, and **Backlog**
tabs. Inbox is always pinned, keeps its existing ID and lifecycle status, and
cannot be renamed or unpinned. Its tab shows the workstream view, without the
Send to Queue/In Progress buttons. Pin or unpin other workstreams using **Pin
workstream** in their workstream view. Pinned workstreams appear only in these
navigation tabs, not in the ordinary rail or backlog sections.
Switching pinned tabs during autosave retains in-flight drafts and restores the
selected workstream when its save completes. Failed drafts remain editable with
an explicit save error.
The exact name **Inbox** is reserved: another workstream cannot acquire Inbox
protection by being renamed. Names such as **Inbox cleanup** remain editable.

The **Backlog** subtab shows workstreams with backlog status first,
above open topics that do not belong to any non-closed workstream. Topics in a
backlog workstream stay grouped under that workstream rather than appearing twice.
Expand a backlog workstream to browse its topic tree, including nested child
topics, or click its title to open it. **Send to Queue** and **Send to In Progress**
move the workstream directly from the backlog page. The page refreshes as
membership and status change. Expanded workstreams and topic nodes stay expanded
when switching document tabs or refreshing the backlog. Closing the Backlog tab or
switching environments clears that view's expansion state.

Backlog nodes use the same tree interactions as the left rail: right-click for
context-sensitive topic/workstream actions, drag between workstreams to move a
topic tree (hold Option/Alt, Ctrl, or Command to copy), drop on topics to reparent, and drag workstreams
between Backlog, Queue, and In Progress or reorder within a section. Dragged
resources also carry the same Markdown/context-file references for editors and
other apps. Unassigned topic trees can be added to a workstream without removing
any existing memberships; this requires a backend supporting source-free
`ws-topic-transfer`.
Internal moves and external Markdown-file exports use the same drag gesture,
including on Windows; no extra modifier or separate handle is required.
The shared tree uses light cards and menus on the backlog page while retaining
the dark rail palette. Move buttons wrap below titles when the page is narrow.

Workstream document trees also support topic dragging and drops. Dropping on a
topic row reparents it without changing workstream membership; dropping on the
workstream surface transfers membership, moving by default or copying with a
modifier key. **Hide closed
topics** is a persisted per-workstream preference, off by default. It affects
that workstream's trees in the rail, Backlog, and workstream/pinned views without
changing membership, topic status, or message history. Open descendants of
hidden closed parents remain visible. Different workstreams can show the same
topic with different visibility preferences; standalone topic family trees have
no workstream scope and are unchanged.

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
rail and selected document, deferring inactive tabs and coalescing bursts of changes. Pending, saving, or failed
local edits are preserved rather than overwritten. Reconnecting beyond the
bounded replay window triggers a full refresh.

Live updates require the 1.1.1 control-plane image as well as the desktop update.
Upgrade an existing data-tier instance through **Settings > System > Backend** to use
the new endpoint. Selecting an older backend shows an explicit upgrade warning;
it does not silently fall back to continuous document polling. Changing
environments cancels the previous watch and ignores stale notifications.
Document created/updated timestamps are stored as Unix seconds and displayed
in the user's local date and time.

Topic relationships, workstream trees, and the Active rail request
`ws-topic-read` with `metadataOnly: true`: SQLite removes the authored body before
JavaScript materialization, and responses omit `body`. Normal topic reads and
stored Markdown are unchanged. Metadata-only reads cannot include a text query.
The MCP initialization capability `working-memory/topic-metadata` (version 1)
advertises support; older backends retain full-read compatibility until upgraded.
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
startup, and readiness failures without removing unrelated containers.
`WORKING_MEMORY_DOCKER_CONTEXT` (or `DOCKER_CONTEXT`) overrides the CLI's active
context; an unavailable or remote target never falls back to another context. Configure local source paths
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
For lookup-and-update requests, the assistant uses case numbers or titles from
the current topic to find matching Working Memory topics, verifies the matches,
and saves links without replacing unrelated content. Literal topic queries work
with Search disabled; enabling Search also exposes indexed and structured
document discovery. Successful writes invalidate cached reads so a verification
read sees the newly saved content.
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
The command takes an offline-maintenance marker beside the selected data
directory, and the current control-plane daemon refuses to open that directory
until the command exits. If the command is interrupted and leaves the marker,
verify no maintenance process is still running before removing
`run/offline-maintenance.lock`. A surviving `run/control-plane.lock` also makes
the command refuse to open the database; verify the backend is stopped before
removing a stale lock. Keep the backend stopped when using an older build or a
database path outside the backend's normal data directory; this coordination
is not a general lock for arbitrary external SQLite clients.
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
and keeps them as workflow-run artifacts. **Git tags are the release-version
authority**, not package manifests or mutable PR labels:

- A `vX.Y.Z` tag builds exactly `X.Y.Z` and publishes a Stable release.
- A `vX.Y.Z-rc.N` tag builds that exact prerelease with a Canary-classified
  manifest. Tagged prereleases require a manual download: automatic Canary
  updates consider only the rolling `canary` release and latest Stable release,
  not separately tagged release candidates.
- Untagged PR, main and manual builds use the highest Stable `vX.Y.Z` tag
  reachable from the checked-out commit, increment its patch, then append
  `-build.<workflow run number>`. After `v1.7.0`, these are `1.7.1-build.N`.
  This is a development identifier, not a promise that the next release is a
  patch: tag `v1.8.0` or `v2.0.0` when releasing minor or major changes.
- Full history and tags are required. Missing release history, invalid tags
  and tags older than the reachable Stable version fail the build; there is
  no fallback to a stale source-package version or manual version override.
- The pipeline uses one resolved version for Electron metadata, backend image
  tags and health/MCP identity, bundled images, and `update.json`. The offline
  backend smoke test checks the reported version as well as health.
- Published version tags and release assets must not be moved or replaced.
  Correct a published release with a new version. Only the rolling `canary`
  tag/assets are mutable. A source change to package versions is not needed.

Installer jobs retry packaging up to three times for upstream HTTP 502/503/504
download failures, retaining the job's download cache. Other failures stop
immediately; persistent download failures still fail the check.

Pushes to `main` also push the
backend image to GHCR and replace the rolling `canary` prerelease (installers
plus `update.json`). Push a `v<version>` tag (for example `v1.7.0`) to build
that version and publish a GitHub Release; plain `vX.Y.Z` tags are full
releases that the Stable channel follows, and suffixed versions such as
`v1.0.0-rc.1` are prereleases. The app's footer shows the packaged version. Build
installers locally with `npm run package:mac --prefix desktop-ui` or
`npm run package:win --prefix desktop-ui` (output: `desktop-ui/release/`).
Local development builds do not publish releases; their source-package metadata
is not the release-version authority.
Local builds use the highest reachable Stable tag's next patch followed by
`-dev.g<Git commit>` (and `.dirty` for uncommitted changes). One resolved version
is used for the desktop metadata, bundled image tag, and backend health/MCP
identity. For example, local work after `v1.7.0` reports `1.7.1-dev.g<commit>`,
not the historical source-package version. `npm run build` and local installer
packaging require release tags and never rewrite source-package versions.

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

Identity checks run every 30 seconds. A timeout or connection failure keeps an
already-open workspace and its drafts visible, shows a **Reconnecting** notice
with request details, **Retry connection**, and **Diagnostics**, and retries
automatically. Failed checks never grant a new authenticated session; the backend
continues enforcing authorization on every request. Explicit authentication
rejection still returns to sign-in. A failed initial connection also retries
automatically and loads the workspace only after identity is confirmed.
If startup finds no responding instance, automatic retries rediscover and initialize
the intended target using the normal persisted-selection preference. Recovery restores
that environment's saved composer draft before loading its workspace, then opens any
queued deep link only if the environment and authentication are still current.

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
      "args": ["--mcp-stdio", "http://127.0.0.1:7717/mcp"],
      "env": {
        "ELECTRON_RUN_AS_NODE": ""
      }
    }
  }
}
```

Use the installed desktop executable on the current OS. The connector runs
headlessly, independently of the desktop's single-instance window lock. It
must override `ELECTRON_RUN_AS_NODE` with an empty string because VS Code can
otherwise launch Electron in Node mode, which rejects `--mcp-stdio` before
the connector starts. It
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
After a backend restart or session expiry, the native connector reinitializes
with its still-valid approved credential. Concurrent calls share recovery.
It retries a call once only after an explicit pre-dispatch stale-session
rejection; it never replays a write after an unknown transport failure.
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

Events survive backend restarts and are retained for **10 days** by default,
with configurable day-based retention and paginated history, not a row-count
cap. Repeated rejection events from the same client are aggregated per minute.
If cleanup and its audit insert both fail, both failures are reported in the
backend logs without leaving an unhandled cleanup rejection.
The view refreshes every 15 seconds while the Sessions tab is open and shows
the time since the last successful refresh. Polling stops when the tab closes.
Loaded older events remain visible alongside the latest events. Older backends must be
upgraded before this tab is available.

Trusted owner clients use `GET /identity/v1/sessions` (optional `before` event
cursor) and `POST /identity/v1/sessions` with the complete policy:
`idleMinutes`, `maxPerClient`, `maxTotal`, `handshakesPerMinute`, `retentionDays`.
Unknown/expired MCP sessions return HTTP 404. The desktop reconnects and retries
once when the server explicitly rejects a stale session before dispatch, including
desktop actions, generic tool calls, and document writes. Writes are never replayed
after a network failure or any other error with an uncertain execution outcome.
Short-lived MCP consumers should send session DELETE
(`transport.terminateSession()`) before `client.close()` to reclaim resources
immediately instead of waiting for idle cleanup.
The desktop client and native connector do this on reset and shutdown, with a
two-second DELETE timeout and observable cleanup failures. Shutdown cancels
active requests without cancelling the separate session-termination request.

#### Instance monitoring and automatic incident reports (1.4.1)

**Settings -> Diagnostics** shows owner-only HTTP transactions per minute,
caller categories (owner, approved client ID, unauthenticated), normalized
routes, status codes, request durations, V8 heap/RSS, event-loop delay and
active request/session counts. `GET /identity/v1/diagnostics` is restricted to
trusted owner requests; older backends show an explicit upgrade message.
Health and MCP advertise the package release version. Health also returns a
process boot ID so a restart is distinguishable from an unavailable endpoint.

Automatic incident reports capture recent container error categories, safe stack
locations, and CPU/memory/PID/block-I/O statistics for desktop-managed instances,
both at detection and after an outage recovers. Container commands are bounded,
and failures or unsupported evidence are reported explicitly. Arbitrary log
messages, document bodies, credentials, and request payloads are not included.
Reports retain the last successful runtime sample and add recovery-time diagnostics
and persisted tool lifecycle history (including events from before a container
restart). Lifecycle summaries describe the retained event window, not a complete
request count. Evidence is capped at 20,000 characters with explicit truncation.
These changes improve future reports; they cannot reconstruct logs already lost
when an affected container was recreated.

Diagnostics has **Queue**, **HTTP**, **Runtime**, **Automatic incident reports**, and **Embeddings**
subtabs. HTTP shows transactions, errors,
average duration and maximum duration as time series, independently scaled to
0-100% of each series' visible-window peak. Raw peaks remain in the legend and
original values in point tooltips; gaps in sampling break the traces. The error
log sits below the graph, with the current caller/route/status breakdown in an
expandable non-tabular summary. Automatic incident reports has its own subtab,
including reports queued while the backend is unavailable.
Diagnostics navigation uses pink, keyboard-accessible secondary tabs under the
main Settings tabs. Except for Embeddings' explicit Refresh control, there are no manual refresh buttons: only the selected,
visible diagnostics view polls. Polling stops while the window is hidden and
resumes immediately when visible again; inactive subtabs do not background poll.
A shared Refresh selector defaults to 15 seconds and offers 2, 5, 15, 30 and 60
seconds; changing it applies to the selected diagnostics view without overlapping requests.
On Queue, Refresh and Bucket size align on one row at the top right above the
first graph. **Queue Settings** is a collapsed section at the top, replacing
the old MCP tool queue heading and endpoint text. Drafts survive collapsing
and polling, and save errors remain visible even when the section is collapsed.
The owner can save persistent, per-container **Queue Settings**: Max Concurrency
(1-64, default 4), Max Queue Size (1-1000, default 16), Queue Timeout
(0.1-300 seconds, default 5), and Heap Dispatch Pause Threshold
(10-90%, default 60%). Saved settings take effect without restarting the backend.
Running calls finish; existing waiters retain FIFO order and their original
deadlines. Lowering queue capacity rejects new arrivals until capacity returns.
Changing the timeout affects new arrivals only. New-session admission retains
its separate 60% heap cutoff; raising dispatch limits does not change that policy.
Settings are owner-only, validate the backend boot identity and previous settings,
and reject stale saves rather than overwriting newer configuration.
Queue shows only the selected environment: a **Queue Processing**
chart with aggregation of 10-second samples (latest 30 minutes), a stacked **Tool requests over
time** chart, and collapsed **Top 50 by wait time**, **Top 50 by runtime**, and
**Queue log** sections. Rankings and the log use retained lifecycle history
(up to 2,000 events, at most 24 hours), with one row per request and live items
included. Unavailable timings are excluded from rankings.
**Drops**, immediately below Queue Processing, sums queue timeouts, capacity
rejections and shutdown drops using the same bucket size and time bounds. Counts
come from cumulative telemetry, not the truncated queue log. A final sample
preserves graceful-shutdown drops across backend restarts. Client cancellations,
connection closures, authorization denials and failed executions are excluded.
Abrupt crashes or forced termination may interrupt requests without recording
a shutdown drop. Older samples without drop counters cannot be backfilled.
Each log row shows queue-entry time, total duration, request ID, tool, wait time,
runtime and status; live timings are elapsed so far. Finished timings remain
available even if earlier lifecycle events have left the window. An unfinished
request no longer in the live list has an unavailable outcome, not a fabricated
completion time. Hover a request ID for its caller. Queue Processing shows
**Max queue depth**, **Max wait time**, and average processing rate. Depth is
captured on enqueue, before dispatch, so even short-lived waiting calls are
retained between samples. Maximum wait includes elapsed time for currently
waiting calls and waits ending in dispatch or a drop, not execution runtime.
Polling does not clear these peaks; they reset only after a runtime sample is
persisted. Older samples cannot be backfilled with missing waits or depth peaks.
Each processing series is independently scaled to its visible-window peak,
without percentage labels; legend and hover show real values. A shared **Bucket
size** selector defaults to one minute and offers 15/30 seconds and 1/2/5/10
minutes for all Queue plots. Buckets retain maximum depth and wait time while
averaging sampled processing rates. Processing-rate samples use a rolling
ten-second rate.
The stacked chart shares the processing chart's exact time bounds and horizontal
plot alignment. Its raw counts come from per-tool cumulative arrival counters
sampled with runtime telemetry, not the truncated lifecycle log. Every call is
counted once, including rejected work, irrespective of how many lifecycle events
it produces. Sampled count deltas are summed into bars by interval end,
with exact bucket-boundary endings assigned to the preceding bucket. Deltas are
never proportionally split or estimated; hover shows counts and actual observed
interval boundaries, including partial minutes or longer sampling gaps. Older backends or
samples without counters are explicitly unavailable, not zero; counters are never
differenced across backend restarts. Two line overlays show total wait for
finished requests and call-weighted average runtime for completed/failed
executions in each bucket. Rejected requests contribute their wait, not a
zero runtime that would dilute the average. Per-tool cumulative timing counters
are sampled alongside arrival counters, independent of lifecycle-log truncation.
Filtering a tool also filters both timing aggregates. Lines are independently
normalized on a hidden secondary axis; hover shows real milliseconds. No
executed calls means an unavailable runtime average, not zero. Older samples
without timing counters are not backfilled.
All Queue, HTTP and Runtime charts use modular Apache ECharts with an SVG
renderer. HTTP and Runtime retain one-minute buckets (HTTP is already aggregated by minute). Runtime
averages memory, CPU and queue gauges, preserves maximum event-loop delay, and
sums GC counts and duration. Click a legend entry to isolate it; click it again or **Show all** to
restore the other series. Selection survives telemetry refreshes.
The rolling one-minute wait/processing averages are weighted by calls finishing
in that minute, including failed executions but excluding work rejected or cancelled
before execution. Tool-level errors (`isError: true`) are failed executions, not
successful completions. Calls denied by the post-wait authorization check remain
not executed, preserve HTTP 401/403, and do not enter processing aggregates.
No finished calls means no average, rather than a fabricated zero.
These metrics use independent per-second count/timing aggregates (at most 61 rows),
not the truncated lifecycle log, so bursts beyond the log limit are still counted.
Windows have one-second resolution; older history without processing metrics leaves gaps.
Desktop drag-context preparation follows actual panel/environment changes, not
unrelated health or feature refreshes; a status refresh must not re-read every
draggable document. The separately deployed Feedback container may also issue a
small document read for its backend-aware health check.

MCP tool calls, including those on already-connected sessions, use a bounded FIFO
queue: four running, at most sixteen waiting, and a five-second maximum wait.
Dispatch pauses at the existing 60% V8 heap cutoff. Already-started calls may
finish; full or expired queues return HTTP 503 with `executed: false`, never run
later, and are not automatically replayed. Disconnects and MCP
`notifications/cancelled` cancel waiting calls; protocol cancellation matches the
session and exact JSON-RPC request ID, even when the request's HTTP connection stays open.
Session cleanup, protocol traffic, health and owner diagnostics bypass the tool
queue. Authorization is checked again after waiting. This is overload protection,
not a guarantee against a single operation exhausting memory or blocking the
event loop. It does not force GC, restart processes, or interrupt running writes.

Queue lifecycle logging retains at most 2,000 content-free events for 24 hours.
Periodic state sampling and event reads expire old events even while the instance is idle.
`GET /identity/v1/tool-queue` is owner-only and returns queue metadata, history and
events. Clicking a waiting request uses owner-only
`GET /identity/v1/tool-queue/<request-id>` to inspect the exact JSON request body
that will be dispatched, **in memory only**. This explicitly separate live
inspector does not include HTTP authorization headers, does not persist payloads,
uses `Cache-Control: no-store`, and becomes unavailable when dispatch starts or
the request leaves the queue. The desktop clears inspected data on queue exit,
environment changes, errors, or closing the Queue tab.

Runtime history records heap/limit/RSS, external/array-buffer memory, process CPU,
observed GC count/duration, event-loop delay, queue depth, and up to eight active
operation identities/timings every ten seconds. CPU 100% means one logical core.
Samples are persisted for at most 24 hours / 8,640 rows and survive restarts;
Runtime shows the latest ten minutes as independently peak-normalized traces for
heap, RSS, external memory, CPU, event-loop delay, GC count/duration and waiting/running
tools, with raw peaks in the legend and original values in point tooltips. Missing
samples and backend restarts break the traces rather than implying continuity.
Automatic incident evidence includes recent
runtime samples and current queue activity. Sampling cannot run during a blocked
event loop, so external health and Docker evidence remain necessary.

Every HTTP response has a server-generated `X-Request-Id`. HTTP errors and
ordinary requests taking at least three seconds are persisted, along with admission
rejections, sampled heap pressure at the 60% admission threshold, event-loop
delays of at least one second, and unclean backend restarts. Repeated events
are grouped by route/status/minute, retaining the latest request ID and maximum
duration. Telemetry is retained for seven days, capped at 10,000 minute/caller
buckets and 1,000 events; the view shows the latest hour and 100 events.
Successful `GET /changes` long polls normally wait up to 25 seconds; they are
flagged as slow only at 28 seconds or longer. Successful MCP notification-stream
GETs are not flagged for their connection lifetime. Both still count as HTTP
transactions with their actual elapsed durations, so aggregate durations include
intentional waiting and are not a measure of processing or handshake latency.
Errors, including HTTP 499 client cancellations, remain visible; historical
events are not rewritten or deleted by this change. Incident evidence includes
each event's normalized route to distinguish long polls from ordinary work.
HTTP 401 can be normal OAuth negotiation;
the log does not interpret it as an authentication defect.
Caller identity is captured when a request arrives, so logout or credential
expiry before completion does not relabel an authenticated transaction.

Upgrade the frontend and backend together for 1.4.1: the new garbage-collection
event values are not accepted by older desktop session-response validators.

While the desktop runs, it checks **only the selected environment**, with a
five-second health deadline and ten seconds between monitoring attempts.
Three consecutive failures generate an outage report, not a claim of a crash.
Changed boot IDs confirm process restarts. For managed instances, Docker state,
image identity, OOM/exit information and the last five health-check timings
are included without health-check output or container environment variables.
The desktop also reports heap admission pressure and event-loop stalls, with
deduplication/cooldowns. App-initiated upgrades are excluded from monitoring.

Reports are atomically queued in the desktop user profile and survive desktop
and backend restarts. Once the same selected backend is reachable and signed
in, queued reports become Topics in a workstream named **Inbox**, creating that
workstream if absent. A uniquely named **Bug** topic type is used when available,
otherwise the normal Topic default applies. Duplicate or closed Inbox
workstreams produce a visible delivery error; monitoring never reopens or
closes a workstream/topic. An incident label prevents duplicate topics after an
ambiguous write outcome. Completed local report history is capped at 100;
undelivered reports are retained. Review in Inbox and use **Send feedback**
manually when ready; reports are never transmitted automatically.
Automatic delivery uses owner-only `POST /identity/v1/incidents`, with a
server-side incident-label/ID lookup rather than loading Topic bodies or
opening an MCP session. Delivery has a ten-second deadline and runs separately
from health probes and confirmed manual heap-report creation. In-flight probes
from before an intentional upgrade are discarded even after monitoring resumes.

Kind-scoped, unfiltered `wm-document-read` pages apply their limit and offset in
SQLite before parsing documents. A health check requesting one Topic therefore
does not allocate the entire Topic catalog.

Persisted diagnostics exclude credentials, protocol session IDs, document contents,
request bodies, arbitrary paths/query strings, and raw logs. This supplies
evidence for investigating memory/reconnect stalls; it does not claim to fix
or establish the allocation source in the reported 7719 incident. No heap
profiles are captured automatically because they can contain private content.

#### Heap analysis and confirmed recovery (1.4.1)

**Settings -> Sessions** colorizes heap pressure: green below 50%, amber at
50%, and high/blocked at the existing 60% admission cutoff. Labels provide the
same information without relying on color. A stacked allocation-category chart
shows V8 old/young objects, large objects, compiled code and trusted storage.
These categories are not per-client ownership measurements. RSS and external
allocations are reported separately; array buffers are a subset of external
memory, not an additional total.

**Save bug report and collect garbage** opens a trusted native confirmation
dialog. Cancel is the default. After approval, a sanitized report is queued
locally and saved in the selected instance's Inbox before any collection is
requested. Report creation uses an owner-only HTTP endpoint and requires no new
MCP session, so the heap admission cutoff does not prevent saving the report.
Then the backend reclaims only already-idle sessions, waits for their cleanup,
and requests asynchronous major V8 garbage collection. Active requests and
live sessions are preserved; no container restart occurs. The result reports
before/after heap bytes, elapsed time and reclaimed idle sessions, with a
persistent Sessions audit event and a link to the saved report.

Garbage collection is never automatic. The bundled Docker entry point enables
`--expose-gc`; other launchers must explicitly opt in to expose manual
collection. The desktop disables recovery when unsupported. Owner HTTP
requests use `POST /identity/v1/sessions/report` followed by
`POST /identity/v1/sessions/gc`, with explicit confirmation and the observed
server start time. Collection also requires the saved incident Topic ID,
rejects untrusted browser requests and approved-client credentials, and is
rate-limited to one attempt per minute. Report failures or a changed instance
prevent collection. Collection failures retain the report and are shown as
failures, never as successful recovery.

MCP tool validation schemas are shared across servers, while tool handlers and
authorization remain session-local. This reduces the retained cost of
abandoned-but-not-yet-idle MCP sessions rather than relying on GC to release
live objects. CommandJournal schemas live in an independent schema module to
avoid circular initialization when registrations reuse them.

The control plane and desktop use the MCP SDK v2 split packages (2.4.0,
with the Node HTTP adapter at 2.1.2). The Node adapter preserves the existing
Streamable HTTP endpoints and JSON responses; completed responses are released
without closing their session. The existing PKCE authorization-server flow
temporarily uses the frozen `@modelcontextprotocol/server-legacy/auth` helpers
to preserve approval and credential behavior, including RFC 9207 issuer
parameters. This compatibility dependency is not the MCP transport.

For reproducible local analysis with **synthetic in-memory data only**:

```bash
npm run compile
npm run test:mcp-heap -- /absolute/path/to/diagnostic-output
```

The harness first exercises 100 responses larger than 1 MiB in one open
session, without forced GC between reads. It measures retained heap before
terminating that session, with a 16 MiB incremental budget. It also exercises
1,000 clean reconnects with tool discovery and ping,
100 client-close-without-DELETE sessions followed by idle expiry, and 100
unauthenticated OAuth challenges. It captures post-GC heap/RSS samples and
local `.heapprofile` allocation sampling, including a checkpoint while
abandoned sessions are still retained. Budgets are at most 1 MiB incremental
retained heap per abandoned session, at most 20% heap growth over warmed-up
clean reconnects, and local connection/discovery/ping p95 below one second.
These budgets detect the reproduced duplicated-schema retention; they do
not establish the cause of every production timeout. Raw profiles are never
attached to Inbox reports or feedback automatically.

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
