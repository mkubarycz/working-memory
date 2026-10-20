# working-memory

**Working Memory is a desktop context-storage and workflow engine that treats
agentic workflows as a first-class citizen.** It gives AI agents (and you) a
durable, structured place to record what's happening, why decisions were made,
and what's left to do — so context survives across chats instead of
evaporating when a chat ends.

It does two things at once:

- **Context storage** — a portable SQLite database of durable **workstreams**,
  **topics**, topic types, alerts, and related control-plane documents.
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
- **Move to a new workstream:** right-click a topic in the Active rail, then
  **Move to... > New Workstream...**. Its saved title and body are used to suggest
  an editable workstream name. **Move** creates the In Progress workstream and
  moves the existing topic tree into it without changing topic statuses or other
  workstream memberships. Cancel makes no changes; a failed move can be retried
  without creating another workstream. The Active topic menu omits the redundant
  **Add to workstream** action; **Remove from workstream** remains available.
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

Local builds automatically use the reusable
`Working Memory Local Code Signing` identity when it is installed in the macOS
login Keychain. Certificate-backed signing is required for Keychain
**Always Allow** decisions to survive application rebuilds; ad-hoc signatures
cannot provide persistent Keychain trust. Other machines can set
`WM_DESKTOP_CODESIGN_IDENTITY` to an installed certificate identity.
When no identity is available, builds fall back to ad-hoc signing for CI and
environments that do not access macOS Keychain credentials.

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
authentication; Working Memory does not copy GitHub tokens into its model
configuration. Copilot requires an eligible account and employer permission
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

## Document stage

New document tabs open on the left. Selecting a tab reveals it in the navigation
strip, including after resizing the stage or closing neighboring tabs. Empty
new-topic forms use the same available document width as populated topics;
typing does not change the form's width.

## Desktop container apps

The desktop **Container Apps** right-rail tab lists live ContainerClaims with a
Docker `runtime` in the selected environment. Claims are the persisted app
catalog, not a compiled-in allowlist: adding an app requires no Working Memory
source changes, rebuild, or installation. Selecting an app registered with
`desktop.embeddable: true` opens its UI
as a full-stage document tab. The tab health light and gear menu expose launch,
reload, external-open, stop, refresh, and App Info actions. Non-embeddable apps
open directly to App Info.

On local macOS builds, the desktop installer signals the running installed
copy to relaunch after the newly signed bundle is in place. Set
`WM_DESKTOP_SKIP_REFRESH=1` only when a build must update the application
without refreshing it.

Register an app with `ws-containerclaim-create` (or a generic `ContainerClaim`
document), providing a unique `slug`, `title`, `repository`, and complete
Docker `runtime` (`buildContext`, `dockerfile`, image/container names, ports,
health/entry paths, and optional named volumes). Add `mcp` and `application`
metadata for chat tools and live contracts. Optional `desktop` metadata accepts
a codicon `icon` name and `embeddable` boolean; new apps default to a generic
icon and App Info rather than embedding. There are no app-name-specific
presentation defaults: icons and embedding preferences belong in each claim's
`desktop` configuration, including for previously bundled app registrations.

For example, Sunset Chess 1.4 can be registered with slug `sunset-chess-1-4`,
its dedicated source worktree, image `sunset-chess:1.4`, container
`working-memory-sunset-chess-1-4`, host port 4176/container port 4175, and
named volume `working-memory-sunset-chess-1-4-data` mounted at `/data`.
It can advertise application identity `sunset-chess` independently of its
registration slug. Neither the original app nor its volume needs to change.

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

Each action is routed by claim slug through one generic orchestration path.
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
show the latest human prompt, tool activity, and Working Memory response.
Collapsing it with the header chevron replaces the detailed exchange with at
most two abbreviated recent commands for the same document or Container App.
The full run remains available through Chat history.

Chat requests and write confirmations are scoped to their originating
conversation. You can switch to another topic and submit a query while the
first is still running; a background completion does not select its document.
The Log is a live chronological timeline, with a timestamped command dot and
nested tool activity, confirmation, and response for each query.

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
alerts, history, and lifecycle status are not. The receiver creates an open
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
- `<id>` is the resource slug or id

| Kind | Markdown shape | Example |
|---|---|---|
| Topic | `[label](http://127.0.0.1:7718/open/topic/<slug>)` | `[chat-clickable-links](http://127.0.0.1:7718/open/topic/chat-clickable-links)` |
| Workstream | `[label](http://127.0.0.1:7718/open/workstream/<slug>)` | `[topic-types](http://127.0.0.1:7718/open/workstream/topic-types)` |
| Alert | `[label](http://127.0.0.1:7718/open/alert/<id>)` | `[release blocker](http://127.0.0.1:7718/open/alert/1234)` |

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

## Approved host tasks (experimental; execution blocked)

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
- ContainerClaim slugs, labels, source IPs, MCP session IDs, and editable
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
The existing general document API is not retrofitted with authentication by
this feature; broker grants and result bytes never live in that API. Keep its
existing network exposure restricted separately.

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
